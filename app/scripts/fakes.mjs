/**
 * In-memory repositories that stand in for D1, so the service rules and the
 * API routes can be tested without a Worker, a database or a network.
 */

import { BloodConnectService } from "../src/service.js";

export class FakeProfiles {
  constructor() {
    this.rows = new Map();
  }
  async get(sub) {
    return this.rows.get(sub) ?? null;
  }
  async save(profile) {
    this.rows.set(profile.sub, { ...profile });
    return this.get(profile.sub);
  }
  async listDonors({ bloodGroup, city } = {}) {
    return [...this.rows.values()].filter(
      (row) =>
        row.role === "donor" &&
        (!bloodGroup || row.blood_group === bloodGroup) &&
        (!city || row.city.toLowerCase().includes(city.toLowerCase())),
    );
  }
}

export class FakeRequests {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }
  async create(request) {
    const id = this.nextId++;
    this.rows.set(id, { ...request, id });
    return this.get(id);
  }
  async get(id) {
    return this.rows.get(id) ?? null;
  }
  async listForRequester(sub) {
    return [...this.rows.values()].filter((row) => row.requester_sub === sub).reverse();
  }
  async countCreatedOn(sub, isoDate) {
    return [...this.rows.values()].filter((row) => row.requester_sub === sub && row.created_at === isoDate)
      .length;
  }
  async setStatus(id, status) {
    const row = this.rows.get(id);
    if (row) row.status = status;
  }
}

export class FakeNotifications {
  constructor(profiles) {
    this.profiles = profiles;
    this.rows = new Map();
    this.nextId = 1;
  }
  async create(notification) {
    const id = this.nextId++;
    this.rows.set(id, { ...notification, id, response: notification.response ?? "Pending" });
    return this.get(id);
  }
  async get(id) {
    return this.rows.get(id) ?? null;
  }
  async listForRecipient(sub, kind) {
    return [...this.rows.values()]
      .filter((row) => row.recipient_sub === sub && (!kind || row.kind === kind))
      .reverse();
  }
  /** Mirrors the JOIN in NotificationRepo.listResponsesForRequest. */
  async listResponsesForRequest(requestId) {
    const rows = [...this.rows.values()]
      .filter((row) => row.request_id === requestId && row.kind === "response")
      .reverse();
    return Promise.all(
      rows.map(async (row) => {
        const actor = row.actor_sub ? await this.profiles.get(row.actor_sub) : null;
        return {
          id: row.id,
          request_id: row.request_id,
          kind: row.kind,
          message: row.message,
          response: row.response,
          created_at: row.created_at,
          actor_name: actor?.name ?? null,
          actor_group: actor?.blood_group ?? null,
          actor_city: actor?.city ?? null,
          actor_phone: actor?.phone ?? null,
        };
      }),
    );
  }
  async setResponse(id, response) {
    const row = this.rows.get(id);
    if (row) row.response = response;
  }
}

export class FakePush {
  constructor() {
    this.rows = new Map();
  }
  async save(sub, subscription) {
    this.rows.set(subscription.endpoint, { ...subscription, sub });
    return this.get(subscription.endpoint);
  }
  async get(endpoint) {
    return this.rows.get(endpoint) ?? null;
  }
  async listForSubs(subs) {
    return [...this.rows.values()].filter((row) => subs.includes(row.sub));
  }
  async remove(sub, endpoint) {
    const row = this.rows.get(endpoint);
    if (row && row.sub === sub) this.rows.delete(endpoint);
  }
  async removeByEndpoint(endpoint) {
    this.rows.delete(endpoint);
  }
}

export class FakeReports {
  constructor() {
    this.rows = new Map();
  }
  async save(report) {
    const key = `${report.request_id}:${report.reporter_sub}`;
    this.rows.set(key, { ...report });
    return this.rows.get(key);
  }
  async listForRequester(requesterSub) {
    return [...this.rows.values()].filter((row) => row.requester_sub === requesterSub);
  }
}

export class FakeBlocks {
  constructor(profiles) {
    this.profiles = profiles;
    this.rows = new Map();
  }
  async block(donorSub, blockedSub, createdAt) {
    this.rows.set(`${donorSub}:${blockedSub}`, {
      donor_sub: donorSub,
      blocked_sub: blockedSub,
      created_at: createdAt,
    });
  }
  async unblock(donorSub, blockedSub) {
    this.rows.delete(`${donorSub}:${blockedSub}`);
  }
  async blockedSubs(donorSub) {
    return [...this.rows.values()]
      .filter((row) => row.donor_sub === donorSub)
      .map((row) => row.blocked_sub);
  }
  async donorSubsBlocking(blockedSub) {
    return [...this.rows.values()]
      .filter((row) => row.blocked_sub === blockedSub)
      .map((row) => row.donor_sub);
  }
  /** Mirrors the JOIN in BlockRepo.listForDonor. */
  async listForDonor(donorSub) {
    const rows = [...this.rows.values()].filter((row) => row.donor_sub === donorSub);
    return Promise.all(
      rows.map(async (row) => {
        const profile = await this.profiles.get(row.blocked_sub);
        return {
          blocked_sub: row.blocked_sub,
          created_at: row.created_at,
          name: profile?.name ?? null,
          city: profile?.city ?? null,
        };
      }),
    );
  }
}

/** A real service backed by in-memory repositories. */
export function makeService({ maxRequestsPerDay } = {}) {
  const service = new BloodConnectService(null);
  service.profiles = new FakeProfiles();
  service.requests = new FakeRequests();
  service.notifications = new FakeNotifications(service.profiles);
  service.push = new FakePush();
  service.reports = new FakeReports();
  service.blocks = new FakeBlocks(service.profiles);
  if (maxRequestsPerDay) service.maxRequestsPerDay = maxRequestsPerDay;
  return service;
}

/**
 * Pretend every request was created `days` ago, so expiry and the daily cap
 * can be exercised without waiting.
 */
export function backdateRequests(service, days) {
  for (const row of service.requests.rows.values()) row.created_at = daysAgo(days);
}

/** ISO date `days` in the past (negative values are in the future). */
export function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Tiny assertion helper shared by the test scripts. */
export function checker() {
  let failures = 0;
  return {
    check(label, condition, detail = "") {
      if (condition) {
        console.log(`  ok   ${label}`);
      } else {
        failures += 1;
        console.log(`  FAIL ${label} ${detail}`);
      }
    },
    finish() {
      console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}
