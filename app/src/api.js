/**
 * JSON API. `routeApi` holds the routes and the authorization decisions and
 * takes everything it needs as arguments, so it can be tested without a Worker
 * or a database. `handleApi` is the thin runtime layer that supplies them.
 */

import { ensureSchema } from "./db.js";
import { pushConfig, requestPushPayload, sendPush } from "./push.js";
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
 *           sameOrigin: boolean, service: BloodConnectService,
 *           pushPublicKey?: string | null,
 *           notifyDonors?: (recipients: {sub: string}[], request: object) => Promise<void> }} context
 */
export async function routeApi(request, { user, sameOrigin, service, pushPublicKey = null, notifyDonors = null }) {
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

  // -- push notifications -------------------------------------------------- //
  // The VAPID public key is public by design: browsers need it to subscribe.
  if (path === "/api/push/key" && method === "GET") {
    return json({ publicKey: pushPublicKey });
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
    const { request: created, notified, recipients } = await service.submitRequest(
      user.sub,
      await readBody(request),
    );
    // A push that fails must never fail the request that was already saved.
    if (notifyDonors && recipients.length) {
      try {
        await notifyDonors(recipients, created);
      } catch {
        // Delivery is best effort; the donor still sees it in the inbox.
      }
    }
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

  // -- notification devices ----------------------------------------------- //
  if (path === "/api/push/subscribe" && method === "POST") {
    await service.savePushSubscription(user.sub, await readBody(request));
    return json({ subscribed: true });
  }

  if (path === "/api/push/unsubscribe" && method === "POST") {
    const { endpoint } = await readBody(request);
    await service.removePushSubscription(user.sub, endpoint);
    return json({ subscribed: false });
  }

  return json({ error: "Not found." }, 404);
}

/**
 * Push every device of every notified donor, in parallel. A push service that
 * is down, or a subscription the browser has thrown away, only costs that one
 * notification; the inbox entry is already saved.
 */
async function deliverPushes(service, recipients, request, config) {
  const subscriptions = await service.pushSubscriptionsFor(recipients.map((recipient) => recipient.sub));
  if (!subscriptions.length) return;
  const payload = requestPushPayload(request);
  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        const result = await sendPush(subscription, payload, config);
        if (result.gone) await service.forgetPushEndpoint(subscription.endpoint);
        else if (!result.ok) console.error("Push rejected with status", result.status);
      } catch (error) {
        console.error("Push delivery failed:", error?.message ?? error);
      }
    }),
  );
}

/** Runtime layer: session, schema, same-origin check and error mapping. */
export async function handleApi(request, env, { auth, isSameOriginRequest }) {
  try {
    await ensureSchema(env.DB);
    const user = await auth.getUser(request);
    const service = new BloodConnectService(env.DB);
    const config = pushConfig(env);
    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    return await routeApi(request, {
      user,
      sameOrigin: !isWrite || isSameOriginRequest(request, env.APP_ORIGIN),
      service,
      // Without VAPID keys the app still works; it just cannot push in the
      // background, and the client hides the notification setting.
      pushPublicKey: config?.publicKey ?? null,
      notifyDonors: config
        ? (recipients, created) => deliverPushes(service, recipients, created, config)
        : null,
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
