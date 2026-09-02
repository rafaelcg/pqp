import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Account creation, pinned.
 *
 * Everything here is a regression test for a way the signup path could refuse
 * to create an account — the one failure the product cannot absorb, because a
 * user who cannot get in has no second screen to try. Two of the three only
 * misbehave under concurrency or at the far end of a namespace, which is to say
 * on launch day and not before.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts. Set it to point the
// suite at a scratch database instead of the one `pnpm dev` is using.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  slugifyUsername,
  looksLikeEmailAddress,
  placeholderDisplayName,
  upsertUser,
  updateProfile,
  resolveMemberName,
  setMemberNickname,
} = await import("./users.js");

/**
 * The privacy bug, in one place.
 *
 * The display-name chain in auth/clerk.ts used to fall through to the account's
 * primary email address, so a Clerk account with no name set was published as
 * `rafaelcg@gmail.com` — as the author of every message, in the voice roster,
 * and, slugified, as the handle other people type to mention them. Everything
 * below is a regression test for one of the three ways that address escaped.
 */
describe("looksLikeEmailAddress", () => {
  it("recognises a bare address", () => {
    expect(looksLikeEmailAddress("rafaelcg@gmail.com")).toBe(true);
    expect(looksLikeEmailAddress("  rafaelcg@gmail.com  ")).toBe(true);
    expect(looksLikeEmailAddress("a.b+tag@mail.co.uk")).toBe(true);
    expect(looksLikeEmailAddress("RAFAELCG@GMAIL.COM")).toBe(true);
  });

  /**
   * The expensive direction. A false positive here throws away a name somebody
   * chose, so every shape that merely *contains* an `@` has to survive.
   */
  it("leaves a legitimate name that merely contains an @ alone", () => {
    expect(looksLikeEmailAddress("Dave @ Acme")).toBe(false);
    expect(looksLikeEmailAddress("@rafa")).toBe(false);
    expect(looksLikeEmailAddress("M@rio")).toBe(false);
    expect(looksLikeEmailAddress("meet me @ 5.30")).toBe(false);
    expect(looksLikeEmailAddress("Ana Paula")).toBe(false);
    expect(looksLikeEmailAddress("@")).toBe(false);
    expect(looksLikeEmailAddress("")).toBe(false);
  });
});

describe("placeholderDisplayName", () => {
  it("discloses nothing and is stable for one account", () => {
    const name = placeholderDisplayName("user_3Hawgga");
    expect(name).toMatch(/^User [0-9a-f]{4}$/);
    expect(placeholderDisplayName("user_3Hawgga")).toBe(name);
    // Not a slice of the Clerk id — a hash of it.
    expect(name).not.toContain("Hawgga");
  });

  it("does not collapse every nameless account into one string", () => {
    const names = new Set(
      Array.from({ length: 50 }, (_, i) => placeholderDisplayName(`user_${i}`)),
    );
    expect(names.size).toBeGreaterThan(45);
  });
});

