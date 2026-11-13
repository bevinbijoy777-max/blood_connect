/**
 * Checks the business rules against in-memory repositories: eligibility,
 * matching, response handling, ownership and validation.
 *
 * Run: node scripts/test-service.mjs
 */

import { donorToJson } from "../src/service.js";
import { eligibility } from "../src/validate.js";
import { checker, daysAgo, makeService } from "./fakes.mjs";

const { check, finish } = checker();

const seeker = { sub: "seeker-1", name: "Asha Rao", email: "asha@example.com" };
const donor = { sub: "donor-1", name: "Ravi Kumar", email: "ravi@example.com" };
const resting = { sub: "donor-2", name: "Meena Shah", email: "meena@example.com" };
const paused = { sub: "donor-3", name: "Sam Rao", email: "sam@example.com" };

const requestFor = (overrides = {}) => ({
  patientName: "Asha Rao",
  bloodGroup: "O+",
  units: 2,
  hospital: "Ruby Hall",
  city: "Pune",
  contact: "9876543210",
  urgency: "Urgent",
  ...overrides,
});

async function seed(service) {
  await service.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await service.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(120),
  });
  await service.saveProfile(resting, {
    role: "donor",
    phone: "9812345670",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(10),
  });
  await service.saveProfile(paused, {
    role: "donor",
    phone: "9812345671",
    city: "Mumbai",
    bloodGroup: "O+",
    lastDonation: null,
    acceptingRequests: false,
  });
}

async function run() {
  const service = makeService();

  console.log("eligibility");
  check("donated 120 days ago is eligible", eligibility(daysAgo(120)).eligible);
  check("donated 10 days ago is not eligible", !eligibility(daysAgo(10)).eligible);
  check("never donated is eligible", eligibility(null).eligible);
  check("next eligible is 90 days later", eligibility(daysAgo(30)).nextEligible === daysAgo(-60));

  await seed(service);

  console.log("matching");
  const { request, notified } = await service.submitRequest("seeker-1", requestFor());
  check("request is created open", request.status === "Open");
  check("only the available, eligible donor is notified", notified === 1, `got ${notified}`);

  const inbox = await service.inbox("donor-1");
  check("donor inbox has one pending request", inbox.pending === 1);
  check("inbox carries the request details", inbox.notifications[0]?.request?.hospital === "Ruby Hall");
  check("resting donor got nothing", (await service.inbox("donor-2")).notifications.length === 0);
  check("paused donor got nothing", (await service.inbox("donor-3")).notifications.length === 0);

  console.log("search privacy");
  const donors = await service.searchDonors({ bloodGroup: "O+" });
  check("search finds the O+ donors", donors.length === 3, `got ${donors.length}`);
  check("search results never include a phone number", donors.every((d) => !("phone" in d)));
  check("search results never include a donation date", donors.every((d) => !("lastDonation" in d)));
  check("unavailable donors sort last", donors.at(-1).canReceiveRequests === false);
  const single = donorToJson(await service.profiles.get("donor-1"));
  check("donorToJson hides phone", !("phone" in single));
  check("donorToJson hides donation date", !("lastDonation" in single));

  console.log("accepting a request");
  const notificationId = inbox.notifications[0].id;
  const accepted = await service.respond("donor-1", notificationId, true);
  check("respond reports acceptance", accepted.accepted === true);
  check("request becomes 'Donor found'", (await service.requests.get(request.id)).status === "Donor found");

  const mine = await service.myRequests("seeker-1");
  const response = mine[0].responses[0];
  check("seeker sees the donor response", Boolean(response));
  check("seeker gets the donor phone number", response?.donor?.phone === "9812345678");
  check("message names the donor", response?.message.includes("Ravi Kumar"));

  let secondAnswerFailed = false;
  try {
    await service.respond("donor-1", notificationId, true);
  } catch (error) {
    secondAnswerFailed = /already responded/i.test(error.message);
  }
  check("a request cannot be answered twice", secondAnswerFailed);

  console.log("declining a request");
  const other = makeService();
  await other.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await other.saveProfile(donor, { role: "donor", phone: "9812345678", city: "Pune", bloodGroup: "O+" });
  const second = await other.submitRequest("seeker-1", requestFor({ units: 1 }));
  const declineId = (await other.inbox("donor-1")).notifications[0].id;
  await other.respond("donor-1", declineId, false);
  check("declining leaves the request open", (await other.requests.get(second.request.id)).status === "Open");
  check("decline sends the seeker no response", (await other.myRequests("seeker-1"))[0].responses.length === 0);

  console.log("ownership and closing");
  let foreignEditBlocked = false;
  try {
    await service.changeStatus("donor-1", request.id, "cancel");
  } catch (error) {
    foreignEditBlocked = error.status === 404;
  }
  check("another user cannot close your request", foreignEditBlocked);

  await service.changeStatus("seeker-1", request.id, "fulfil");
  check("seeker can mark it fulfilled", (await service.requests.get(request.id)).status === "Fulfilled");
  let closedBlocked = false;
  try {
    await service.changeStatus("seeker-1", request.id, "cancel");
  } catch (error) {
    closedBlocked = /already closed/i.test(error.message);
  }
  check("a closed request cannot be cancelled", closedBlocked);

  console.log("validation");
  const cases = [
    ["units above 10 rejected", { units: 11 }, /1 to 10 units/],
    ["unknown blood group rejected", { bloodGroup: "X+" }, /valid blood group/],
    ["short phone rejected", { contact: "123" }, /7 to 15 digits/],
  ];
  for (const [label, override, pattern] of cases) {
    let blocked = false;
    try {
      await service.submitRequest("seeker-1", requestFor(override));
    } catch (error) {
      blocked = pattern.test(error.message);
    }
    check(label, blocked);
  }
  let futureDateBlocked = false;
  try {
    await service.updateDonorProfile("donor-1", { lastDonation: "2999-01-01" });
  } catch (error) {
    futureDateBlocked = /future/.test(error.message);
  }
  check("future donation date rejected", futureDateBlocked);

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
