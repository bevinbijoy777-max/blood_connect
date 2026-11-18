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

  console.log("notification devices");
  const endpoint = "https://push.example.test/send/donor-1";
  const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };

  await service.savePushSubscription("donor-1", { endpoint, keys });
  check("a saved device belongs to its donor", (await service.pushSubscriptionsFor(["donor-1"]))[0]?.endpoint === endpoint);
  check("another donor's devices are not returned", (await service.pushSubscriptionsFor(["donor-2"])).length === 0);

  let seekerDevice = true;
  try {
    await service.savePushSubscription("seeker-1", {
      endpoint: "https://push.example.test/send/seeker-1",
      keys,
    });
  } catch {
    seekerDevice = false;
  }
  check("a blood seeker can register a device too", seekerDevice);

  let noProfile = false;
  try {
    await service.savePushSubscription("ghost", { endpoint, keys });
  } catch (error) {
    noProfile = error.status === 409;
  }
  check("a device needs a profile first", noProfile);

  for (const [label, bad, pattern] of [
    ["an http endpoint", { endpoint: "http://push.example.test/x", keys }, /https/i],
    ["a missing endpoint", { keys }, /endpoint/i],
    ["missing keys", { endpoint }, /keys/i],
    ["a short public key", { endpoint, keys: { p256dh: "AAAA", auth: keys.auth } }, /P-256/],
    ["a short auth secret", { endpoint, keys: { p256dh: keys.p256dh, auth: "AAAA" } }, /16 bytes/],
  ]) {
    let blocked = false;
    try {
      await service.savePushSubscription("donor-1", bad);
    } catch (error) {
      blocked = pattern.test(error.message);
    }
    check(`${label} is rejected`, blocked);
  }

  // One device, two accounts: the row follows whoever signed in last.
  await service.savePushSubscription("donor-2", { endpoint, keys });
  check("an endpoint belongs to the newest account", (await service.pushSubscriptionsFor(["donor-2"]))[0]?.sub === "donor-2");

  await service.removePushSubscription("donor-1", endpoint);
  check("another account cannot remove the device", (await service.pushSubscriptionsFor(["donor-2"])).length === 1);

  await service.removePushSubscription("donor-2", endpoint);
  check("the owner can turn the device off", (await service.pushSubscriptionsFor(["donor-2"])).length === 0);

  await service.savePushSubscription("donor-1", { endpoint, keys });
  await service.forgetPushEndpoint(endpoint);
  check("a dead endpoint is forgotten", (await service.pushSubscriptionsFor(["donor-1"])).length === 0);

  console.log("hearing back from a donor");
  const fresh = await service.submitRequest("seeker-1", requestFor({ units: 1 }));
  const acceptId = (await service.inbox("donor-1")).notifications.find((entry) => entry.isPending).id;
  const acceptedNow = await service.respond("donor-1", acceptId, true);
  check("accepting names the seeker to notify", acceptedNow.notify?.sub === "seeker-1", JSON.stringify(acceptedNow.notify));
  check("the seeker push names the donor", acceptedNow.notify?.donorName === "Ravi Kumar");
  check("the seeker push carries the request", acceptedNow.notify?.requestId === fresh.request.id);

  await service.submitRequest("seeker-1", requestFor({ units: 1 }));
  const refusedId = (await service.inbox("donor-1")).notifications.find((entry) => entry.isPending).id;
  const declinedNow = await service.respond("donor-1", refusedId, false);
  check("declining asks for no push", declinedNow.notify === undefined);

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
