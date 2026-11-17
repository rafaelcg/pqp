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

  it("rejects a token with no azp while authorized parties are configured", async () => {
    // Behaviour that CHANGED across the major bump: 1.x let a missing azp
    // through. Pinned so the next bump cannot silently flip it back.
    const token = mint({ omit: ["azp"] });
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
