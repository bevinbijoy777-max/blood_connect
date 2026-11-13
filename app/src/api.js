/**
 * JSON API. `routeApi` holds the routes and the authorization decisions and
 * takes everything it needs as arguments, so it can be tested without a Worker
 * or a database. `handleApi` is the thin runtime layer that supplies them.
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

/**
 * @param {Request} request
 * @param {{ user: {sub: string, name?: string, email?: string} | null,
 *           sameOrigin: boolean, service: BloodConnectService }} context
 */
export async function routeApi(request, { user, sameOrigin, service }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method;
  const isWrite = method !== "GET" && method !== "HEAD";

  // Cross-site writes are refused before anything else is considered.
  if (isWrite && !sameOrigin) return new Response(null, { status: 403 });

  // -- identity ----------------------------------------------------------- //
  if (path === "/api/me" && method === "GET") {
    if (!user) return json({ user: null, profile: null });
    const profile = await service.getProfile(user.sub);
    return json({
      user: { name: user.name ?? null, email: user.email ?? null },
      profile: profileToJson(profile),
    });
  }

  // Everything below needs a signed-in user.
  if (!user) return json({ error: "Sign in required." }, 401);

  if (path === "/api/profile" && method === "POST") {
    const saved = await service.saveProfile(user, await readBody(request));
    return json({ profile: profileToJson(saved) });
  }

  if (path === "/api/donor-profile" && method === "POST") {
    const saved = await service.updateDonorProfile(user.sub, await readBody(request));
    return json({ profile: profileToJson(saved) });
  }

  // -- requests ----------------------------------------------------------- //
  if (path === "/api/requests" && method === "GET") {
    return json({ requests: await service.myRequests(user.sub) });
  }

  if (path === "/api/requests" && method === "POST") {
    const { request: created, notified } = await service.submitRequest(user.sub, await readBody(request));
    return json({ request: { id: created.id, status: created.status }, notified }, 201);
  }

  const requestAction = path.match(/^\/api\/requests\/(\d+)$/);
  if (requestAction && method === "POST") {
    const { action } = await readBody(request);
    const updated = await service.changeStatus(user.sub, Number(requestAction[1]), action);
    return json({ request: { id: updated.id, status: updated.status } });
  }

  // -- donors and notifications ------------------------------------------- //
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
    const { accept } = await readBody(request);
    return json(await service.respond(user.sub, Number(respond[1]), Boolean(accept)));
  }

  return json({ error: "Not found." }, 404);
}

/** Runtime layer: session, schema, same-origin check and error mapping. */
export async function handleApi(request, env, { auth, isSameOriginRequest }) {
  try {
    await ensureSchema(env.DB);
    const user = await auth.getUser(request);
    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    return await routeApi(request, {
      user,
      sameOrigin: !isWrite || isSameOriginRequest(request, env.APP_ORIGIN),
      service: new BloodConnectService(env.DB),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export function errorResponse(error) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  console.error("Unhandled API error:", error?.message ?? error);
  return json({ error: "Something went wrong. Please try again." }, 500);
}