describe("slugifyUsername", () => {
  /**
   * The case the Brazilian launch turns on. Before the NFD fold these produced
   * `jo_o`, `gon_alves` and `a_o` — assigned silently, never shown to the person
   * they belonged to.
   */
  it("folds accents to the base letter instead of punching holes", () => {
    expect(slugifyUsername("João")).toBe("joao");
    expect(slugifyUsername("Gonçalves")).toBe("goncalves");
    expect(slugifyUsername("Ação")).toBe("acao");
    expect(slugifyUsername("Müller")).toBe("muller");
    expect(slugifyUsername("Renée")).toBe("renee");
  });

  it("leaves an already-clean handle alone", () => {
    expect(slugifyUsername("rafael")).toBe("rafael");
    expect(slugifyUsername("user_42")).toBe("user_42");
  });

  it("collapses real separators to a single underscore", () => {
    expect(slugifyUsername("Ana Paula")).toBe("ana_paula");
    expect(slugifyUsername("ana...paula")).toBe("ana_paula");
  });

  it("never returns a leading or trailing underscore, even after truncating", () => {
    expect(slugifyUsername("  spaced  ")).toBe("spaced");
    // 30 chars then a separator: the cut at 32 lands on the underscore, which
    // is exactly the case trimming-before-slicing used to miss.
    const slug = slugifyUsername(`${"a".repeat(30)} bcdef`);
    expect(slug.startsWith("_")).toBe(false);
    expect(slug.endsWith("_")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  /**
   * `rafaelcg@gmail.com` used to slug to `rafaelcg_gmail_com` — the address with
   * two characters changed, handed out as the handle people type to mention
   * them. There is nothing safe to keep from an address, so nothing is kept.
   */
  it("refuses to build a handle out of an email address", () => {
    const slug = slugifyUsername("rafaelcg@gmail.com");
    expect(slug).toMatch(/^user_[a-z0-9]+$/);
    expect(slug).not.toContain("rafaelcg");
    expect(slug).not.toContain("gmail");
  });

  it("still slugs a name that only contains an @", () => {
    expect(slugifyUsername("Dave @ Acme")).toBe("dave_acme");
  });

  it("falls back rather than returning something unusable", () => {
    // Nothing survives the filter, so a generated handle is the only option.
    expect(slugifyUsername("🎮🎮").length).toBeGreaterThanOrEqual(2);
    expect(slugifyUsername("")).toMatch(/^user_/);
  });
});

describeDb("account creation", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  it("gives an accented display name a readable handle", async () => {
    const user = await upsertUser({
      clerkId: "clerk-joao",
      displayName: "João Gonçalves",
      avatarUrl: null,
    });
    expect(user.username).toBe("joao_goncalves");
    expect(user.discriminator).toMatch(/^\d{4}$/);
  });

  /**
   * The 500-on-first-request bug. The client authenticates over HTTP and opens
   * its WebSocket at almost the same moment, so a brand-new account really does
   * arrive here twice at once; before `ON CONFLICT` the loser threw on the
   * `clerk_id` unique index and the account's very first request failed.
   */
  it("survives two concurrent first sightings of the same account", async () => {
    const auth = {
      clerkId: "clerk-race",
      displayName: "Maria",
      avatarUrl: null,
    };
    const [a, b] = await Promise.all([upsertUser(auth), upsertUser(auth)]);

    expect(a.id).toBe(b.id);
    const count = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM users WHERE clerk_id = $1`,
      ["clerk-race"],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("gives everyone a distinct handle when many sign up as the same name", async () => {
    const users = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertUser({
          clerkId: `clerk-dup-${i}`,
          displayName: "Pedro",
          avatarUrl: null,
        }),
      ),
    );
    const tags = new Set(users.map((u) => `${u.username}#${u.discriminator}`));
    expect(tags.size).toBe(12);
    expect(users.every((u) => u.username === "pedro")).toBe(true);
  });

  /**
   * The one that only bites a popular name. Random probing used to give up after
   * 40 tries and throw, so once a slug filled — `joao`, `maria`, `pedro` are the
   * realistic candidates — signup broke permanently for everyone who shared it,
   * with no way for the user to choose something else.
   */
  it("still creates the account when a name's 9,999 numbers are gone", async () => {
    await getPool().query(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       SELECT 'seed-' || d, 'Seed', 'joao', lpad(d::text, 4, '0')
       FROM generate_series(1, 9999) AS d`,
    );

    const user = await upsertUser({
      clerkId: "clerk-overflow",
      displayName: "João",
      avatarUrl: null,
    });

    expect(user.username).not.toBeNull();
    expect(user.discriminator).toMatch(/^\d{4}$/);
    // The base is exhausted, so it must have widened rather than failed.
    expect(user.username).toMatch(/^joao_/);
  });

  /**
   * The regression that a correctness fix introduced.
   *
   * The exhaustion fallback used to sweep from 1 and return the lowest free
   * number, so every concurrent signup reaching it chose the same one: one won
   * the unique index and the rest burned a retry and collided again on exactly
   * the same value. Measured at 13% of 512 concurrent signups failing outright.
   * Randomising the pick is what makes the caller's retry worth having.
   */
  it("does not collide when many signups share a nearly-full name", async () => {
    // Leave 40 numbers free, well past the point where random probing alone
    // stops finding one, so every request lands on the fallback path.
    await getPool().query(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       SELECT 'seed-' || d, 'Seed', 'joao', lpad(d::text, 4, '0')
       FROM generate_series(1, 9959) AS d`,
    );

    const users = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        upsertUser({
          clerkId: `clerk-crowd-${i}`,
          displayName: "João",
          avatarUrl: null,
        }),
      ),
    );

    expect(users).toHaveLength(30);
    const tags = new Set(users.map((u) => `${u.username}#${u.discriminator}`));
    expect(tags.size).toBe(30);
  });

  it("keeps the existing number across a rename when it is still free", async () => {
    const user = await upsertUser({
      clerkId: "clerk-rename",
      displayName: "Lucas",
      avatarUrl: null,
    });
    const original = user.discriminator;

    const renamed = await updateProfile(user.id, { username: "lucas_silva" });
    expect(renamed.username).toBe("lucas_silva");
    expect(renamed.discriminator).toBe(original);
  });

  it("moves to a free number when the requested pair is taken", async () => {
    const first = await upsertUser({
      clerkId: "clerk-a",
      displayName: "Bruno",
      avatarUrl: null,
    });
    const second = await upsertUser({
      clerkId: "clerk-b",
      displayName: "Carlos",
      avatarUrl: null,
    });

    // Force the collision: ask for a username already held under `second`'s
    // number by renaming into it.
    await updateProfile(second.id, { username: "shared_name" });
    const moved = await updateProfile(first.id, { username: "shared_name" });

    expect(moved.username).toBe("shared_name");
    expect(moved.discriminator).not.toBe(second.discriminator);
  });
});

