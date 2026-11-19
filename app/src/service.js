/**
 * The use cases of Blood Connect, ported from the desktop app's service layer:
 * register, request, match, notify, respond, search, profile.
 *
 * Identity comes from the signed-in user's `sub`; nothing here trusts a user
 * id supplied by the client.
 */

import {
  BlockRepo,
  NotificationRepo,
  ProfileRepo,
  PushRepo,
  ReportRepo,
  RequestRepo,
  SearchQuotaRepo,
} from "./db.js";
import {
  ApiError,
  cleanText,
  eligibility,
  expiresOn,
  isExpired,
  MAX_DONOR_RESULTS,
  MAX_DONOR_SEARCHES_PER_DAY,
  MAX_REQUESTS_PER_DAY,
  normaliseBloodGroup,
  normalisePhone,
  normaliseRole,
  normaliseReportReason,
  normaliseUnits,
  normaliseUrgency,
  parseDate,
  parseOptionalDate,
  parsePushSubscription,
  todayIso,
} from "./validate.js";

const ACTIVE_STATUSES = ["Open", "Donor found"];

function availabilityText(row, eligible, nextEligible) {
  if (row.role !== "donor") return "Not a donor";
  if (!row.accepting_requests) return "Not accepting requests";
  return eligible ? "Available to donate" : `Eligible again from ${nextEligible}`;
}

export function profileToJson(row) {
  if (!row) return null;
  const { eligible, nextEligible } = eligibility(row.last_donation);
  const available = Boolean(row.accepting_requests);
  return {
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    role: row.role,
    bloodGroup: row.blood_group,
    lastDonation: row.last_donation,
    acceptingRequests: available,
    eligible,
    nextEligible,
    canReceiveRequests: row.role === "donor" && available && eligible,
    availability: availabilityText(row, eligible, nextEligible),
  };
}

/**
 * A donor shown in search results. The name and contact number are shown so a
 * seeker can call directly; the donation date stays private.
 */
export function donorToJson(row) {
  const profile = profileToJson(row);
  return {
    name: profile.name,
    phone: profile.phone,
    city: profile.city,
    bloodGroup: profile.bloodGroup,
    availability: profile.availability,
    canReceiveRequests: profile.canReceiveRequests,
  };
}

export function requestToJson(row, extra = {}) {
  // Expiry is decided at read time, so a request closes itself without a job.
  const closed = !ACTIVE_STATUSES.includes(row.status);
  const expired = !closed && isExpired(row.created_at);
  return {
    id: row.id,
    patientName: row.patient_name,
    bloodGroup: row.blood_group,
    units: row.units,
    hospital: row.hospital,
    city: row.city,
    contact: row.contact,
    urgency: row.urgency,
    note: row.note,
    status: expired ? "Expired" : row.status,
    createdAt: row.created_at,
    expiresOn: expiresOn(row.created_at),
    isActive: !closed && !expired,
    ...extra,
  };
}

export function notificationToJson(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    kind: row.kind,
    message: row.message,
    response: row.response,
    createdAt: row.created_at,
    isPending: row.response === "Pending",
  };
}

export class BloodConnectService {
  constructor(db) {
    this.profiles = new ProfileRepo(db);
    this.requests = new RequestRepo(db);
    this.notifications = new NotificationRepo(db);
    this.push = new PushRepo(db);
    this.reports = new ReportRepo(db);
    this.blocks = new BlockRepo(db);
    this.searchQuota = new SearchQuotaRepo(db);
    // Overridable so tests can focus on other rules.
    this.maxRequestsPerDay = MAX_REQUESTS_PER_DAY;
    this.maxSearchesPerDay = MAX_DONOR_SEARCHES_PER_DAY;
    this.maxResultsPerSearch = MAX_DONOR_RESULTS;
  }

  // -- profile ------------------------------------------------------------ //
  async getProfile(sub) {
    return this.profiles.get(sub);
  }

  async saveProfile(user, input) {
    const existing = await this.profiles.get(user.sub);
    const role = normaliseRole(input.role ?? existing?.role);
    const profile = {
      sub: user.sub,
      name: cleanText(user.name || existing?.name || "Blood Connect user", "Name", 80),
      email: user.email ?? existing?.email ?? null,
      phone: normalisePhone(input.phone),
      city: cleanText(input.city, "City", 60),
      role,
      blood_group:
        role === "donor"
          ? normaliseBloodGroup(input.bloodGroup ?? existing?.blood_group)
          : null,
      last_donation:
        role === "donor"
          ? parseOptionalDate(input.lastDonation ?? existing?.last_donation, "Last donation date")
          : null,
      accepting_requests:
        input.acceptingRequests === undefined
          ? (existing?.accepting_requests ?? 1)
          : input.acceptingRequests
            ? 1
            : 0,
      created_at: existing?.created_at ?? todayIso(),
    };
    return this.profiles.save(profile);
  }

