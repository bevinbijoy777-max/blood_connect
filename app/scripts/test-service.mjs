/**
 * Checks the business rules against in-memory repositories: eligibility,
 * matching, response handling, ownership and validation.
 *
 * Run: node scripts/test-service.mjs
 */

import { BloodConnectService, donorToJson } from "../src/service.js";
import { eligibility, expiresOn, isExpired, todayIso } from "../src/validate.js";
import { backdateRequests, checker, daysAgo, makeService } from "./fakes.mjs";

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
  // The daily cap gets its own section below; these checks are about matching.
  const service = makeService({ maxRequestsPerDay: 50 });

  console.log("eligibility");
  check("donated 120 days ago is eligible", eligibility(daysAgo(120)).eligible);
  check("donated 10 days ago is not eligible", !eligibility(daysAgo(10)).eligible);
  check("never donated is eligible", eligibility(null).eligible);
  check("next eligible is 90 days later", eligibility(daysAgo(30)).nextEligible === daysAgo(-60));

  // The desktop app's utc_today() has to agree with this, whatever the clock.
  const today = todayIso();
  const utcDay = (offset) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  console.log("days are counted in UTC");
  check("today is the UTC date", today === new Date().toISOString().slice(0, 10), today);
  check("a request closes three days after creation", expiresOn(today) === utcDay(3), expiresOn(today));
  check("it is still open on the third day", !isExpired(today, utcDay(2)));
  check("it has expired on the fourth day", isExpired(today, utcDay(3)));

  await seed(service);

  console.log("matching");
  const { request, notified } = await service.submitRequest("seeker-1", requestFor());
  check("request is created open", request.status === "Open");
  check("only the available, eligible donor is notified", notified === 1, `got ${notified}`);

  const inbox = await service.inbox("donor-1");
  check("donor inbox has one pending request", inbox.pending === 1);
  check("inbox carries the request details", inbox.notifications[0]?.request?.hospital === "Ruby Hall");
  check("inbox names the requester with their contact number",
    inbox.notifications[0]?.request?.requesterName === "Asha Rao" &&
      inbox.notifications[0]?.request?.contact === "9876543210");
  check("resting donor got nothing", (await service.inbox("donor-2")).notifications.length === 0);
  check("paused donor got nothing", (await service.inbox("donor-3")).notifications.length === 0);

  console.log("donor search");
  const donors = await service.searchDonors({ bloodGroup: "O+" });
  check("search finds the O+ donors", donors.length === 3, `got ${donors.length}`);
  check("search results include the donor phone number", donors.every((d) => Boolean(d.phone)));
  check("search results never include a donation date", donors.every((d) => !("lastDonation" in d)));
  check("unavailable donors sort last", donors.at(-1).canReceiveRequests === false);
  const single = donorToJson(await service.profiles.get("donor-1"));
  check("donorToJson shares the phone number", single.phone === "9812345678");
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

  console.log("request expiry");
  const ageing = makeService();
  await ageing.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await ageing.saveProfile(donor, { role: "donor", phone: "9812345678", city: "Pune", bloodGroup: "O+" });
  const ageingRequest = await ageing.submitRequest("seeker-1", requestFor());

  backdateRequests(ageing, 2);
  const dayTwo = (await ageing.myRequests("seeker-1"))[0];
  check("a two day old request is still open", dayTwo.isActive === true);
  check("it says which day it closes", dayTwo.expiresOn === daysAgo(-1), dayTwo.expiresOn);

  backdateRequests(ageing, 3);
  const dayThree = (await ageing.myRequests("seeker-1"))[0];
  check("a three day old request shows as Expired", dayThree.status === "Expired", dayThree.status);
  check("an expired request is not active", dayThree.isActive === false);

  const expiredInbox = await ageing.inbox("donor-1");
  check("the donor sees it as expired", expiredInbox.notifications[0]?.request?.status === "Expired");
  check("an expired request is not counted as waiting", expiredInbox.pending === 0, String(expiredInbox.pending));

  let expiredAccept = false;
  try {
    await ageing.respond("donor-1", expiredInbox.notifications[0].id, true);
  } catch (error) {
    expiredAccept = /expired/i.test(error.message);
  }
  check("accepting an expired request is refused", expiredAccept);

  let expiredClose = false;
  try {
    await ageing.changeStatus("seeker-1", ageingRequest.request.id, "cancel");
  } catch (error) {
    expiredClose = /expired/i.test(error.message);
  }
  check("closing an expired request is refused", expiredClose);

  console.log("daily request cap");
  check("the cap is three requests a day", new BloodConnectService(null).maxRequestsPerDay === 3);
  const capped = makeService();
  await capped.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  for (let index = 0; index < 3; index += 1) {
    await capped.submitRequest("seeker-1", requestFor({ units: 1 }));
  }
  check("three requests in a day are allowed", (await capped.myRequests("seeker-1")).length === 3);

  let cappedError = null;
  try {
    await capped.submitRequest("seeker-1", requestFor({ units: 1 }));
  } catch (error) {
    cappedError = error;
  }
  check("the fourth request in a day is refused", cappedError?.status === 429, String(cappedError?.status));
  check("the refusal explains the cap", /3 requests a day/.test(cappedError?.message ?? ""), cappedError?.message);

  backdateRequests(capped, 1);
  const nextDay = await capped.submitRequest("seeker-1", requestFor({ units: 1 }));
  check("a new day brings a new allowance", Boolean(nextDay.request.id));

  console.log("reporting and blocking");
  const guarding = makeService({ maxRequestsPerDay: 50 });
  const neighbour = { sub: "donor-9", name: "Neha Patil", email: "neha@example.com" };
  await guarding.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await guarding.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
  });
  await guarding.saveProfile(neighbour, {
    role: "donor",
    phone: "9812345699",
    city: "Pune",
    bloodGroup: "O+",
  });

  const spam = await guarding.submitRequest("seeker-1", requestFor({ units: 1 }));
  const guardInbox = await guarding.inbox("donor-1");
  check("the matching donor is notified first", guardInbox.notifications.length === 1);
  check("the neighbour got it too", (await guarding.inbox(neighbour.sub)).notifications.length === 1);

  const reported = await guarding.reportRequest("donor-1", spam.request.id, "Looks fake");
  check("a donor can report a request", reported.reported === true && reported.reason === "Looks fake");
  await guarding.reportRequest("donor-1", spam.request.id, "Spam");
  check("reporting twice keeps one record", guarding.reports.rows.size === 1, String(guarding.reports.rows.size));
  check("the newest reason wins", [...guarding.reports.rows.values()][0].reason === "Spam");

  let badReason = null;
  try {
    await guarding.reportRequest("donor-1", spam.request.id, "I just do not like it");
  } catch (error) {
    badReason = error;
  }
  check("an unknown reason is refused", badReason?.status === 400, String(badReason?.status));

  let seekerReport = null;
  try {
    await guarding.reportRequest("seeker-1", spam.request.id, "Spam");
  } catch (error) {
    seekerReport = error;
  }
  check("a blood seeker cannot report requests", seekerReport?.status === 403, String(seekerReport?.status));

  let strangerReport = null;
  try {
    await guarding.reportRequest(neighbour.sub, 9999, "Spam");
  } catch (error) {
    strangerReport = error;
  }
  check("a request you were never sent cannot be reported", strangerReport?.status === 404, String(strangerReport?.status));

  let strangerBlock = null;
  try {
    await guarding.blockRequest(neighbour.sub, 9999);
  } catch (error) {
    strangerBlock = error;
  }
  check("a request you were never sent cannot be blocked", strangerBlock?.status === 404, String(strangerBlock?.status));

  const blocked = await guarding.blockRequest("donor-1", spam.request.id);
  check("a donor can block the account behind a request", blocked.blocked === true);
  check("the blocked request leaves the inbox", (await guarding.inbox("donor-1")).notifications.length === 0);
  const blockList = await guarding.blockedAccounts("donor-1");
  check("the block list names the account", blockList[0]?.name === "Asha Rao", JSON.stringify(blockList));

  const afterBlock = await guarding.submitRequest("seeker-1", requestFor({ units: 2 }));
  check("the blocked donor is not notified again", (await guarding.inbox("donor-1")).notifications.length === 0);
  check("nobody is pushed to on their behalf", !afterBlock.recipients.some((entry) => entry.sub === "donor-1"));
  check("other donors still hear about the request", (await guarding.inbox(neighbour.sub)).notifications.length === 2);

  const seekerSearch = await guarding.searchDonors({ bloodGroup: "O+", viewerSub: "seeker-1" });
  check(
    "a donor who blocked you is hidden from your search",
    !seekerSearch.some((entry) => entry.name === "Ravi Kumar"),
    JSON.stringify(seekerSearch.map((entry) => entry.name)),
  );
  check("other donors still appear in that search", seekerSearch.some((entry) => entry.name === "Neha Patil"));
  const anonymousSearch = await guarding.searchDonors({ bloodGroup: "O+" });
  check("search without a viewer is unchanged", anonymousSearch.some((entry) => entry.name === "Ravi Kumar"));

  await guarding.unblockAccount("donor-1", "seeker-1");
  check("unblocking empties the block list", (await guarding.blockedAccounts("donor-1")).length === 0);
  check(
    "unblocking brings their requests back",
    (await guarding.inbox("donor-1")).notifications.length === 1,
    JSON.stringify((await guarding.inbox("donor-1")).notifications.length),
  );
  check(
    "unblocking brings the donor back to search",
    (await guarding.searchDonors({ bloodGroup: "O+", viewerSub: "seeker-1" })).some(
      (entry) => entry.name === "Ravi Kumar",
    ),
  );

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
