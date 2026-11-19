/**
 * Checks the API route table: signed-out refusals, cross-origin write
 * refusals, validation errors and not-found handling.
 *
 * Runs the real routes against the real service, with in-memory repositories,
 * so no Worker, database or network is involved.
 *
 * Run: node scripts/test-api.mjs
 */

import { errorResponse, routeApi } from "../src/api.js";
import { backdateRequests, daysAgo, makeService } from "./fakes.mjs";
import { checker } from "./fakes.mjs";

const { check, finish } = checker();

const ORIGIN = "https://app.example";
const seeker = { sub: "seeker-1", name: "Asha Rao", email: "asha@example.com" };
const donor = { sub: "donor-1", name: "Ravi Kumar", email: "ravi@example.com" };

const validRequest = {
  patientName: "Asha Rao",
  bloodGroup: "O+",
  units: 2,
  hospital: "Ruby Hall",
  city: "Pune",
  contact: "9876543210",
  urgency: "Urgent",
};

function makeRequest(path, { method = "GET", body, rawBody } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: body || rawBody ? { "Content-Type": "application/json" } : undefined,
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
}

/** Call a route the way the Worker would, mapping thrown ApiErrors like it does. */
async function call(path, options = {}, context = {}) {
  const { user = null, sameOrigin = true, service, ...extra } = context;
  try {
    return await routeApi(makeRequest(path, options), { user, sameOrigin, service, ...extra });
  } catch (error) {
    return errorResponse(error);
  }
}

async function body(response) {
  return response.json().catch(() => null);
}

