import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FCM_TOKEN_LIFETIME_MS,
  type FcmConfig,
  type FcmRequest,
  buildFcmJwt,
  buildFcmMessage,
  fcmAccessToken,
  fcmSendUrl,
  isFcmEnabled,
  isFcmTokenGone,
  readErrorCode,
  readFcmConfig,
  resetFcmTokenCacheForTests,
  sendFcmPush,
  setFcmTokenFetcherForTests,
  setFcmTransportForTests,
} from "./fcm.js";

/**
 * The FCM transport, pinned at the seams that fail silently, exactly as the
 * APNs sibling is. Everything here is either cryptography (the service-account
 * assertion), a URL, or the JSON envelope FCM validates — the category where a
 * mistake produces "notifications simply never arrive" rather than a visible
 * error. So the JWT is *verified* against the public key, the message body is
 * asserted field by field (data-only, no `notification` block — the one thing
 * that would silently route around the Android client's own drawing), and the
 * disabled-when-unconfigured posture is pinned the way S3 and APNs are.
 *
 * The token exchange and the HTTPS POST are faked. What they would test is
 * Google's server.
 */

// A real RSA key, because the point of the JWT test is that the signature
// verifies. Generated per run, never checked in.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CONFIG: FcmConfig = {
  projectId: "pqp-app",
  clientEmail: "fcm@pqp-app.iam.gserviceaccount.com",
  privateKey,
};

const ENV_KEYS = ["FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY"] as const;

function clearFcmEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearFcmEnv();
  resetFcmTokenCacheForTests();
});

afterEach(() => {
  setFcmTransportForTests(null);
  setFcmTokenFetcherForTests(null);
  clearFcmEnv();
  resetFcmTokenCacheForTests();
});

describe("readFcmConfig / isFcmEnabled", () => {
  it("is off with no env, the same posture as APNs and S3", () => {
    expect(readFcmConfig()).toBeNull();
    expect(isFcmEnabled()).toBe(false);
  });

  it("needs all three credentials — two is off, not half on", () => {
    process.env.FCM_PROJECT_ID = "pqp-app";
    process.env.FCM_CLIENT_EMAIL = "fcm@pqp-app.iam.gserviceaccount.com";
    expect(isFcmEnabled()).toBe(false);
    process.env.FCM_PRIVATE_KEY = privateKey;
    expect(isFcmEnabled()).toBe(true);
  });

  it("un-escapes a PEM whose newlines arrived as the two characters \\n", () => {
    process.env.FCM_PROJECT_ID = "pqp-app";
    process.env.FCM_CLIENT_EMAIL = "fcm@pqp-app.iam.gserviceaccount.com";
    process.env.FCM_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
    const config = readFcmConfig();
    expect(config?.privateKey).toBe(privateKey);
  });
});

describe("buildFcmJwt", () => {
  it("produces a verifiable RS256 assertion with the right claims", () => {
    const now = 1_700_000_000_000;
    const jwt = buildFcmJwt(CONFIG, now);
    const [header, claims, signature] = jwt.split(".");

    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    expect(decodedHeader).toEqual({ alg: "RS256", typ: "JWT" });

    const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decodedClaims.iss).toBe(CONFIG.clientEmail);
    expect(decodedClaims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(decodedClaims.scope).toContain("firebase.messaging");
    expect(decodedClaims.iat).toBe(Math.floor(now / 1000));
    expect(decodedClaims.exp).toBe(Math.floor(now / 1000) + 3600);

    // The signature must actually verify — a well-formed but wrongly-signed
    // assertion is exactly what Google answers `invalid_grant` to.
    const verified = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    expect(verified).toBe(true);
  });

  it("throws on a non-RSA key rather than signing something Google rejects", () => {
    const { privateKey: ecKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => buildFcmJwt({ ...CONFIG, privateKey: ecKey })).toThrow(/RSA/);
  });
});

describe("fcmAccessToken cache", () => {
  it("mints once and reuses within the lifetime, re-mints after", async () => {
    let mints = 0;
    setFcmTokenFetcherForTests(async () => {
      mints += 1;
      return `token-${mints}`;
    });
    const t0 = 1_700_000_000_000;
    expect(await fcmAccessToken(CONFIG, t0)).toBe("token-1");
    expect(await fcmAccessToken(CONFIG, t0 + FCM_TOKEN_LIFETIME_MS - 1)).toBe("token-1");
    expect(await fcmAccessToken(CONFIG, t0 + FCM_TOKEN_LIFETIME_MS + 1)).toBe("token-2");
    expect(mints).toBe(2);
  });

  it("re-mints when the credentials change", async () => {
    let mints = 0;
    setFcmTokenFetcherForTests(async () => `token-${(mints += 1)}`);
    const t0 = 1_700_000_000_000;
    expect(await fcmAccessToken(CONFIG, t0)).toBe("token-1");
    expect(
      await fcmAccessToken({ ...CONFIG, clientEmail: "other@x.iam.gserviceaccount.com" }, t0),
    ).toBe("token-2");
  });
});

