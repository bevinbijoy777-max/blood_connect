/**
 * JSON API. Every route that touches user data resolves the user on the server
 * with `getUser`, returns 401 when signed out, and rejects cross-origin writes.
 */

import { ensureSchema } from "./db.js";
import { BloodConnectService, profileToJson } from "./service.js";
import { ApiError } from "./validate.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError("Expected a JSON body.");
  }
}

export async function handleApi(request, env, { auth, isSameOriginRequest }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method;

  await ensureSchema(env.DB);
  const user = await auth.getUser(request);
  const service = new BloodConnectService(env.DB);

  const needsWrite = method !== "GET" && method !== "HEAD";
  if (needsWrite && !isSameOriginRequest(request, env.APP_ORIGIN)) {
    return new Response(null, { status: 403 });
  }

  // -- identity ----------------------------------------------------------- //
  if (path === "/api/me" && method === "GET") {
    if (!user) return json({ user: null, profile: null }, 200);
    const profile = await service.getProfile(user.sub);
    return json({
      user: { name: user.name ?? null, email: user.email ?? null },
      profile: profileToJson(profile),
    });
  }

  // Everything below needs a signed-in user.
  if (!user) return json({ error: "Sign in required." }, 401);

  if (path === "/api/profile" && method === "POST") {
    const body = await readBody(request);
    const saved = await service.saveProfile(user, body);
    return json({ profile: profileToJson(saved) });
  }

  if (path === "/api/donor-profile" && method === "POST") {
    const body = await readBody(request);
    const saved = await service.updateDonorProfile(user.sub, body);
    return json({ profile: profileToJson(saved) });
  }

  // -- requests ----------------------------------------------------------- //
  if (path === "/api/requests" && method === "GET") {
    return json({ requests: await service.myRequests(user.sub) });
  }

  if (path === "/api/requests" && method === "POST") {
    const body = await readBody(request);
    const { request, notified } = await service.submitRequest(user.sub, body);
    return json({ request: { id: request.id, status: request.status }, notified }, 201);
  }

  const requestAction = path.match(/^\/api\/requests\/(\d+)$/);
  if (requestAction && method === "POST") {
    const body = await readBody(request);
    const updated = await service.changeStatus(user.sub, Number(requestAction[1]), body.action);
    return json({ request: { id: updated.id, status: updated.status } });
  }

  // -- donors ------------------------------------------------------------- //
  if (path === "/api/donors" && method === "GET") {
    const donors = await service.searchDonors({
      bloodGroup: url.searchParams.get("group"),
      city: url.searchParams.get("city"),
    });
    return json({ donors });
  }

  if (path === "/api/inbox" && method === "GET") {
    return json(await service.inbox(user.sub));
  }

  const respond = path.match(/^\/api\/notifications\/(\d+)$/);
  if (respond && method === "POST") {
    const body = await readBody(request);
    return json(await service.respond(user.sub, Number(respond[1]), Boolean(body.accept)));
  }

  return json({ error: "Not found." }, 404);
}

export function errorResponse(error) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  console.error("Unhandled API error:", error?.message ?? error);
  return json({ error: "Something went wrong. Please try again." }, 500);
}
