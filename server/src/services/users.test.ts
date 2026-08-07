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
const { slugifyUsername, upsertUser, updateProfile } = await import("./users.js");

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