  async updateDonorProfile(sub, input) {
    const existing = await this.profiles.get(sub);
    if (!existing) throw new ApiError("Create your profile first.", 409);
    if (existing.role !== "donor") throw new ApiError("Only registered donors can do that.", 403);

    const accepting =
      input.acceptingRequests === undefined
        ? existing.accepting_requests
        : input.acceptingRequests
          ? 1
          : 0;
    const lastDonation =
      input.lastDonation === undefined
        ? existing.last_donation
        : parseOptionalDate(input.lastDonation, "Donation date");

    await this.profiles.save({ ...existing, accepting_requests: accepting, last_donation: lastDonation });
    return this.profiles.get(sub);
  }

  // -- requests ----------------------------------------------------------- //
  async submitRequest(sub, input) {
    const profile = await this.profiles.get(sub);
    if (!profile) throw new ApiError("Create your profile before requesting blood.", 409);

    const today = todayIso();
    const usedToday = await this.requests.countCreatedOn(sub, today);
    if (usedToday >= this.maxRequestsPerDay) {
      throw new ApiError(
        `You can send ${this.maxRequestsPerDay} requests a day. Please try again tomorrow.`,
        429,
      );
    }

    const request = {
      requester_sub: sub,
      patient_name: cleanText(input.patientName, "Patient name", 80),
      blood_group: normaliseBloodGroup(input.bloodGroup),
      units: normaliseUnits(input.units),
      hospital: cleanText(input.hospital, "Hospital", 100),
      city: cleanText(input.city, "City", 60),
      contact: normalisePhone(input.contact),
      urgency: normaliseUrgency(input.urgency),
      note: String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      status: "Open",
      created_at: today,
    };
    const saved = await this.requests.create(request);
    const { notified, recipients } = await this.notifyMatchingDonors(saved, sub);
    return { request: saved, notified, recipients };
  }

  async notifyMatchingDonors(request, requesterSub) {
    const base =
      `${request.urgency} request: ${request.units} unit(s) of ${request.blood_group} ` +
      `needed for ${request.patient_name} at ${request.hospital}, ${request.city}.`;
    const message = request.note ? `${base} Note: ${request.note}` : base;

    const donors = await this.profiles.listDonors({ bloodGroup: request.blood_group });
    // A donor who blocked this account hears nothing from it again.
    const blocked = new Set(await this.blocks.donorSubsBlocking(requesterSub));
    let notified = 0;
    const recipients = [];
    for (const donor of donors) {
      if (donor.sub === requesterSub || blocked.has(donor.sub)) continue;
      const { eligible } = eligibility(donor.last_donation);
      if (!donor.accepting_requests || !eligible) continue;
      await this.notifications.create({
        recipient_sub: donor.sub,
        actor_sub: requesterSub,
        request_id: request.id,
        kind: "request",
        message,
        response: "Pending",
        created_at: todayIso(),
      });
      notified += 1;
      // The caller uses this to push a real notification to their devices.
      recipients.push({ sub: donor.sub, name: donor.name });
    }
    return { notified, recipients };
  }

  async myRequests(sub) {
    const rows = await this.requests.listForRequester(sub);
    const result = [];
    for (const row of rows) {
      const responses = await this.notifications.listResponsesForRequest(row.id);
      result.push(
        requestToJson(row, {
          responses: responses.map((response) => ({
            ...notificationToJson(response),
            // The seeker only learns a donor's number once that donor accepts.
            donor: response.actor_name
              ? {
                  name: response.actor_name,
                  bloodGroup: response.actor_group,
                  city: response.actor_city,
                  phone: response.actor_phone,
                }
              : null,
          })),
        }),
      );
    }
    return result;
  }

  async ownedRequest(sub, requestId) {
    const request = await this.requests.get(requestId);
    if (!request || request.requester_sub !== sub) {
      throw new ApiError("That request does not belong to your account.", 404);
    }
    return request;
  }

  async changeStatus(sub, requestId, action) {
    const request = await this.ownedRequest(sub, requestId);
    if (!ACTIVE_STATUSES.includes(request.status)) {
      throw new ApiError("This request is already closed.");
    }
    if (isExpired(request.created_at)) {
      throw new ApiError("This request has expired.");
    }
    const status = action === "fulfil" ? "Fulfilled" : action === "cancel" ? "Cancelled" : null;
    if (!status) throw new ApiError("Unknown action for this request.");
    await this.requests.setStatus(request.id, status);
    return this.requests.get(request.id);
  }