/**
 * The `pqp-email-scrub` block in schema.sql — the half of the fix that reaches
 * rows already written. Fixing the code path stops new addresses being stored;
 * it does nothing for the ones already rendered as somebody's name.
 */
describeDb("the email scrub migration", () => {
  /** Re-arm the migration by dropping the fingerprint, then run schema.sql. */
  async function runMigration(): Promise<void> {
    await getPool().query(`COMMENT ON COLUMN users.display_name IS NULL`);
    await initDb();
  }

  async function seed(row: {
    clerkId: string;
    displayName: string;
    username: string | null;
    discriminator?: string;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       VALUES ($1, $2, $3, $4)`,
      [row.clerkId, row.displayName, row.username, row.discriminator ?? "0001"],
    );
  }

  async function read(clerkId: string) {
    const result = await getPool().query<{
      display_name: string;
      username: string | null;
      discriminator: string | null;
    }>(
      `SELECT display_name, username, discriminator FROM users WHERE clerk_id = $1`,
      [clerkId],
    );
    return result.rows[0]!;
  }

  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    // Leave the fingerprint in place so the next suite's initDb() is a no-op.
    await initDb();
    await closePool();
  });

  it("rewrites the contaminated row exactly as the code path would have", async () => {
    await seed({
      clerkId: "user_3Hawgga",
      displayName: "rafaelcguk@gmail.com",
      username: "rafaelcguk_gmail_com",
      discriminator: "9031",
    });

    await runMigration();

    const row = await read("user_3Hawgga");
    // Identical to what a signup after the fix produces for this account, so a
    // scrubbed row is indistinguishable from a fresh one.
    expect(row.display_name).toBe(placeholderDisplayName("user_3Hawgga"));
    expect(row.username).toBe(slugifyUsername(row.display_name));
    // The whole point: no fragment of the address survives in either field.
    expect(`${row.display_name} ${row.username}`).not.toMatch(/rafaelcguk|gmail/);
    // The number is half a handle people have already shared; it is not re-rolled.
    expect(row.discriminator).toBe("9031");
  });

  it("leaves a legitimate name that contains an @ untouched", async () => {
    await seed({
      clerkId: "user_atsign",
      displayName: "Dave @ Acme",
      username: "dave_acme",
      discriminator: "0042",
    });

    await runMigration();

    const row = await read("user_atsign");
    expect(row.display_name).toBe("Dave @ Acme");
    expect(row.username).toBe("dave_acme");
  });

  /**
   * A handle the person chose is the name others already know them by, so a
   * contaminated display name is not licence to rewrite it. Only a handle that
   * is character-for-character what `slugifyUsername` would have made of that
   * address is treated as derived.
   */
  it("keeps a hand-picked handle even on a contaminated row", async () => {
    await seed({
      clerkId: "user_picked",
      displayName: "someone@example.com",
      username: "starfall",
      discriminator: "0007",
    });

    await runMigration();

    const row = await read("user_picked");
    expect(row.display_name).toBe(placeholderDisplayName("user_picked"));
    expect(row.username).toBe("starfall");
  });

  it("keeps two scrubbed accounts on distinct handles", async () => {
    await seed({
      clerkId: "user_one",
      displayName: "one@example.com",
      username: "one_example_com",
      discriminator: "0001",
    });
    await seed({
      clerkId: "user_two",
      displayName: "two@example.com",
      username: "two_example_com",
      discriminator: "0002",
    });

    await runMigration();

    const a = await read("user_one");
    const b = await read("user_two");
    expect(`${a.username}#${a.discriminator}`).not.toBe(
      `${b.username}#${b.discriminator}`,
    );
  });

  /**
   * schema.sql runs on EVERY boot, so "the predicate matches nothing the second
   * time" is not enough on its own. Somebody who deliberately sets their own
   * address as their display name must not have it silently rewritten by the
   * next deploy — which is what the fingerprint, not the predicate, prevents.
   */
  it("does not run again once the fingerprint is in place", async () => {
    await seed({
      clerkId: "user_again",
      displayName: "first@example.com",
      username: "first_example_com",
      discriminator: "0003",
    });

    await runMigration();
    expect((await read("user_again")).display_name).toBe(
      placeholderDisplayName("user_again"),
    );

    // Put an address back by hand — as a user editing their own profile would —
    // and boot again without re-arming.
    await getPool().query(
      `UPDATE users SET display_name = $2 WHERE clerk_id = $1`,
      ["user_again", "chosen@example.com"],
    );
    await initDb();

    expect((await read("user_again")).display_name).toBe("chosen@example.com");
  });
});

