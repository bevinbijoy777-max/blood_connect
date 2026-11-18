/**
 * Web Push with no dependencies: VAPID (RFC 8292) signing and aes128gcm
 * payload encryption (RFC 8291) straight on WebCrypto, which both Workers and
 * Node expose. The push service does the actual delivery to the browser.
 */

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const TWELVE_HOURS = 12 * 60 * 60;

export function base64UrlToBytes(value) {
  const normalised = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Read the VAPID keys from the environment. Missing or malformed keys mean Web
 * Push is simply off: the app still works, it just cannot notify in the
 * background.
 *
 * @returns {{publicKey: string, subject: string, secret: Uint8Array} | null}
 */
export function pushConfig(env) {
  const publicKey = String(env?.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = String(env?.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = String(env?.VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey || !subject) return null;

  let point;
  let secret;
  try {
    point = base64UrlToBytes(publicKey);
    secret = base64UrlToBytes(privateKey);
  } catch {
    return null;
  }
  // An uncompressed P-256 point is 65 bytes, the private scalar 32.
  if (point.length !== 65 || point[0] !== 4 || secret.length !== 32) return null;
  return { publicKey, subject, secret };
}

async function vapidSigningKey(config) {
  const point = base64UrlToBytes(config.publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(point.slice(1, 33)),
    y: bytesToBase64Url(point.slice(33, 65)),
    d: bytesToBase64Url(config.secret),
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** `Authorization: vapid t=<jwt>,k=<public key>` for one push service origin. */
export async function vapidAuthorization(endpoint, config, now = Date.now()) {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + TWELVE_HOURS,
    sub: config.subject,
  };
  const signingInput =
    `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.` +
    `${bytesToBase64Url(encoder.encode(JSON.stringify(claims)))}`;
  const key = await vapidSigningKey(config);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  // WebCrypto returns the raw r||s pair ES256 expects, not DER.
  return `vapid t=${signingInput}.${bytesToBase64Url(new Uint8Array(signature))},k=${config.publicKey}`;
}

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
  return new Uint8Array(derived);
}

/**
 * Encrypt one push message for one subscription (RFC 8291, aes128gcm).
 * @returns {Promise<Uint8Array>} the request body the push service expects.
 */
export async function encryptPayload(subscription, payload) {
  const uaPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error("The push subscription is not a valid P-256 subscription.");
  }

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const keyInfo = concat(encoder.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(shared, authSecret, keyInfo, 256);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 96);

  // 0x02 marks the last record, so no extra padding block is needed.
  const plaintext = concat(encoder.encode(String(payload)), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
}

/**
 * POST one message to a push service.
 * @returns {Promise<{ok: boolean, gone: boolean, status: number}>} `gone` means
 *   the subscription is dead (browser uninstalled, permission revoked) and the
 *   row should be deleted.
 */
export async function sendPush(subscription, payload, config, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = await encryptPayload(subscription, payload);
  const authorization = await vapidAuthorization(subscription.endpoint, config, now);
  const response = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  if (response.status === 404 || response.status === 410) {
    return { ok: false, gone: true, status: response.status };
  }
  return { ok: response.ok, gone: false, status: response.status };
}

/**
 * The message a seeker sees when a donor accepts their request. The donor's
 * phone number is deliberately left out: a push can land on a lock screen,
 * and the number stays in the app.
 */
export function acceptedPushPayload(event) {
  return {
    title: `${event.donorName} can donate ${event.bloodGroup}`,
    body:
      `${event.donorName} accepted your ${event.bloodGroup} request for ` +
      `${event.patientName} in ${event.city}. Open Blood Connect to see their number.`,
    url: "/",
    tag: `response-${event.requestId}`,
    requestId: event.requestId,
  };
}

/** The message a donor sees for one newly submitted request. */
export function requestPushPayload(request) {
  return {
    title: `${request.blood_group} blood needed in ${request.city}`,
    body:
      `${request.urgency} request: ${request.units} unit(s) for ${request.patient_name} ` +
      `at ${request.hospital}. Tap to accept or decline.`,
    url: "/",
    tag: `request-${request.id}`,
    requestId: request.id,
  };
}
