import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The auth path through the REAL `@clerk/backend`, nothing mocked but the
 * network.
 *
 * Every other auth test replaces `@clerk/backend` with a stub (`vi.mock`), so a
 * major bump of the SDK changes nothing they can see: `verifyToken`'s return
 * shape, the claims it insists on, the error a 404 carries, the field names of
 * a user all pass through a stub that was written against the old version.
 * This file signs session JWTs with a throwaway RSA key, serves the matching
 * JWKS and a Backend API user from a stubbed `fetch`, and runs them through
 * `verifyAuthHeader`, `deleteClerkUser` and `createDesktopSignInToken` exactly
 * as production calls them.
 *
 * The SDK reads `fetch` lazily when `NODE_ENV` is `test` (vitest sets it), so
 * stubbing the global is enough. What this does NOT prove: a real Clerk
 * instance's keys, its token claims, or its latency. See the PR notes.
 */

const SECRET_KEY = "sk_test_throwaway_for_unit_tests_only";
const KID = "ins_test_kid";
const AUTHORIZED = "https://pqp.gg";

process.env.CLERK_SECRET_KEY = SECRET_KEY;
process.env.CLERK_AUTHORIZED_PARTIES = AUTHORIZED;
delete process.env.DEV_AUTH_BYPASS;
delete process.env.CHARACTER_ACCOUNTS_ENABLED;

const goodKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attackerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const goodJwk = {
  ...goodKeys.publicKey.export({ format: "jwk" }),
  kid: KID,
  use: "sig",
  alg: "RS256",
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface MintOptions {
  privateKey?: typeof goodKeys.privateKey;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  omit?: string[];
}

/** A Clerk-shaped session JWT: RS256, `cat` header, sub/sid/azp/iss/exp. */
function mint(options: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {
    alg: "RS256",
    typ: "JWT",
    kid: KID,
    cat: "cl_B7d4PD111AAA",
    ...options.header,
  };
  const claims: Record<string, unknown> = {
    sub: "user_real_sdk_1",
    sid: "sess_real_sdk_1",
    azp: AUTHORIZED,
    iss: "https://clerk.example.test",
    iat: now - 5,
    nbf: now - 10,
    exp: now + 60,
    ...options.claims,
  };
  for (const key of options.omit ?? []) {
    delete claims[key];
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    options.privateKey ?? goodKeys.privateKey,
  );
  return `${signingInput}.${b64url(signature)}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function userJson(id: string) {
  const ts = 1_700_000_000_000;
  return {
    object: "user",
    id,
    username: "realsdk",
    first_name: "Real",
    last_name: "Sdk",
    image_url: "https://img.example.test/real.png",
    has_image: true,
    primary_email_address_id: "idn_verified",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    banned: false,
    locked: false,
    email_addresses: [
      {
        id: "idn_verified",
        object: "email_address",
        email_address: "person@acme.example",
        verification: { status: "verified", strategy: "email_code" },
        linked_to: [],
      },
      {
        id: "idn_unverified",
        object: "email_address",
        email_address: "someone@other.example",
        verification: { status: "unverified", strategy: "email_code" },
        linked_to: [],
      },
    ],
    phone_numbers: [],
    web3_wallets: [],
    passkeys: [],
    external_accounts: [],
    enterprise_accounts: [],
    saml_accounts: [],
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    external_id: null,
    last_sign_in_at: ts,
    last_active_at: ts,
    create_organization_enabled: true,
    create_organizations_limit: null,
    delete_self_enabled: true,
    legal_accepted_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

interface Call {
  method: string;
  url: URL;
  auth: string | null;
  body: unknown;
}
const calls: Call[] = [];
let userStatus = 200;
let deleteStatus = 200;

const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : (input as URL | Request).toString());
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  calls.push({
    method,
    url,
    auth: headers.get("authorization"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  });
  if (url.hostname !== "api.clerk.com") {
    throw new Error(`unexpected host ${url.hostname}`);
  }
  if (url.pathname === "/v1/jwks") {
    return json({ keys: [goodJwk] });
  }
  if (url.pathname === "/v1/sign_in_tokens" && method === "POST") {
    return json({ object: "sign_in_token", id: "sit_1", token: "sit_secret_value", status: "pending", user_id: "user_real_sdk_1", created_at: 1, updated_at: 1 });
  }
  const userMatch = url.pathname.match(/^\/v1\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    if (userStatus !== 200) {
      return json({ errors: [{ code: "internal", message: "boom" }] }, userStatus);
    }
    return json(userJson(userMatch[1]));
  }
  if (userMatch && method === "DELETE") {
    if (deleteStatus === 404) {
      return json({ errors: [{ code: "resource_not_found", message: "User not found" }] }, 404);
    }
    if (deleteStatus !== 200) {
      return json({ errors: [{ code: "internal", message: "boom" }] }, deleteStatus);
    }
    return json({ object: "deleted_object", id: userMatch[1], deleted: true });
  }
  return json({ errors: [{ code: "not_found", message: "unstubbed" }] }, 404);
});

let verifyAuthHeader: typeof import("./clerk.js").verifyAuthHeader;
let deleteClerkUser: typeof import("./clerk.js").deleteClerkUser;
let createDesktopSignInToken: typeof import("./clerk.js").createDesktopSignInToken;
let clearAuthCaches: typeof import("./clerk.js").clearAuthCaches;

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  ({ verifyAuthHeader, deleteClerkUser, createDesktopSignInToken, clearAuthCaches } =
    await import("./clerk.js"));
});

afterEach(() => {
  clearAuthCaches();
  calls.length = 0;
  userStatus = 200;
  deleteStatus = 200;
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verifyAuthHeader through the real @clerk/backend", () => {
  it("accepts a valid session token and builds the profile from the Backend API user", async () => {
    const result = await verifyAuthHeader(`Bearer ${mint()}`);
    expect(result).toEqual({
      clerkId: "user_real_sdk_1",
      displayName: "Real Sdk",
      avatarUrl: "https://img.example.test/real.png",
      // Only the verified address contributes a domain.
      emailDomains: ["acme.example"],
    });
    const jwks = calls.find((c) => c.url.pathname === "/v1/jwks");
    expect(jwks?.auth).toBe(`Bearer ${SECRET_KEY}`);
    expect(calls.some((c) => c.url.pathname === "/v1/users/user_real_sdk_1")).toBe(true);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mint({ claims: { iat: now - 7200, nbf: now - 7200, exp: now - 3600 } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("rejects a token minted for another origin (azp)", async () => {
    const token = mint({ claims: { azp: "https://evil.example" } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("accepts a token with no azp while authorized parties are configured (native apps)", async () => {
    // @clerk/backend 3.11.1 rejects this when handed `authorizedParties`, and
    // it is exactly what clerk-ios and clerk-android tokens look like. So the
    // SDK is not handed the list; `authorizedPartyAllowed` applies it.
    const token = mint({ omit: ["azp"] });
    const result = await verifyAuthHeader(`Bearer ${token}`);
    expect(result?.clerkId).toBe("user_real_sdk_1");
  });

  it("rejects an empty azp while authorized parties are configured", async () => {
    // Absent is a native token. Present but empty is not absent.
    const token = mint({ claims: { azp: "" } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("accepts a token with no azp when no authorized parties are configured", async () => {
    const saved = process.env.CLERK_AUTHORIZED_PARTIES;
    process.env.CLERK_AUTHORIZED_PARTIES = "";
    try {
      const token = mint({ omit: ["azp"] });
      const result = await verifyAuthHeader(`Bearer ${token}`);
      expect(result?.clerkId).toBe("user_real_sdk_1");
    } finally {
      process.env.CLERK_AUTHORIZED_PARTIES = saved;
    }
  });

  it("rejects a token signed with a different key under the same kid", async () => {
    const token = mint({ privateKey: attackerKeys.privateKey });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("rejects a token with no sub", async () => {
    const token = mint({ omit: ["sub"] });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("rejects a token that is not a JWT", async () => {
    expect(await verifyAuthHeader("Bearer not-a-jwt")).toBeNull();
  });

  it("rejects a JWT with no cat header (not a session token as of @clerk/backend 3.28)", async () => {
    // Clerk-issued session tokens carry `cat`; a bare signed JWT is what a
    // test or a JWT template looks like. Pinned because a Clerk instance that
    // issued session tokens without it would be locked out by this version.
    const token = mint({ header: { cat: undefined } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("keeps an unknown profile out when the Backend API lookup fails (never invents one)", async () => {
    userStatus = 500;
    expect(await verifyAuthHeader(`Bearer ${mint()}`)).toBeNull();
  });
});

/**
 * One token per client platform, shaped exactly like the real session tokens
 * the staging (development) Clerk instance issued to each SDK on 2026-11-18,
 * decoded header and claims with only ids and times replaced:
 *
 * - web: clerk-js in a browser on the site's origin. Has `azp` = that origin.
 * - Electron: the shell loads the same site and the same clerk-js in its
 *   renderer, so its token is the web token (`azp` = the site's origin).
 * - iOS (clerk-ios 1.7.x) and Android (clerk-android 1.4.x): the Frontend API
 *   is called with `_is_native=true`, a device token and no `Origin`, and the
 *   token has NO `azp` claim. `fva` differs between the two and means nothing
 *   to us.
 *
 * Every one carries `cat: cl_B7d4PD111AAA` (the session token category), which
 * is what @clerk/backend 3.28 requires.
 */
describe("every client platform's token shape, under our options", () => {
  const SESSION_CAT = "cl_B7d4PD111AAA";
  const now = () => Math.floor(Date.now() / 1000);
  const shape = (claims: Record<string, unknown>, omit: string[] = []) =>
    mint({
      header: { cat: SESSION_CAT, oiat: now() },
      claims: {
        iss: "https://clerk.pqp.example",
        sts: "active",
        v: 2,
        iat: now(),
        nbf: now() - 10,
        exp: now() + 60,
        ...claims,
      },
      omit,
    });

  const platforms: Array<[string, () => string]> = [
    ["web (clerk-js, azp = site origin)", () => shape({ azp: AUTHORIZED, fva: [0, 0] })],
    ["Electron (same clerk-js, same origin)", () => shape({ azp: AUTHORIZED, fva: [0, 0] })],
    ["iOS (clerk-ios, no azp)", () => shape({ fva: [0, -1] }, ["azp"])],
    ["Android (clerk-android, no azp)", () => shape({ fva: [0, 0] }, ["azp"])],
  ];

  for (const [name, token] of platforms) {
    it(`accepts ${name}`, async () => {
      const result = await verifyAuthHeader(`Bearer ${token()}`);
      expect(result?.clerkId).toBe("user_real_sdk_1");
    });
  }

  it("still rejects a browser token minted for an origin that is not ours", async () => {
    const token = shape({ azp: "https://staging.pqp-3yr.pages.dev", fva: [0, 0] });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("rejects an M2M token signed by the same instance key (cat cl_B7d4PD333AAA)", async () => {
    const token = mint({ header: { cat: "cl_B7d4PD333AAA" } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });

  it("rejects the retired legacy session category (cat cl_I7d4PD111III)", async () => {
    const token = mint({ header: { cat: "cl_I7d4PD111III" } });
    expect(await verifyAuthHeader(`Bearer ${token}`)).toBeNull();
  });
});

describe("authorizedPartyAllowed", () => {
  let authorizedPartyAllowed: typeof import("./clerk.js").authorizedPartyAllowed;
  beforeAll(async () => {
    ({ authorizedPartyAllowed } = await import("./clerk.js"));
  });

  it("enforces nothing when no list is configured", () => {
    expect(authorizedPartyAllowed(undefined, undefined)).toBe(true);
    expect(authorizedPartyAllowed("https://anything.example", undefined)).toBe(true);
  });

  it("accepts a listed origin and an absent claim, refuses everything else", () => {
    const list = ["https://pqp-3yr.pages.dev", "https://pqp.gg"];
    expect(authorizedPartyAllowed("https://pqp.gg", list)).toBe(true);
    expect(authorizedPartyAllowed(undefined, list)).toBe(true);
    expect(authorizedPartyAllowed("https://evil.example", list)).toBe(false);
    expect(authorizedPartyAllowed("", list)).toBe(false);
    expect(authorizedPartyAllowed(null, list)).toBe(false);
    expect(authorizedPartyAllowed(["https://pqp.gg"], list)).toBe(false);
  });
});

describe("the other Backend API call sites", () => {
  it("deleteClerkUser treats a Clerk 404 as already deleted", async () => {
    deleteStatus = 404;
    await expect(deleteClerkUser("user_gone")).resolves.toBeUndefined();
  });

  it("deleteClerkUser lets any other Clerk failure abort the deletion", async () => {
    deleteStatus = 500;
    await expect(deleteClerkUser("user_broken")).rejects.toBeDefined();
  });

  it("deleteClerkUser succeeds on a normal delete", async () => {
    await expect(deleteClerkUser("user_ok")).resolves.toBeUndefined();
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url.pathname).toBe("/v1/users/user_ok");
  });

  it("createDesktopSignInToken sends the user and the 90 second expiry, and returns the token", async () => {
    const token = await createDesktopSignInToken("user_real_sdk_1");
    expect(token).toBe("sit_secret_value");
    const post = calls.find((c) => c.url.pathname === "/v1/sign_in_tokens");
    expect(post?.body).toMatchObject({ user_id: "user_real_sdk_1", expires_in_seconds: 90 });
  });
});
