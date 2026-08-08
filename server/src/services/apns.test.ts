import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APNS_COLLAPSE_ID_MAX_BYTES,
  APNS_DEFAULT_TOPIC,
  APNS_JWT_LIFETIME_MS,
  type ApnsConfig,
  type ApnsRequest,
  apnsHeaders,
  apnsHost,
  buildApnsJwt,
  isApnsEnabled,
  isApnsTokenGone,
  readApnsConfig,
  resetApnsJwtCacheForTests,
  sendApnsPush,
  setApnsTransportForTests,
} from "./apns.js";

/**
 * The APNs transport, pinned at the seams that fail silently.
 *
 * Everything here is either cryptography or a header string, which is exactly
 * the category where a mistake produces "notifications simply never arrive"
 * rather than an error anybody sees. So: the JWT is *verified*, not merely
 * shaped — a DER-encoded signature would pass a regex and be rejected by Apple.
 * The headers are asserted value by value. And the disabled-when-unconfigured
 * posture is pinned the same way the attachment tests pin it for S3, because
 * the alternative to "off" is a server trying to sign with an absent key on
 * every message.
 *
 * The HTTP/2 layer itself is faked. What it would test is Apple's server.
 */

// A real P-256 key, because the point of the JWT test is that the signature
// verifies. Generated per run rather than checked in: a private key in a repo is
// a private key in a repo, even a throwaway one.
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CONFIG: ApnsConfig = {
  keyId: "ABCD123456",
  teamId: "WXBFUF9WMA",
  privateKey,
  topic: "gg.pqp.app",
  environment: "production",
};

const ENV_KEYS = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_PRIVATE_KEY",
  "APNS_TOPIC",
  "APNS_ENVIRONMENT",
] as const;

function clearApnsEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearApnsEnv();
  resetApnsJwtCacheForTests();
});

afterEach(() => {
  clearApnsEnv();
  resetApnsJwtCacheForTests();
  setApnsTransportForTests(null);
});

// ----------------------------------------------------------- configuration

describe("readApnsConfig", () => {
  it("is null — and the leg is off — until all three secrets are present", () => {
    expect(readApnsConfig()).toBeNull();
    expect(isApnsEnabled()).toBe(false);

    process.env.APNS_KEY_ID = CONFIG.keyId;
    expect(readApnsConfig()).toBeNull();

    process.env.APNS_TEAM_ID = CONFIG.teamId;
    expect(readApnsConfig()).toBeNull();
    expect(isApnsEnabled()).toBe(false);

    process.env.APNS_PRIVATE_KEY = privateKey;
    expect(readApnsConfig()).not.toBeNull();
    expect(isApnsEnabled()).toBe(true);
  });

  it("defaults the topic to the bundle id and the environment to production", () => {
    process.env.APNS_KEY_ID = CONFIG.keyId;
    process.env.APNS_TEAM_ID = CONFIG.teamId;
    process.env.APNS_PRIVATE_KEY = privateKey;

    const config = readApnsConfig()!;
    expect(config.topic).toBe(APNS_DEFAULT_TOPIC);
    expect(config.environment).toBe("production");
    expect(apnsHost(config.environment)).toBe("https://api.push.apple.com");
  });

  it("honours sandbox, and only the exact word", () => {
    process.env.APNS_KEY_ID = CONFIG.keyId;
    process.env.APNS_TEAM_ID = CONFIG.teamId;
    process.env.APNS_PRIVATE_KEY = privateKey;

    process.env.APNS_ENVIRONMENT = "sandbox";
    expect(readApnsConfig()!.environment).toBe("sandbox");
    expect(apnsHost("sandbox")).toBe("https://api.sandbox.push.apple.com");

    // Anything else is production. A typo must not silently point a live
    // deployment at a gateway that rejects every one of its tokens.
    process.env.APNS_ENVIRONMENT = "Sandbox";
    expect(readApnsConfig()!.environment).toBe("production");
    process.env.APNS_ENVIRONMENT = "development";
    expect(readApnsConfig()!.environment).toBe("production");
  });

  /**
   * `fly secrets set` through a shell that cannot hold literal newlines writes
   * them as the two characters `\n`. A PEM in that state is not parseable, and
   * the failure is at *send* time — long after the deploy that broke it.
   */
  it("un-escapes a PEM whose newlines survived as backslash-n", () => {
    process.env.APNS_KEY_ID = CONFIG.keyId;
    process.env.APNS_TEAM_ID = CONFIG.teamId;
    process.env.APNS_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");

    const config = readApnsConfig()!;
    expect(config.privateKey).toBe(privateKey);
    // Proof it is usable, not just that it looks right.
    expect(() => buildApnsJwt(config)).not.toThrow();
  });
});

// -------------------------------------------------------------------- token