describe("buildFcmMessage", () => {
  const message = buildFcmMessage({
    token: "device-token",
    title: "Ana",
    body: "Incoming call",
    path: "/app/dm/conv-1",
    tag: "conv-1",
    delivery: { priority: "high", ttlSeconds: 50 },
  });
  const inner = (message as { message: Record<string, unknown> }).message;

  it("is data-only — no notification block for the SDK to draw blind", () => {
    expect(inner).not.toHaveProperty("notification");
    expect(inner.data).toEqual({
      title: "Ana",
      body: "Incoming call",
      path: "/app/dm/conv-1",
      tag: "conv-1",
    });
  });

  it("carries the token, an uppercased android priority, ttl and collapse key", () => {
    expect(inner.token).toBe("device-token");
    const android = inner.android as Record<string, unknown>;
    expect(android.priority).toBe("HIGH");
    expect(android.ttl).toBe("50s");
    expect(android.collapse_key).toBe("conv-1");
  });

  it("maps a normal-urgency message to NORMAL priority", () => {
    const msg = buildFcmMessage({
      token: "t",
      title: "x",
      body: "y",
      path: "/app",
      tag: "c",
      delivery: { priority: "normal", ttlSeconds: 86400 },
    });
    const a = (msg as { message: { android: Record<string, unknown> } }).message.android;
    expect(a.priority).toBe("NORMAL");
    expect(a.ttl).toBe("86400s");
  });
});

describe("sendFcmPush", () => {
  it("POSTs to the project's messages:send URL with a bearer token", async () => {
    setFcmTokenFetcherForTests(async () => "access-123");
    const seen: FcmRequest[] = [];
    setFcmTransportForTests(async (request) => {
      seen.push(request);
      return { status: 200, errorCode: null };
    });
    const result = await sendFcmPush({
      config: CONFIG,
      deviceToken: "device-token",
      title: "Ana",
      body: "Incoming call",
      path: "/app/dm/conv-1",
      tag: "conv-1",
      delivery: { priority: "high", ttlSeconds: 50 },
    });
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(fcmSendUrl("pqp-app"));
    expect(seen[0].accessToken).toBe("access-123");
    const body = JSON.parse(seen[0].body) as { message: { token: string } };
    expect(body.message.token).toBe("device-token");
  });
});

describe("readErrorCode / isFcmTokenGone", () => {
  it("reads the messaging errorCode from the details, preferring it over status", () => {
    const body = JSON.stringify({
      error: {
        status: "NOT_FOUND",
        details: [{ errorCode: "UNREGISTERED" }],
      },
    });
    expect(readErrorCode(body)).toBe("UNREGISTERED");
  });

  it("falls back to the gRPC status when there is no detail code", () => {
    expect(readErrorCode(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }))).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("treats an empty or unparseable body as no code", () => {
    expect(readErrorCode("")).toBeNull();
    expect(readErrorCode("not json")).toBeNull();
  });

  it("prunes on UNREGISTERED, SENDER_ID_MISMATCH, and 404 NOT_FOUND", () => {
    expect(isFcmTokenGone({ status: 404, errorCode: "UNREGISTERED" })).toBe(true);
    expect(isFcmTokenGone({ status: 403, errorCode: "SENDER_ID_MISMATCH" })).toBe(true);
    expect(isFcmTokenGone({ status: 404, errorCode: "NOT_FOUND" })).toBe(true);
  });

  it("does NOT prune on INVALID_ARGUMENT or a bare auth failure — those are ours, not the token's", () => {
    // INVALID_ARGUMENT is also what a malformed payload earns; pruning it would
    // delete a live registration over a bug of ours.
    expect(isFcmTokenGone({ status: 400, errorCode: "INVALID_ARGUMENT" })).toBe(false);
    expect(isFcmTokenGone({ status: 401, errorCode: "UNAUTHENTICATED" })).toBe(false);
    expect(isFcmTokenGone({ status: 500, errorCode: "INTERNAL" })).toBe(false);
  });
});
