/**
 * Checks the Web Push building blocks without a browser or a push service:
 * VAPID JWT signing, aes128gcm encryption (decrypted back the way a browser
 * would), and the request a push service receives.
 *
 * Run: node scripts/test-push.mjs
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  encryptPayload,
  pushConfig,
  requestPushPayload,
  sendPush,
  vapidAuthorization,
} from "../src/push.js";
import { checker } from "./fakes.mjs";

const { check, finish } = checker();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
  return new Uint8Array(derived);
}

/** Decrypt the way a browser does (RFC 8291, receiver side). */
async function decrypt(body, deviceKeys, authSecret) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);

  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, deviceKeys.privateKey, 256),
  );
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", deviceKeys.publicKey));
  const ikm = await hkdf(
    shared,
    authSecret,
    concat(encoder.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic),
    256,
  );
  const contentKey = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 96);
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  );
  return { recordSize, idLength, plaintext };
}

async function run() {
  // A VAPID pair in the shape `npx web-push generate-vapid-keys` prints.
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey));
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const env = {
    VAPID_PUBLIC_KEY: bytesToBase64Url(vapidPublic),
    VAPID_PRIVATE_KEY: vapidPrivate.d,
    VAPID_SUBJECT: "mailto:team@example.com",
  };

  console.log("configuration");
  const config = pushConfig(env);
  check("a generated keypair is accepted", config !== null);
  check("no keys means push is off", pushConfig({}) === null);
  check("a missing private key means push is off", pushConfig({ ...env, VAPID_PRIVATE_KEY: "" }) === null);
  check("a wrong-length private key is refused", pushConfig({ ...env, VAPID_PRIVATE_KEY: "AAAA" }) === null);
  check("a missing subject is refused", pushConfig({ ...env, VAPID_SUBJECT: "" }) === null);

  // The browser side of a subscription.
  const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
    "deriveKey",
  ]);
  const devicePublic = new Uint8Array(await crypto.subtle.exportKey("raw", device.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: "https://push.example.test/send/abc123",
    p256dh: bytesToBase64Url(devicePublic),
    auth: bytesToBase64Url(authSecret),
  };

  console.log("payload encryption");
  const payload = requestPushPayload({
    id: 7,
    blood_group: "O+",
    city: "Pune",
    urgency: "Urgent",
    units: 2,
    patient_name: "Asha Rao",
    hospital: "Ruby Hall",
  });
  check("the title names the group and city", payload.title === "O+ blood needed in Pune", payload.title);
  check("the body names the hospital", payload.body.includes("Ruby Hall"), payload.body);

  const body = await encryptPayload(subscription, JSON.stringify(payload));
  check("the body carries salt, record size, key length and key", body.length > 16 + 4 + 1 + 65);
  check("the sender key is an uncompressed P-256 point", body[20] === 65 && body[21] === 4);

  const opened = await decrypt(body, device, authSecret);
  check("the record size is 4096", opened.recordSize === 4096, String(opened.recordSize));
  check("the sender key length is declared", opened.idLength === 65);
  check("the browser decrypts the payload", decoder.decode(opened.plaintext.slice(0, -1)) === JSON.stringify(payload));
  check("the last-record delimiter is 0x02", opened.plaintext.at(-1) === 2);

  const second = await encryptPayload(subscription, JSON.stringify(payload));
  check("every message gets a fresh salt", second[0] !== body[0] || second[1] !== body[1]);

  let tampered = false;
  try {
    await encryptPayload({ endpoint: subscription.endpoint, p256dh: "AAAA", auth: subscription.auth }, "{}");
  } catch {
    tampered = true;
  }
  check("a broken subscription key is refused", tampered);

  console.log("VAPID authorization");
  const authorization = await vapidAuthorization(subscription.endpoint, config);
  check("it is a vapid header", authorization.startsWith("vapid t="), authorization.slice(0, 20));
  check("it carries the public key", authorization.endsWith(`,k=${env.VAPID_PUBLIC_KEY}`));

  const [token, keyPart] = authorization.replace(/^vapid /, "").split(",");
  const [headerPart, claimsPart, signaturePart] = token.slice(2).split(".");
  const header = JSON.parse(decoder.decode(base64UrlToBytes(headerPart)));
  const claims = JSON.parse(decoder.decode(base64UrlToBytes(claimsPart)));
  check("the JWT is ES256", header.alg === "ES256" && header.typ === "JWT");
  check("aud is the push service origin", claims.aud === "https://push.example.test", claims.aud);
  check("sub is the configured subject", claims.sub === env.VAPID_SUBJECT);
  const lifetime = claims.exp - Date.now() / 1000;
  check("exp is under the 24 hour limit", lifetime > 0 && lifetime <= 86400, String(lifetime));

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    vapid.publicKey,
    base64UrlToBytes(signaturePart),
    encoder.encode(`${headerPart}.${claimsPart}`),
  );
  check("the signature verifies against the public key", verified);
  check("k= is the matching key", keyPart === `k=${env.VAPID_PUBLIC_KEY}`);

  console.log("delivery");
  let captured = null;
  const accepting = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };
  const result = await sendPush(subscription, payload, config, { fetchImpl: accepting });
  check("201 is success", result.ok === true && result.gone === false, JSON.stringify(result));
  check("it posts to the subscription endpoint", captured?.url === subscription.endpoint);
  check("it sends a POST", captured?.init.method === "POST");
  check("it declares aes128gcm", captured?.init.headers["Content-Encoding"] === "aes128gcm");
  check("it asks for no visible content type", captured?.init.headers["Content-Type"] === "application/octet-stream");
  check("it sets a TTL", captured?.init.headers.TTL === "86400");
  check("it sends the encrypted body", captured?.init.body instanceof Uint8Array);

  const gone = await sendPush(subscription, payload, config, {
    fetchImpl: async () => new Response(null, { status: 410 }),
  });
  check("410 marks the subscription as gone", gone.gone === true && gone.ok === false, JSON.stringify(gone));

  const forbidden = await sendPush(subscription, payload, config, {
    fetchImpl: async () => new Response(null, { status: 403 }),
  });
  check("403 is reported as a failure, not as gone", forbidden.ok === false && forbidden.gone === false);

  finish();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