async function run() {
  // The daily cap is checked on its own service below.
  const service = makeService({ maxRequestsPerDay: 50 });
  await service.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await service.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(120),
  });

  const signedOut = { user: null, service };
  const asSeeker = { user: seeker, service };
  const asDonor = { user: donor, service };

  console.log("signed out");
  let response = await call("/api/me", {}, signedOut);
  check("GET /api/me answers 200 with no user", response.status === 200 && (await body(response)).user === null);

  for (const path of ["/api/requests", "/api/donors", "/api/inbox"]) {
    response = await call(path, {}, signedOut);
    const payload = await body(response);
    check(`GET ${path} is 401`, response.status === 401, `got ${response.status}`);
    check(`GET ${path} says sign in required`, /sign in required/i.test(payload?.error ?? ""));
  }

  response = await call("/api/profile", { method: "POST", body: {} }, signedOut);
  check("POST /api/profile is 401", response.status === 401, `got ${response.status}`);

  response = await call("/api/requests", { method: "POST", body: validRequest }, signedOut);
  check("POST /api/requests is 401", response.status === 401, `got ${response.status}`);

  response = await call("/api/notifications/1", { method: "POST", body: { accept: true } }, signedOut);
  check("POST /api/notifications/:id is 401", response.status === 401, `got ${response.status}`);

  console.log("cross-origin writes");
  response = await call("/api/profile", { method: "POST", body: {} }, { ...asSeeker, sameOrigin: false });
  check("cross-origin POST /api/profile is 403", response.status === 403, `got ${response.status}`);
  check("403 body is empty", (await response.text()) === "");

  response = await call("/api/requests", { method: "POST", body: validRequest }, { ...asSeeker, sameOrigin: false });
  check("cross-origin POST /api/requests is 403", response.status === 403, `got ${response.status}`);

  response = await call("/api/notifications/1", { method: "POST", body: {} }, { ...asDonor, sameOrigin: false });
  check("cross-origin respond is 403", response.status === 403, `got ${response.status}`);

  response = await call("/api/requests", { method: "POST", body: validRequest }, { ...signedOut, sameOrigin: false });
  check("cross-origin write is refused before auth (403 not 401)", response.status === 403, `got ${response.status}`);

  response = await call("/api/requests", {}, { ...asSeeker, sameOrigin: false });
  check("cross-origin GET is allowed", response.status === 200, `got ${response.status}`);

  console.log("validation errors");
  const invalid = [
    ["units above 10", { units: 11 }, /1 to 10 units/],
    ["units below 1", { units: 0 }, /1 to 10 units/],
    ["unknown blood group", { bloodGroup: "X+" }, /valid blood group/],
    ["empty patient name", { patientName: "   " }, /Patient name is required/],
    ["short contact number", { contact: "123" }, /7 to 15 digits/],
    ["unknown urgency", { urgency: "Whenever" }, /urgency/i],
  ];
  for (const [label, override, pattern] of invalid) {
    response = await call(
      "/api/requests",
      { method: "POST", body: { ...validRequest, ...override } },
      asSeeker,
    );
    const payload = await body(response);
    check(`${label} is 400`, response.status === 400, `got ${response.status}`);
    check(`${label} explains why`, pattern.test(payload?.error ?? ""), payload?.error);
  }

  response = await call("/api/profile", { method: "POST", body: { role: "seeker", phone: "9876543210" } }, asSeeker);
  check("missing city is 400", response.status === 400, `got ${response.status}`);

  response = await call("/api/profile", { method: "POST", body: { role: "wizard", phone: "9876543210", city: "Pune" } }, asSeeker);
  check("unknown role is 400", response.status === 400, `got ${response.status}`);

  response = await call("/api/requests", { method: "POST", rawBody: "{not json" }, asSeeker);
  const malformed = await body(response);
  check("malformed JSON is 400", response.status === 400, `got ${response.status}`);
  check("malformed JSON explains it expects JSON", /expected a json body/i.test(malformed?.error ?? ""));

  console.log("routing and ownership");
  response = await call("/api/does-not-exist", {}, asSeeker);
  check("unknown route is 404", response.status === 404, `got ${response.status}`);

  response = await call("/api/requests/999", { method: "POST", body: { action: "cancel" } }, asSeeker);
  check("closing someone else's request is 404", response.status === 404, `got ${response.status}`);

  response = await call("/api/donor-profile", { method: "POST", body: { acceptingRequests: false } }, asSeeker);
  check("a seeker cannot use donor settings (403)", response.status === 403, `got ${response.status}`);

  response = await call("/api/donor-profile", { method: "POST", body: { acceptingRequests: false } }, { user: { sub: "ghost" }, service });
  check("donor settings without a profile is 409", response.status === 409, `got ${response.status}`);

  console.log("happy path through the routes");
  response = await call("/api/requests", { method: "POST", body: validRequest }, asSeeker);
  const created = await body(response);
  check("creating a request is 201", response.status === 201, `got ${response.status}`);
  check("the response reports one donor notified", created?.notified === 1, JSON.stringify(created));

  response = await call("/api/donors?group=O%2B", {}, asSeeker);
  const { donors } = await body(response);
  check("donor search is 200", response.status === 200);
  check("donor search includes phone numbers", donors?.every((entry) => Boolean(entry.phone)));
  check("donor search omits donation dates", donors?.every((entry) => !("lastDonation" in entry)));

  response = await call("/api/inbox", {}, asDonor);
  const inbox = await body(response);
  check("donor inbox lists the request", inbox?.notifications?.length === 1);
  check("donor inbox names the requester with their phone number",
    Boolean(inbox?.notifications?.[0]?.request?.requesterName) &&
      inbox?.notifications?.[0]?.request?.contact === "9876543210");
  const notificationId = inbox.notifications[0].id;

  response = await call("/api/notifications/" + notificationId, { method: "POST", body: { accept: true } }, asDonor);
  const accepted = await body(response);
  check("accepting is 200", response.status === 200, `got ${response.status}`);
  check("accepting reports success", accepted?.accepted === true);

  response = await call("/api/requests", {}, asSeeker);
  const mine = await body(response);
  check("seeker request shows 'Donor found'", mine?.requests?.[0]?.status === "Donor found");
  check("seeker sees the donor phone number", mine?.requests?.[0]?.responses?.[0]?.donor?.phone === "9812345678");

  response = await call("/api/notifications/" + notificationId, { method: "POST", body: { accept: true } }, asDonor);
  check("answering twice is 400", response.status === 400, `got ${response.status}`);

  response = await call("/api/me", {}, asSeeker);
  const me = await body(response);
  check("GET /api/me returns the profile", me?.profile?.role === "seeker");
  check("personalized responses are not cacheable", response.headers.get("Cache-Control") === "private, no-store");

  console.log("notification devices");
  const device = {
    endpoint: "https://push.example.test/send/api-donor",
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
  };
  const publicKey = "B".repeat(87);

  response = await call("/api/push/key", {}, signedOut);
  check("GET /api/push/key is readable without signing in", response.status === 200, `got ${response.status}`);
  check("no configured key is reported as null", (await body(response)).publicKey === null);

  response = await call("/api/push/key", {}, { ...asDonor, pushPublicKey: publicKey });
  check("the configured key is handed to the browser", (await body(response)).publicKey === publicKey);

  response = await call("/api/push/subscribe", { method: "POST", body: device }, signedOut);
  check("POST /api/push/subscribe needs sign-in", response.status === 401, `got ${response.status}`);

  response = await call("/api/push/subscribe", { method: "POST", body: device }, { ...asDonor, sameOrigin: false });
  check("cross-origin subscribe is 403", response.status === 403, `got ${response.status}`);

  response = await call("/api/push/subscribe", { method: "POST", body: device }, asDonor);
  check("a donor registers this device", response.status === 200 && (await body(response)).subscribed === true, `got ${response.status}`);

  response = await call(
    "/api/push/subscribe",
    { method: "POST", body: { ...device, endpoint: "https://push.example.test/send/api-seeker" } },
    asSeeker,
  );
  check("a blood seeker registers a device too", response.status === 200, `got ${response.status}`);

  response = await call("/api/push/subscribe", { method: "POST", body: { endpoint: device.endpoint } }, asDonor);
  check("a subscription without keys is 400", response.status === 400, `got ${response.status}`);

  response = await call("/api/push/unsubscribe", { method: "POST", body: device }, { ...asDonor, sameOrigin: false });
  check("cross-origin unsubscribe is 403", response.status === 403, `got ${response.status}`);

  response = await call("/api/push/unsubscribe", { method: "POST", body: { endpoint: device.endpoint } }, asDonor);
  check("a donor turns the device off", response.status === 200 && (await body(response)).subscribed === false);

  console.log("pushing a new request");
  let pushed = null;
  response = await call(
    "/api/requests",
    { method: "POST", body: { ...validRequest, units: 1 } },
    {
      ...asSeeker,
      notifyDonors: async (recipients, created) => {
        pushed = { recipients, id: created.id, city: created.city };
      },
    },
  );
  check("a new request still returns 201", response.status === 201, `got ${response.status}`);
  check("the notified donor is pushed to", pushed?.recipients?.map((entry) => entry.sub).includes("donor-1") === true);
  check("the push carries the saved request", pushed?.id > 0 && pushed?.city === "Pune");

  response = await call("/api/requests", { method: "POST", body: validRequest }, {
    ...asSeeker,
    notifyDonors: async () => {
      throw new Error("push service down");
    },
  });
  check("a failed push does not fail the request", response.status === 201, `got ${response.status}`);

  console.log("hearing back from a donor");
  let seekerPushed = null;
  response = await call("/api/inbox", {}, asDonor);
  const pendingId = (await body(response)).notifications.find((entry) => entry.isPending)?.id;
  response = await call(
    `/api/notifications/${pendingId}`,
    { method: "POST", body: { accept: true } },
    {
      ...asDonor,
      notifySeeker: async (event) => {
        seekerPushed = event;
      },
    },
  );
  const acceptedBody = await body(response);
  check("accepting is still 200", response.status === 200, `got ${response.status}`);
  check("the seeker is the one pushed to", seekerPushed?.sub === "seeker-1", JSON.stringify(seekerPushed));
  check("the seeker push names the donor", seekerPushed?.donorName === "Ravi Kumar");
  check(
    "the response keeps its shape",
    Object.keys(acceptedBody).sort().join(",") === "accepted,message",
    Object.keys(acceptedBody).join(","),
  );

  response = await call("/api/inbox", {}, asDonor);
  const declineId = (await body(response)).notifications.find((entry) => entry.isPending)?.id;
  let declinedPush = null;
  response = await call(
    `/api/notifications/${declineId}`,
    { method: "POST", body: { accept: false } },
    {
      ...asDonor,
      notifySeeker: async (event) => {
        declinedPush = event;
      },
    },
  );
  check("declining pushes nobody", declinedPush === null);

  await call("/api/requests", { method: "POST", body: { ...validRequest, units: 1 } }, asSeeker);
  response = await call("/api/inbox", {}, asDonor);
  const throwingId = (await body(response)).notifications.find((entry) => entry.isPending)?.id;
  response = await call(
    `/api/notifications/${throwingId}`,
    { method: "POST", body: { accept: true } },
    {
      ...asDonor,
      notifySeeker: async () => {
        throw new Error("push service down");
      },
    },
  );
  check("a failed push does not fail the accept", response.status === 200, `got ${response.status}`);

  console.log("request hygiene");
  const hygiene = makeService({ maxRequestsPerDay: 50 });
  await hygiene.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await hygiene.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
    lastDonation: daysAgo(120),
  });
  const oldSeeker = { user: seeker, service: hygiene };
  const oldDonor = { user: donor, service: hygiene };

  response = await call("/api/requests", { method: "POST", body: validRequest }, oldSeeker);
  check("a request for the expiry test is created", response.status === 201, `got ${response.status}`);
  backdateRequests(hygiene, 3);

  response = await call("/api/requests", {}, oldSeeker);
  const oldList = await body(response);
  check("an old request is listed as Expired", oldList?.requests?.[0]?.status === "Expired", oldList?.requests?.[0]?.status);
  check("an old request is not active", oldList?.requests?.[0]?.isActive === false);
  check("the closing date is exposed", /^\d{4}-\d{2}-\d{2}$/.test(oldList?.requests?.[0]?.expiresOn ?? ""));

  response = await call("/api/inbox", {}, oldDonor);
  const oldInbox = await body(response);
  check("the donor sees the request as expired", oldInbox?.notifications?.[0]?.request?.status === "Expired");
  check("expired requests are not counted as waiting", oldInbox?.pending === 0, String(oldInbox?.pending));

  response = await call(
    `/api/notifications/${oldInbox.notifications[0].id}`,
    { method: "POST", body: { accept: true } },
    oldDonor,
  );
  check("accepting an expired request is 400", response.status === 400, `got ${response.status}`);
  check("the refusal says it expired", /expired/i.test((await body(response))?.error ?? ""));

  const cappedApi = makeService();
  await cappedApi.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  const cappedSeeker = { user: seeker, service: cappedApi };
  for (let index = 0; index < 3; index += 1) {
    response = await call("/api/requests", { method: "POST", body: validRequest }, cappedSeeker);
    check(`request ${index + 1} of the day is accepted`, response.status === 201, `got ${response.status}`);
  }
  response = await call("/api/requests", { method: "POST", body: validRequest }, cappedSeeker);
  check("a fourth request in one day is 429", response.status === 429, `got ${response.status}`);
  check("the refusal explains the cap", /requests a day/i.test((await body(response))?.error ?? ""));

  console.log("reporting and blocking");
  const guarded = makeService({ maxRequestsPerDay: 50 });
  await guarded.saveProfile(seeker, { role: "seeker", phone: "9876543210", city: "Pune" });
  await guarded.saveProfile(donor, {
    role: "donor",
    phone: "9812345678",
    city: "Pune",
    bloodGroup: "O+",
  });
  const guardSeeker = { user: seeker, service: guarded };
  const guardDonor = { user: donor, service: guarded };

  response = await call("/api/requests", { method: "POST", body: validRequest }, guardSeeker);
  const guardId = (await body(response))?.request?.id;
  check("a request to report is created", response.status === 201, `got ${response.status}`);

  response = await call(`/api/requests/${guardId}/report`, { method: "POST", body: { reason: "Spam" } }, {
    user: null,
    service: guarded,
  });
  check("reporting needs sign-in", response.status === 401, `got ${response.status}`);

  response = await call(
    `/api/requests/${guardId}/report`,
    { method: "POST", body: { reason: "Spam" } },
    { ...guardDonor, sameOrigin: false },
  );
  check("cross-origin reporting is 403", response.status === 403, `got ${response.status}`);

  response = await call(
    `/api/requests/${guardId}/report`,
    { method: "POST", body: { reason: "Spam" } },
    guardDonor,
  );
  check("a donor can report a request (201)", response.status === 201, `got ${response.status}`);
  check("the report is acknowledged", (await body(response))?.reported === true);

  response = await call(
    `/api/requests/${guardId}/report`,
    { method: "POST", body: { reason: "Because" } },
    guardDonor,
  );
  check("an unknown report reason is 400", response.status === 400, `got ${response.status}`);

  response = await call(
    `/api/requests/${guardId}/report`,
    { method: "POST", body: { reason: "Spam" } },
    guardSeeker,
  );
  check("a blood seeker cannot report (403)", response.status === 403, `got ${response.status}`);

  response = await call("/api/requests/999999/report", { method: "POST", body: { reason: "Spam" } }, guardDonor);
  check("reporting an unknown request is 404", response.status === 404, `got ${response.status}`);

  response = await call("/api/blocked", {}, { user: null, service: guarded });
  check("the block list needs sign-in", response.status === 401, `got ${response.status}`);

  response = await call("/api/blocked", {}, guardDonor);
  check("the block list starts empty", (await body(response))?.blocked?.length === 0);

  response = await call(`/api/requests/${guardId}/block`, { method: "POST", body: {} }, {
    ...guardDonor,
    sameOrigin: false,
  });
  check("cross-origin blocking is 403", response.status === 403, `got ${response.status}`);

  response = await call(`/api/requests/${guardId}/block`, { method: "POST", body: {} }, guardDonor);
  check("a donor can block a request (200)", response.status === 200, `got ${response.status}`);
  check("the block is acknowledged", (await body(response))?.blocked === true);

  response = await call("/api/inbox", {}, guardDonor);
  check("the blocked request leaves the inbox", (await body(response))?.notifications?.length === 0);

  response = await call("/api/blocked", {}, guardDonor);
  const blockedList = (await body(response))?.blocked ?? [];
  check("the block list shows one account", blockedList.length === 1, JSON.stringify(blockedList));
  check("the block list names it", blockedList[0]?.name === "Asha Rao", blockedList[0]?.name);

  response = await call("/api/donors?group=O%2B", {}, guardSeeker);
  const guardedDonors = (await body(response))?.donors ?? [];
  check(
    "a blocked donor is hidden from the blocked account's search",
    !guardedDonors.some((entry) => entry.name === "Ravi Kumar"),
    JSON.stringify(guardedDonors),
  );

  let guardPush = null;
  const guardedPost = await call(
    "/api/requests",
    { method: "POST", body: validRequest },
    {
      ...guardSeeker,
      notifyDonors: async (recipients) => {
        guardPush = recipients;
      },
    },
  );
  check("a blocked account's next request is still accepted", guardedPost.status === 201, `got ${guardedPost.status}`);
  check(
    "the blocked donor is not pushed to",
    !(guardPush ?? []).some((entry) => entry.sub === "donor-1"),
    JSON.stringify(guardPush),
  );

  response = await call("/api/blocked/unblock", { method: "POST", body: { sub: "seeker-1" } }, {
    ...guardDonor,
    sameOrigin: false,
  });
  check("cross-origin unblocking is 403", response.status === 403, `got ${response.status}`);

  response = await call("/api/blocked/unblock", { method: "POST", body: { sub: "seeker-1" } }, guardDonor);
  check("a donor can unblock (200)", response.status === 200, `got ${response.status}`);
  check("the unblock is acknowledged", (await body(response))?.blocked === false);

  response = await call("/api/blocked", {}, guardDonor);
  check("the block list is empty again", (await body(response))?.blocked?.length === 0);

  response = await call("/api/donors?group=O%2B", {}, guardSeeker);
  check(
    "unblocking brings the donor back to search",
    ((await body(response))?.donors ?? []).some((entry) => entry.name === "Ravi Kumar"),
  );

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