  // -- push subscriptions -------------------------------------------------- //

  /**
   * Remember one device of the signed-in user, replacing its older keys.
   * Donors are told about matching requests, seekers when a donor accepts, so
   * either role can register a device.
   */
  async savePushSubscription(sub, input) {
    const profile = await this.profiles.get(sub);
    if (!profile) throw new ApiError("Create your profile first.", 409);
    const subscription = parsePushSubscription(input);
    return this.push.save(sub, { ...subscription, created_at: todayIso() });
  }

  async removePushSubscription(sub, endpoint) {
    const target = String(endpoint ?? "").trim();
    if (!target) throw new ApiError("A push subscription needs an endpoint.");
    await this.push.remove(sub, target);
  }

  /** Every device of the given users; the caller encrypts once per device. */
  async pushSubscriptionsFor(subs) {
    return this.push.listForSubs(subs);
  }

  async forgetPushEndpoint(endpoint) {
    await this.push.removeByEndpoint(endpoint);
  }

  // -- donors and inbox --------------------------------------------------- //
  async searchDonors({ bloodGroup, city, viewerSub }) {
    const group = bloodGroup ? normaliseBloodGroup(bloodGroup) : null;
    // Search results carry contact numbers, so each account gets a daily
    // allowance; a refused search still counts, so retrying changes nothing.
    if (viewerSub) {
      const used = await this.searchQuota.hit(viewerSub, todayIso());
      if (used > this.maxSearchesPerDay) {
        throw new ApiError(
          `You can search donors ${this.maxSearchesPerDay} times a day. Please try again tomorrow.`,
          429,
        );
      }
    }
    const rows = await this.profiles.listDonors({
      bloodGroup: group,
      city: city ? String(city).trim() : null,
    });
    // A donor who blocked this account is hidden from its search too.
    const hidden = new Set(viewerSub ? await this.blocks.donorSubsBlocking(viewerSub) : []);
    const matching = rows
      .filter((row) => !hidden.has(row.sub))
      .map(donorToJson)
      .sort((a, b) => Number(b.canReceiveRequests) - Number(a.canReceiveRequests) || a.name.localeCompare(b.name));
    // One search must not hand out a whole city of numbers; the most useful
    // (available, eligible) donors come first, and the caller is told how many
    // were held back so the client can say so instead of pretending that is all.
    const donors = matching.slice(0, this.maxResultsPerSearch);
    return {
      donors,
      total: matching.length,
      remaining: matching.length - donors.length,
    };
  }

  async inbox(sub) {
    const profile = await this.profiles.get(sub);
    if (!profile) return { notifications: [], pending: 0 };
    const rows = await this.notifications.listForRecipient(sub, "request");
    const blocked = new Set(await this.blocks.blockedSubs(sub));
    const notifications = [];
    for (const row of rows) {
      const request = await this.requests.get(row.request_id);
      // Blocked accounts disappear from the inbox, including older requests.
      if (!request || blocked.has(request.requester_sub)) continue;
      const requester = await this.profiles.get(request.requester_sub);
      notifications.push({
        ...notificationToJson(row),
        request: requestToJson(request, { requesterName: requester?.name ?? null }),
      });
    }
    // A donor who can no longer answer is not counted as waiting.
    return {
      notifications,
      pending: notifications.filter((n) => n.isPending && n.request.isActive).length,
    };
  }

  async respond(sub, notificationId, accepted) {
    const profile = await this.profiles.get(sub);
    if (!profile || profile.role !== "donor") {
      throw new ApiError("Only registered donors can do that.", 403);
    }
    const notification = await this.notifications.get(notificationId);
    if (!notification || notification.recipient_sub !== sub) {
      throw new ApiError("That request notification is not available.", 404);
    }
    if (notification.kind !== "request") {
      throw new ApiError("Only blood request notifications can be answered.");
    }
    if (notification.response !== "Pending") {
      throw new ApiError("You have already responded to this request.");
    }
    const request = await this.requests.get(notification.request_id);
    if (!request) throw new ApiError("The blood request is no longer available.", 404);
    if (accepted && !ACTIVE_STATUSES.includes(request.status)) {
      throw new ApiError("This request has already been closed.");
    }
    if (accepted && isExpired(request.created_at)) {
      throw new ApiError("This blood request has expired.");
    }

    await this.notifications.setResponse(notification.id, accepted ? "Accepted" : "Declined");
    if (!accepted) {
      return { accepted: false, message: "You declined this request. Thank you for letting the seeker know." };
    }

    if (request.status === "Open") await this.requests.setStatus(request.id, "Donor found");
    const seeker = await this.profiles.get(request.requester_sub);
    await this.notifications.create({
      recipient_sub: request.requester_sub,
      actor_sub: sub,
      request_id: request.id,
      kind: "response",
      response: "Accepted",
      message:
        `${profile.name} (${profile.blood_group}, ${profile.city}) accepted your request ` +
        `and can be reached on ${profile.phone}.`,
      created_at: todayIso(),
    });
    return {
      accepted: true,
      message:
        `Thank you, ${profile.name.split(" ")[0]}! ` +
        `${seeker ? seeker.name : "The seeker"} has your contact number and will call you.`,
      // The caller pushes this to the seeker's devices. Nothing is returned
      // when a donor declines: there is no good news to deliver.
      notify: {
        sub: request.requester_sub,
        donorName: profile.name,
        bloodGroup: profile.blood_group,
        city: profile.city,
        requestId: request.id,
        patientName: request.patient_name,
      },
    };
  }

