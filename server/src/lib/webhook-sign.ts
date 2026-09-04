import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks signing (https://github.com/standard-webhooks/standard-webhooks)
 * implemented with node:crypto. No npm dependency: the spec is HMAC-SHA256 over
 * `{id}.{unix_ts}.{raw_json_body}` and a `whsec_` + base64 secret, which is
 * fewer lines than the import.
 *
 * The body passed in must be the exact UTF-8 bytes that will go on the wire.
 * Re-serializing JSON after the fact (pretty-print, key reorder) invalidates
 * the signature.
 */

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES_MIN = 24;
const SECRET_BYTES_MAX = 64;

export function generateSigningSecret(): string {
  // 32 bytes sits in the spec's 24–64 window and is a single AES-256 key's
  // worth of entropy. Base64 (not base64url): the Standard Webhooks prefix
  // is defined that way.
  return SECRET_PREFIX + randomBytes(32).toString("base64");
}

export function decodeSigningSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) {
    throw new Error("Signing secret must start with whsec_");
  }
  const raw = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
  if (raw.length < SECRET_BYTES_MIN || raw.length > SECRET_BYTES_MAX) {
    throw new Error(
      `Signing secret must decode to ${SECRET_BYTES_MIN}–${SECRET_BYTES_MAX} bytes`,
    );
  }
  return raw;
}

export function signedContent(
  id: string,
  unixTimestamp: string | number,
  rawJsonBody: string,
): string {
  return `${id}.${unixTimestamp}.${rawJsonBody}`;
}

export function hmacSha256Base64(secret: string, content: string): string {
  return createHmac("sha256", decodeSigningSecret(secret))
    .update(content, "utf8")
    .digest("base64");
}

export function signV1(
  secret: string,
  id: string,
  unixTimestamp: string | number,
  rawJsonBody: string,
): string {
  const digest = hmacSha256Base64(
    secret,
    signedContent(id, unixTimestamp, rawJsonBody),
  );
  return `v1,${digest}`;
}

/**
 * One or two `v1,…` signatures, space-delimited, while a previous secret is
 * still inside its rotation window.
 */
export function signatureHeader(
  secrets: readonly string[],
  id: string,
  unixTimestamp: string | number,
  rawJsonBody: string,
): string {
  return secrets
    .filter(Boolean)
    .map((secret) => signV1(secret, id, unixTimestamp, rawJsonBody))
    .join(" ");
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Timing-safe compare of one expected `v1,…` signature against a
 * space-delimited header. Returns true if any listed signature matches.
 */
export function verifySignatureHeader(
  secret: string,
  id: string,
  unixTimestamp: string | number,
  rawJsonBody: string,
  header: string,
): boolean {
  const expected = Buffer.from(
    signV1(secret, id, unixTimestamp, rawJsonBody),
    "utf8",
  );
  const parts = header.trim().split(/\s+/);
  let matched = false;
  for (const part of parts) {
    const got = Buffer.from(part, "utf8");
    if (buffersEqual(expected, got)) {
      matched = true;
    }
  }
  return matched;
}

export function secretHint(secret: string): string {
  if (secret.length <= 4) {
    return secret;
  }
  return secret.slice(-4);
}
