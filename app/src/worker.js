/**
 * Worker entry point: Sign in with Freebuff, then the JSON API, then static
 * assets. The auth wrapper must run before the asset fallback so
 * /auth/freebuff/* is handled by the SDK.
 */

import { createFreebuffAuth, isSameOriginRequest } from "@freebuff/auth";

import { errorResponse, handleApi } from "./api.js";

let auth;
let app;

/** Only a loopback origin may be plain http; deployed origins are https. */
function isLoopback(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function setup(env) {
  auth ??= createFreebuffAuth({
    clientId: env.FREEBUFF_CLIENT_ID,
    issuer: env.FREEBUFF_ISSUER,
    baseUrl: env.APP_ORIGIN,
    allowInsecureLocalhost: isLoopback(env.APP_ORIGIN),
  });
  const signedIn = auth;

  app ??= signedIn.wrap(async (request, env) => {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, { auth: signedIn, isSameOriginRequest });
      } catch (error) {
        return errorResponse(error);
      }
    }

    return env.ASSETS.fetch(request);
  });

  return app;
}

export default {
  fetch(request, env) {
    return setup(env)(request, env);
  },
};
