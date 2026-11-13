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
import { daysAgo, makeService } from "./fakes.mjs";
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
  const { user = null, sameOrigin = true, service } = context;
  try {
    return await routeApi(makeRequest(path, options), { user, sameOrigin, service });
  } catch (error) {
    return errorResponse(error);
  }
}

async function body(response) {
  return response.json().catch(() => null);
}

async function run() {
  const service = makeService();
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
  check("donor search omits phone numbers", donors?.every((entry) => !("phone" in entry)));
  check("donor search omits donation dates", donors?.every((entry) => !("lastDonation" in entry)));

  response = await call("/api/inbox", {}, asDonor);
  const inbox = await body(response);
  check("donor inbox lists the request", inbox?.notifications?.length === 1);
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

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
