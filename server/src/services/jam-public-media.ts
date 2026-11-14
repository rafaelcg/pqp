import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { isStorageConfigured, presignGet } from "../lib/s3.js";

/**
 * THE URL A PUBLIC READ HANDS OUT FOR A JAM OBJECT (audio, video, cover).
 *
 * Two shapes, chosen per call by `JAM_PUBLIC_MEDIA_BASE_URL`:
 *
 *  - UNSET (the default): a presigned GET on the bucket, exactly what a
 *    channel read hands out, but signed in ten-minute windows
 *    (`stableWindowSeconds`) so every visitor inside one window is handed the
 *    SAME URL and a shared cache can hold a page of the list.
 *
 *  - SET (e.g. `https://media.pqp.gg`): `<base>/jam-media/<token>?e=<exp>&s=<sig>`,
 *    for an edge Worker on a pqp.gg hostname that serves the bytes from the
 *    bucket (`tools/jam-media-edge/`). The owner wants this so the bytes pass
 *    through our zone, the precondition for Cloudflare's zone-level CSAM
 *    scanning, which cannot see the bucket's own endpoint. That tool is
 *    documented for images only: audio stays unscanned either way
 *    (docs/CONTENT_SAFETY.md, docs/JAM_PUBLIC.md).
 *    `<token>` is the object key ENCRYPTED, so the URL names nothing: a
 *    channel song's key is `jam/<server id>/...`, and a presigned URL shows
 *    it (the origin server's id, even when the starter hid the origin); the
 *    edge URL does not. The Worker is `tools/jam-media-edge/`; what it does, all of
 *    it, before serving, and what its tests pin:
 *
 *      1. `e` is an integer of unix seconds that is not in the past;
 *      2. `s` equals base64url(HMAC-SHA256(S, `${token}\n${e}`)), compared in
 *         constant time, where `S` is the derived secret below, held by the
 *         Worker as `JAM_PUBLIC_MEDIA_SECRET` (never the Clerk key itself);
 *      3. decrypt `token` (base64url of 12-byte IV, ciphertext, 16-byte tag)
 *         with AES-256-GCM under the raw 32 bytes of HMAC-SHA256(S, "aes-key");
 *         a token that does not decrypt is refused;
 *      4. the decrypted key starts with `jam/` and has no `..` segment
 *         (nothing else in the bucket is reachable);
 *      5. only GET and HEAD, honouring `Range` (the audio engine and `<video>`
 *         both ask for ranges), with `Cache-Control` no longer than until `e`.
 *
 *    `openJamPublicMediaUrl` below is the server-side twin of that check, so
 *    the mint and the verify live together and a test pins both, and
 *    `jam-public-media-edge.test.ts` pins the exact URLs the Worker's own
 *    tests open (tools/jam-media-edge/test/golden.json).
 *
 * Either way a URL is good for at least 50 minutes (`ttl` 60 minutes from the
 * start of its ten-minute window), and `mediaExpiresAt` says until when.
 *
 * Revocation: an unpublish, a withdrawn consent or a removed part drops the
 * URL from every public read at once; a URL already handed out keeps working
 * until it expires (at most an hour), the same bound a channel's presigned
 * URLs have. Rejected objects (quarantine) are never in any read.
 */

/** Seconds a URL is good for, from the start of its window. */
export const JAM_PUBLIC_MEDIA_TTL_SECONDS = 60 * 60;
/** URLs are identical inside one window of this many seconds. */
export const JAM_PUBLIC_MEDIA_WINDOW_SECONDS = 10 * 60;
/** The edge route's prefix. */
export const JAM_PUBLIC_MEDIA_ROUTE = "/jam-media/";

/** The edge host, or null (presigned URLs). Read per call: no restart needed. */
export function jamPublicMediaBaseUrl(): string | null {
  const raw = process.env.JAM_PUBLIC_MEDIA_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

/** The derived key the edge Worker holds as `JAM_PUBLIC_MEDIA_SECRET`. */
export function jamPublicMediaSecret(): string | null {
  const raw = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-jam-public"
      : null;
  if (!raw) {
    return null;
  }
  return createHmac("sha256", raw).update("pqp-jam-public-media").digest("base64url");
}

function windowStartMs(nowMs: number): number {
  const window = JAM_PUBLIC_MEDIA_WINDOW_SECONDS * 1000;
  return Math.floor(nowMs / window) * window;
}

/** When every URL minted at `nowMs` stops working. */
export function jamPublicMediaExpiresAt(nowMs = Date.now()): Date {
  return new Date(windowStartMs(nowMs) + JAM_PUBLIC_MEDIA_TTL_SECONDS * 1000);
}

function signature(secret: string, token: string, expires: number): string {
  return createHmac("sha256", secret).update(`${token}\n${expires}`).digest("base64url");
}

function encryptionKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("aes-key").digest();
}

/**
 * The key, encrypted. The IV is derived from the key itself (the first 12 bytes
 * of an HMAC under the secret), so one object always gets the same token and a
 * shared cache can hold a page; two different keys get different IVs, which is
 * the one property GCM needs from an IV.
 */
function sealKey(secret: string, key: string): string {
  const iv = createHmac("sha256", secret).update(`iv\n${key}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

function openKey(secret: string, token: string): string | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 12 + 16 + 1) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The public URL of one object. "" when nothing can sign it (no storage and no
 * edge, or an edge with no secret), which the caller treats as "no media"
 * rather than failing the read. Only `jam/` keys are ever handed out.
 */
export function jamPublicMediaUrl(key: string, nowMs = Date.now()): string {
  if (!key.startsWith("jam/")) {
    return "";
  }
  const base = jamPublicMediaBaseUrl();
  if (base) {
    const secret = jamPublicMediaSecret();
    if (!secret) {
      return "";
    }
    const expires = Math.floor(jamPublicMediaExpiresAt(nowMs).getTime() / 1000);
    const token = sealKey(secret, key);
    return `${base}${JAM_PUBLIC_MEDIA_ROUTE}${token}?e=${expires}&s=${signature(secret, token, expires)}`;
  }
  if (!isStorageConfigured()) {
    return "";
  }
  return presignGet(key, {
    ttlSeconds: JAM_PUBLIC_MEDIA_TTL_SECONDS,
    stableWindowSeconds: JAM_PUBLIC_MEDIA_WINDOW_SECONDS,
    now: new Date(nowMs),
  });
}

/**
 * The edge Worker's check, on the server, for the tests and as the reference
 * the Worker ports: the object key to serve, or why the URL fails.
 */
export function openJamPublicMediaUrl(
  token: string,
  expires: string | null,
  sig: string | null,
  nowMs = Date.now(),
): { key: string } | { failure: "malformed" | "expired" | "bad-signature" | "unconfigured" } {
  if (!token || !expires || !sig || !/^\d{1,12}$/.test(expires) || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { failure: "malformed" };
  }
  const secret = jamPublicMediaSecret();
  if (!secret) {
    return { failure: "unconfigured" };
  }
  const want = Buffer.from(signature(secret, token, Number(expires)));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return { failure: "bad-signature" };
  }
  if (Number(expires) * 1000 < nowMs) {
    return { failure: "expired" };
  }
  const key = openKey(secret, token);
  if (!key || !key.startsWith("jam/") || key.split("/").includes("..")) {
    return { failure: "malformed" };
  }
  return { key };
}