describeDb("resolveMemberName", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function member(): Promise<{ serverId: string; user: { id: string; display_name: string } }> {
    const user = await upsertUser({
      clerkId: `clerk-${Math.random()}`,
      displayName: "Rafael Cammarano",
      avatarUrl: null,
    });
    const { createServer } = await import("./servers.js");
    const created = await createServer("Mesa", user.id);
    return {
      serverId: created.server.id,
      user: { id: user.id, display_name: user.display_name },
    };
  }

  it("prefers the nickname set in that server", async () => {
    const { serverId, user } = await member();
    expect(await resolveMemberName(serverId, user)).toBe("Rafael Cammarano");

    await setMemberNickname(serverId, user.id, "Qriox");
    expect(await resolveMemberName(serverId, user)).toBe("Qriox");
  });

  it("falls back to the account name for a blank nickname or none at all", async () => {
    const { serverId, user } = await member();
    await setMemberNickname(serverId, user.id, "   ");
    expect(await resolveMemberName(serverId, user)).toBe("Rafael Cammarano");

    await setMemberNickname(serverId, user.id, null);
    expect(await resolveMemberName(serverId, user)).toBe("Rafael Cammarano");
  });

  it("has no nickname to apply outside a server", async () => {
    const { serverId, user } = await member();
    await setMemberNickname(serverId, user.id, "Qriox");
    // A conversation call belongs to no server.
    expect(await resolveMemberName(null, user)).toBe("Rafael Cammarano");
  });
});