describe("buildApnsJwt", () => {
  it("carries Apple's header and claims", () => {
    const jwt = buildApnsJwt(CONFIG, 1_700_000_000_000);
    const [header, claims] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: CONFIG.keyId,
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: CONFIG.teamId,
      // Seconds, not milliseconds. Apple rejects a token more than an hour old,
      // and a millisecond `iat` is ~54,000 years in the future.
      iat: 1_700_000_000,
    });
  });

  /**
   * The one that matters. JWS requires the raw 64-byte R‖S signature; Node's
   * default for EC keys is the ASN.1 DER envelope. Both are ~equally long in
   * base64url and only one of them verifies.
   */
  it("signs ES256 in the raw P1363 form JWS requires", () => {
    const jwt = buildApnsJwt(CONFIG);
    const [header, claims, signature] = jwt.split(".");
    const raw = Buffer.from(signature!, "base64url");

    expect(raw).toHaveLength(64);
    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey(publicKey), dsaEncoding: "ieee-p1363" },
        raw,
      ),
    ).toBe(true);
  });

  it("refuses a key that is not EC, rather than signing something Apple rejects", () => {
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => buildApnsJwt({ ...CONFIG, privateKey: rsa.privateKey })).toThrow(
      /EC \(P-256\)/,
    );
  });
});

describe("the cached provider token", () => {
  it("is reused for its lifetime and re-minted after it", () => {
    const start = 1_700_000_000_000;
    const headers = () => apnsHeaders(CONFIG, alertDelivery(), start);

    const first = headers().authorization;
    expect(headers().authorization).toBe(first);

    // One second before the boundary the same token is still handed out; one
    // second after, a new one. Both assertions matter: caching for too long is
    // a 403 from Apple, not caching at all is a rate limit.
    expect(
      apnsHeaders(CONFIG, alertDelivery(), start + APNS_JWT_LIFETIME_MS - 1000)
        .authorization,
    ).toBe(first);
    expect(
      apnsHeaders(CONFIG, alertDelivery(), start + APNS_JWT_LIFETIME_MS + 1000)
        .authorization,
    ).not.toBe(first);
  });

  it("is invalidated by a key rotation, not just by time", () => {
    const now = 1_700_000_000_000;
    const before = apnsHeaders(CONFIG, alertDelivery(), now).authorization;
    const after = apnsHeaders(
      { ...CONFIG, keyId: "ZZZZ999999" },
      alertDelivery(),
      now,
    ).authorization;
    expect(after).not.toBe(before);
  });
});

// ------------------------------------------------------------------ headers

function alertDelivery(
  overrides: Partial<Parameters<typeof apnsHeaders>[1]> = {},
): Parameters<typeof apnsHeaders>[1] {
  return {
    pushType: "alert",
    priority: 10,
    expirationSeconds: 1_700_000_050,
    collapseId: "conversation-1",
    ...overrides,
  };
}

describe("apnsHeaders", () => {
  it("states the topic, type, priority, expiry and collapse id", () => {
    const headers = apnsHeaders(CONFIG, alertDelivery(), 1_700_000_000_000);
    expect(headers["apns-topic"]).toBe("gg.pqp.app");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-expiration"]).toBe("1700000050");
    expect(headers["apns-collapse-id"]).toBe("conversation-1");
    expect(headers.authorization).toMatch(/^bearer eyJ/);
  });

  it("carries no pseudo-headers — those belong to the transport", () => {
    const headers = apnsHeaders(CONFIG, alertDelivery());
    expect(Object.keys(headers).some((key) => key.startsWith(":"))).toBe(false);
  });

  it("omits the collapse header entirely when there is nothing to collapse", () => {
    const headers = apnsHeaders(CONFIG, alertDelivery({ collapseId: null }));
    expect(headers).not.toHaveProperty("apns-collapse-id");
  });

  it("truncates a collapse id past Apple's 64-byte ceiling", () => {
    const headers = apnsHeaders(
      CONFIG,
      alertDelivery({ collapseId: "x".repeat(120) }),
    );
    expect(headers["apns-collapse-id"]).toHaveLength(APNS_COLLAPSE_ID_MAX_BYTES);
  });
});

// ---------------------------------------------------------------- transport

describe("sendApnsPush", () => {
  it("posts the body to /3/device/<token> on the configured host", async () => {
    const seen: ApnsRequest[] = [];
    setApnsTransportForTests(async (request) => {
      seen.push(request);
      return { status: 200, reason: null };
    });

    const result = await sendApnsPush({
      config: { ...CONFIG, environment: "sandbox" },
      deviceToken: "abc123",
      payload: '{"aps":{}}',
      delivery: alertDelivery(),
    });

    expect(result).toEqual({ status: 200, reason: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.host).toBe("https://api.sandbox.push.apple.com");
    expect(seen[0]!.deviceToken).toBe("abc123");
    expect(seen[0]!.body).toBe('{"aps":{}}');
    expect(seen[0]!.headers["apns-topic"]).toBe("gg.pqp.app");
  });
});

describe("isApnsTokenGone", () => {
  it("is true for the two answers that mean this token is dead here", () => {
    expect(isApnsTokenGone({ status: 410, reason: "Unregistered" })).toBe(true);
    // Also what the production gateway says about a sandbox token — see the
    // note on the function. Pruning is still right; the log line is the fix.
    expect(isApnsTokenGone({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  });

  it("is false for failures the token would survive", () => {
    expect(isApnsTokenGone({ status: 200, reason: null })).toBe(false);
    // A retryable overload must never delete somebody's registration.
    expect(isApnsTokenGone({ status: 429, reason: "TooManyRequests" })).toBe(false);
    expect(isApnsTokenGone({ status: 503, reason: null })).toBe(false);
    // A misconfigured topic is the *server's* fault, not the device's.
    expect(isApnsTokenGone({ status: 400, reason: "TopicDisallowed" })).toBe(false);
    expect(isApnsTokenGone({ status: 403, reason: "InvalidProviderToken" })).toBe(
      false,
    );
  });
});
