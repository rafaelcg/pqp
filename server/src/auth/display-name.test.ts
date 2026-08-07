import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * An email address must never become somebody's public name.
 *
 * The chain in `loadProfile` used to end
 * `fullName ?? username ?? primaryEmailAddress?.emailAddress ?? "User"`. A Clerk
 * account with no name set — which is every account created by "continue with
 * email" — fell straight through to the address, which was then rendered as the
 * author of every message, shown in the voice roster, written into
 * `users.display_name`, and slugified into the handle other people type to
 * mention them. Confirmed in production: `rafaelcg@gmail.com`, handle
 * `rafaelcg_gmail_com#8683`.
 *
 * These tests drive the real `verifyAuthHeader` with a stubbed Clerk so the
 * fallback chain is exercised where it actually lives, rather than restated.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
// The Clerk path is the one under test, so the dev bypass must not short it.
process.env.DEV_AUTH_BYPASS = "false";

interface FakeClerkProfile {
  fullName: string | null;
  username: string | null;
  imageUrl: string | null;
  emailAddresses: { emailAddress: string; verification: { status: string } }[];
}

const profiles = new Map<string, FakeClerkProfile>();

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: async (id: string) => {
        const profile = profiles.get(id);
        if (!profile) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        return profile;
      },
    },
  }),
  // The token *is* the Clerk id here; verification itself is not under test.
  verifyToken: async (token: string) => ({ sub: token }),
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { verifyAuthHeader, clearAuthCaches } = await import("./clerk.js");
const { upsertUser, slugifyUsername, placeholderDisplayName } = await import(
  "../services/users.js"
);

const ADDRESS = "rafaelcg@gmail.com";

/** An account whose only identifying field is its email address. */
function emailOnly(clerkId: string, address = ADDRESS): string {
  profiles.set(clerkId, {
    fullName: null,
    username: null,
    imageUrl: null,
    emailAddresses: [
      { emailAddress: address, verification: { status: "verified" } },
    ],
  });
  return `Bearer ${clerkId}`;
}

describe("the public display name of a Clerk profile", () => {
  beforeEach(() => {
    profiles.clear();
    clearAuthCaches();
  });

  it("uses the placeholder, not the address, when no name is set", async () => {
    const auth = await verifyAuthHeader(emailOnly("user_emailonly"));

    expect(auth).not.toBeNull();
    expect(auth!.displayName).toBe(placeholderDisplayName("user_emailonly"));
    // Not the local part either — `rafaelcg` is most of the address.
    expect(auth!.displayName).not.toMatch(/rafaelcg|gmail/i);
  });

  /**
   * The regression that would reintroduce this through a field nobody watches:
   * `fullName` is whatever the identity provider put in first/last name, and a
   * SAML connection that maps the address into one of them is ordinary.
   */
  it("screens an address that arrives through fullName", async () => {
    profiles.set("user_saml", {
      fullName: ADDRESS,
      username: null,
      imageUrl: null,
      emailAddresses: [
        { emailAddress: ADDRESS, verification: { status: "verified" } },
      ],
    });

    const auth = await verifyAuthHeader("Bearer user_saml");
    expect(auth!.displayName).toBe(placeholderDisplayName("user_saml"));
  });

  it("still prefers a real name, then the Clerk username", async () => {
    profiles.set("user_named", {
      fullName: "João Gonçalves",
      username: "joaog",
      imageUrl: null,
      emailAddresses: [
        { emailAddress: ADDRESS, verification: { status: "verified" } },
      ],
    });
    profiles.set("user_handle", {
      fullName: null,
      username: "joaog",
      imageUrl: null,
      emailAddresses: [
        { emailAddress: ADDRESS, verification: { status: "verified" } },
      ],
    });

    expect((await verifyAuthHeader("Bearer user_named"))!.displayName).toBe(
      "João Gonçalves",
    );
    expect((await verifyAuthHeader("Bearer user_handle"))!.displayName).toBe(
      "joaog",
    );
  });

  /**
   * The *domain* is a different thing from the address and is still carried: it
   * drives SSO domain joins, and it is what the privacy policy says pqp holds.
   * The domain is a group the account belongs to; the local part is who they
   * are.
   */
  it("keeps the verified email domain", async () => {
    const auth = await verifyAuthHeader(emailOnly("user_domain"));
    expect(auth!.emailDomains).toEqual(["gmail.com"]);
  });
});

describeDb("the handle derived for an email-only account", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    profiles.clear();
    clearAuthCaches();
  });

  afterAll(async () => {
    await closePool();
  });

  it("puts no part of the address in the stored row or the handle", async () => {
    const auth = await verifyAuthHeader(emailOnly("user_stored"));
    const user = await upsertUser(auth!);

    expect(user.display_name).toBe(placeholderDisplayName("user_stored"));
    expect(user.username).toBe(slugifyUsername(user.display_name));
    expect(`${user.display_name} ${user.username}`).not.toMatch(
      /rafaelcg|gmail/i,
    );
    expect(user.discriminator).toMatch(/^\d{4}$/);
  });

  it("gives two nameless accounts handles they can be told apart by", async () => {
    const a = await upsertUser(
      (await verifyAuthHeader(emailOnly("user_a", "a@example.com")))!,
    );
    const b = await upsertUser(
      (await verifyAuthHeader(emailOnly("user_b", "b@example.com")))!,
    );

    expect(`${a.username}#${a.discriminator}`).not.toBe(
      `${b.username}#${b.discriminator}`,
    );
    expect(a.display_name).not.toBe(b.display_name);
  });
});
