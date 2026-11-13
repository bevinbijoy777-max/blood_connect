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

/** A real service backed by in-memory repositories. */
export function makeService() {
  const service = new BloodConnectService(null);
  service.profiles = new FakeProfiles();
  service.requests = new FakeRequests();
  service.notifications = new FakeNotifications(service.profiles);
  return service;
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