  // -- reporting and blocking ---------------------------------------------- //

  /**
   * The request behind one of this donor's inbox entries. Both actions below
   * start here, so a signed-in account cannot use them to probe, or silence,
   * a request it was never sent.
   */
  async requestFromInbox(sub, requestId) {
    const request = await this.requests.get(Number(requestId));
    if (!request) throw new ApiError("That blood request is no longer available.", 404);
    const rows = await this.notifications.listForRecipient(sub, "request");
    if (!rows.some((row) => row.request_id === request.id)) {
      throw new ApiError("That blood request is not in your inbox.", 404);
    }
    return request;
  }

  async reportRequest(sub, requestId, reasonInput) {
    const profile = await this.profiles.get(sub);
    if (!profile || profile.role !== "donor") {
      throw new ApiError("Only registered donors can report a request.", 403);
    }
    const request = await this.requestFromInbox(sub, requestId);
    const reason = normaliseReportReason(reasonInput);
    const saved = await this.reports.save({
      request_id: request.id,
      requester_sub: request.requester_sub,
      reporter_sub: sub,
      reason,
      created_at: todayIso(),
    });
    return { reported: true, reason: saved?.reason ?? reason };
  }

  /**
   * Stop hearing from the account that posted this request. Only this donor's
   * inbox is affected, and the blocked account is not told.
   */
  async blockRequest(sub, requestId) {
    const profile = await this.profiles.get(sub);
    if (!profile || profile.role !== "donor") {
      throw new ApiError("Only registered donors can block a request.", 403);
    }
    const request = await this.requestFromInbox(sub, requestId);
    if (request.requester_sub === sub) throw new ApiError("You cannot block your own account.");
    await this.blocks.block(sub, request.requester_sub, todayIso());
    return { blocked: true };
  }

  async blockedAccounts(sub) {
    const rows = await this.blocks.listForDonor(sub);
    return rows.map((row) => ({
      sub: row.blocked_sub,
      name: row.name ?? "Blocked account",
      city: row.city ?? null,
      blockedAt: row.created_at,
    }));
  }

  async unblockAccount(sub, blockedSub) {
    const target = String(blockedSub ?? "").trim();
    if (!target) throw new ApiError("Choose the account to unblock.");
    await this.blocks.unblock(sub, target);
    return { blocked: false };
  }

  // -- moderation ---------------------------------------------------------- //

  /**
   * Every report a donor has filed, newest first, with the request and both
   * accounts named. Reading only: a moderator decides what to do about it.
   */
  async moderationQueue({ limit = 200 } = {}) {
    const [rows, counts] = await Promise.all([
      this.reports.listRecent(limit),
      this.reports.countsByRequester(),
    ]);
    const against = new Map(counts.map((row) => [row.requester_sub, Number(row.total)]));
    return {
      total: [...against.values()].reduce((sum, value) => sum + value, 0),
      reports: rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        createdAt: row.created_at,
        request: row.request_id
          ? {
              id: row.request_id,
              patientName: row.patient_name,
              bloodGroup: row.blood_group,
              units: row.units,
              hospital: row.hospital,
              city: row.city,
              urgency: row.urgency,
              status: row.status,
              createdAt: row.request_created_at,
            }
          : null,
        requester: {
          sub: row.requester_sub,
          name: row.requester_name ?? null,
          phone: row.requester_phone ?? null,
          city: row.requester_city ?? null,
          reportsAgainst: against.get(row.requester_sub) ?? 1,
        },
        reporter: { sub: row.reporter_sub, name: row.reporter_name ?? null },
      })),
    };
  }
}
