/**
 * Checks the ported business rules against in-memory repositories, so the
 * matching and response logic can be verified without a Worker or D1.
 *
 * Run: node scripts/test-service.mjs
 */

import { BloodConnectService, donorToJson } from "../src/service.js";
import { eligibility } from "../src/validate.js";

// --------------------------------------------------------------- fake repos
class FakeProfiles {
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

class FakeRequests {
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

class FakeNotifications {
  constructor() {
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
  async listForRequest(requestId, kind) {
    return [...this.rows.values()]
      .filter((row) => row.request_id === requestId && (!kind || row.kind === kind))
      .reverse();
  }
  async setResponse(id, response) {
    const row = this.rows.get(id);
    if (row) row.response = response;
  }
  async countPending(sub) {
    return [...this.rows.values()].filter(
      (row) => row.recipient_sub === sub && row.kind === "request" && row.response === "Pending",
    ).length;
  }
}

function service() {
  const svc = new BloodConnectService(null);
  svc.profiles = new FakeProfiles();
  svc.requests = new FakeRequests();
  svc.notifications = new FakeNotifications();
  return svc;
}

const daysAgo = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function run() {
  const svc = service();

  const seeker = { sub: "seeker-1", name: "Asha Rao", email: "asha@example.com" };
  const donor = { sub: "donor-1", name: "Ravi Kumar", email: "ravi@example.com" };
  const resting = { sub: "donor-2", name: "Meena Shah", email: "meena@example.com" };
  const paused = { sub: "donor-3", name: "Sam Rao", email: "sam@example.com" };

  await svc.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await svc.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(120),
  });
  await svc.saveProfile(resting, {
    role: "donor",
    phone: "9812345670",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(10),
  });
  await svc.saveProfile(paused, {
    role: "donor",
    phone: "9812345671",
    city: "Mumbai",
    bloodGroup: "O+",
    lastDonation: null,
    acceptingRequests: false,
  });

  console.log("eligibility");
  check("donated 120 days ago is eligible", eligibility(daysAgo(120)).eligible);
  check("donated 10 days ago is not eligible", !eligibility(daysAgo(10)).eligible);
  check("never donated is eligible", eligibility(null).eligible);
  check("next eligible is 90 days later", eligibility(daysAgo(30)).nextEligible === daysAgo(-60));

  console.log("matching");
  const { request, notified } = await svc.submitRequest("seeker-1", {
    patientName: "Asha Rao",
    bloodGroup: "O+",
    units: 2,
    hospital: "Ruby Hall",
    city: "Pune",
    contact: "9876543210",
    urgency: "Urgent",
  });
  check("request is created open", request.status === "Open");
  check("only the available, eligible donor is notified", notified === 1, `got ${notified}`);

  const inbox = await svc.inbox("donor-1");
  check("donor inbox has one pending request", inbox.pending === 1);
  check("inbox carries the request details", inbox.notifications[0]?.request?.hospital === "Ruby Hall");
  check("resting donor got nothing", (await svc.inbox("donor-2")).notifications.length === 0);
  check("paused donor got nothing", (await svc.inbox("donor-3")).notifications.length === 0);

  console.log("search privacy");
  const donors = await svc.searchDonors({ bloodGroup: "O+" });
  check("search finds the O+ donors", donors.length === 3, `got ${donors.length}`);
  check("search results never include a phone number", donors.every((d) => !("phone" in d)));
  check("unavailable donors sort last", donors.at(-1).canReceiveRequests === false);
  check("search results never include a donation date", donors.every((d) => !("lastDonation" in d)));
  check(
    "search results still show who can donate now",
    donors.some((d) => d.canReceiveRequests) && donors.some((d) => !d.canReceiveRequests),
  );
  const single = donorToJson(await svc.profiles.get("donor-1"));
  check("donorToJson hides phone", !("phone" in single));
  check("donorToJson hides donation date", !("lastDonation" in single));

  console.log("accepting a request");
  const notificationId = inbox.notifications[0].id;
  const accepted = await svc.respond("donor-1", notificationId, true);
  check("respond reports acceptance", accepted.accepted === true);
  const stored = await svc.requests.get(request.id);
  check("request becomes 'Donor found'", stored.status === "Donor found", stored.status);

  const mine = await svc.myRequests("seeker-1");
  const response = mine[0].responses[0];
  check("seeker sees the donor response", Boolean(response));
  check("seeker gets the donor phone number", response?.donor?.phone === "9812345678");
  check("message names the donor", response?.message.includes("Ravi Kumar"));

  let secondAnswerFailed = false;
  try {
    await svc.respond("donor-1", notificationId, true);
  } catch (error) {
    secondAnswerFailed = /already responded/i.test(error.message);
  }
  check("a request cannot be answered twice", secondAnswerFailed);

  console.log("declining a request");
  const svc2 = service();
  await svc2.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await svc2.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
  });
  const second = await svc2.submitRequest("seeker-1", {
    patientName: "Asha Rao",
    bloodGroup: "O+",
    units: 1,
    hospital: "Ruby Hall",
    city: "Pune",
    contact: "9876543210",
  });
  const declineId = (await svc2.inbox("donor-1")).notifications[0].id;
  await svc2.respond("donor-1", declineId, false);
  check("declining leaves the request open", (await svc2.requests.get(second.request.id)).status === "Open");
  check("no response notification is sent on decline", (await svc2.notifications.listForRequest(second.request.id, "response")).length === 0);

  console.log("ownership and closing");
  let foreignEditBlocked = false;
  try {
    await svc.changeStatus("donor-1", request.id, "cancel");
  } catch (error) {
    foreignEditBlocked = error.status === 404;
  }
  check("another user cannot close your request", foreignEditBlocked);

  await svc.changeStatus("seeker-1", request.id, "fulfil");
  check("seeker can mark it fulfilled", (await svc.requests.get(request.id)).status === "Fulfilled");
  let closedBlocked = false;
  try {
    await svc.changeStatus("seeker-1", request.id, "cancel");
  } catch (error) {
    closedBlocked = /already closed/i.test(error.message);
  }
  check("a closed request cannot be cancelled", closedBlocked);

  console.log("validation");
  const cases = [
    ["units above 10 rejected", { units: 11 }, /1 to 10 units/],
    ["unknown blood group rejected", { bloodGroup: "X+" }, /valid blood group/],
    ["short phone rejected", { contact: "123" }, /7 to 15 digits/],
    ["future donation date rejected", { lastDonation: "2999-01-01" }, /future/],
  ];
  for (const [label, override, pattern] of cases) {
    let blocked = false;
    try {
      if ("lastDonation" in override) {
        await svc.updateDonorProfile("donor-1", override);
      } else {
        await svc.submitRequest("seeker-1", {
          patientName: "Test",
          bloodGroup: "A+",
          units: 1,
          hospital: "X",
          city: "Pune",
          contact: "9876543210",
          ...override,
        });
      }
    } catch (error) {
      blocked = pattern.test(error.message);
    }
    check(label, blocked);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
