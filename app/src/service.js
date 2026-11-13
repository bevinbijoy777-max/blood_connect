/**
 * The use cases of Blood Connect, ported from the desktop app's service layer:
 * register, request, match, notify, respond, search, profile.
 *
 * Identity comes from the signed-in user's `sub`; nothing here trusts a user
 * id supplied by the client.
 */

import { NotificationRepo, ProfileRepo, RequestRepo } from "./db.js";
import {
  ApiError,
  cleanText,
  eligibility,
  normaliseBloodGroup,
  normalisePhone,
  normaliseRole,
  normaliseUnits,
  normaliseUrgency,
  parseDate,
  parseOptionalDate,
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
 * A donor shown in search results. Nobody else's phone number or donation date
 * is exposed here: the availability label already says whether they can give
 * blood right now, and the number only arrives once they accept a request.
 */
export function donorToJson(row) {
  const profile = profileToJson(row);
  return {
    name: profile.name,
    city: profile.city,
    bloodGroup: profile.bloodGroup,
    availability: profile.availability,
    canReceiveRequests: profile.canReceiveRequests,
  };
}

export function requestToJson(row, extra = {}) {
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
    status: row.status,
    createdAt: row.created_at,
    isActive: ACTIVE_STATUSES.includes(row.status),
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
      created_at: todayIso(),
    };
    const saved = await this.requests.create(request);
    const notified = await this.notifyMatchingDonors(saved, sub);
    return { request: saved, notified };
  }

  async notifyMatchingDonors(request, requesterSub) {
    const base =
      `${request.urgency} request: ${request.units} unit(s) of ${request.blood_group} ` +
      `needed for ${request.patient_name} at ${request.hospital}, ${request.city}.`;
    const message = request.note ? `${base} Note: ${request.note}` : base;

    const donors = await this.profiles.listDonors({ bloodGroup: request.blood_group });
    let notified = 0;
    for (const donor of donors) {
      if (donor.sub === requesterSub) continue;
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
    }
    return notified;
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
    const status = action === "fulfil" ? "Fulfilled" : action === "cancel" ? "Cancelled" : null;
    if (!status) throw new ApiError("Unknown action for this request.");
    await this.requests.setStatus(request.id, status);
    return this.requests.get(request.id);
  }

  // -- donors and inbox --------------------------------------------------- //
  async searchDonors({ bloodGroup, city }) {
    const group = bloodGroup ? normaliseBloodGroup(bloodGroup) : null;
    const rows = await this.profiles.listDonors({
      bloodGroup: group,
      city: city ? String(city).trim() : null,
    });
    return rows
      .map(donorToJson)
      .sort((a, b) => Number(b.canReceiveRequests) - Number(a.canReceiveRequests) || a.name.localeCompare(b.name));
  }

  async inbox(sub) {
    const profile = await this.profiles.get(sub);
    if (!profile) return { notifications: [], pending: 0 };
    const rows = await this.notifications.listForRecipient(sub, "request");
    const notifications = [];
    for (const row of rows) {
      const request = await this.requests.get(row.request_id);
      if (request) notifications.push({ ...notificationToJson(row), request: requestToJson(request) });
    }
    return { notifications, pending: notifications.filter((n) => n.isPending).length };
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
    };
  }
}
