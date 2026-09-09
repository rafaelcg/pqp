import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CUSTOM_STATUS_MAX_LENGTH } from "@pqp/shared";

/**
 * O recado, against a real database.
 *
 * Every assertion here is something a mocked pool would have agreed with while
 * production disagreed:
 *
 *   * THE THREE-STATE WRITE. Absent leaves it alone, null clears it, a string
 *     sets it. That distinction lives in a `CASE WHEN $8` in one UPDATE and in
 *     nothing else, so it can only be checked by running the UPDATE. Getting it
 *     wrong in the obvious way (COALESCE, like `display_name`) makes clearing
 *     impossible; getting it wrong in the other obvious way (a plain `= $8`)
 *     wipes somebody's recado every time they change their avatar.
 *   * IT COMES BACK ON THE MEMBER LIST. The roster query is hand-written SQL
 *     with an explicit column list, and a column left out of it is a feature
 *     that renders nowhere while every unit test passes.
 *   * THE CHECK CONSTRAINT ACTUALLY CONSTRAINS. It is the last line of defence
 *     for a value the API validates, and a constraint that never rejects
 *     anything is a comment.
 *   * THE CAP IN SQL IS THE CAP IN TYPESCRIPT. Two hand-written numbers that
 *     must agree, exactly like `HANDLE_PATTERN_SQL` and `HANDLE_PATTERN`.
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, updateProfile, listServerMembers, toPublicUserSummary } =
  await import("./users.js");
const { createServer } = await import("./servers.js");

const schemaSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"),
  "utf8",
);

describe("the cap in schema.sql", () => {
  it("is the same number CUSTOM_STATUS_MAX_LENGTH carries", () => {
    // The CHECK is written by hand in SQL and the API validates against the
    // constant. If the two drift, one of them stops defending anything: a
    // smaller SQL cap turns a valid save into a 500, and a larger one means
    // the column silently accepts what no client can draw.
    const match = /char_length\(custom_status\) <= (\d+)/.exec(schemaSql);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(CUSTOM_STATUS_MAX_LENGTH);
  });
});

describeDb("custom_status", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function freshUser(clerkId: string, displayName = "Ana") {
    return upsertUser({ clerkId, displayName, avatarUrl: null });
  }

  async function storedStatus(userId: string): Promise<string | null> {
    const result = await getPool().query<{ custom_status: string | null }>(
      `SELECT custom_status FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0]!.custom_status;
  }

  it("starts as null, which is what almost every account will ever have", async () => {
    const user = await freshUser("clerk_none");
    expect(await storedStatus(user.id)).toBeNull();
    expect(user.custom_status ?? null).toBeNull();
  });

  it("stores what was set and hands it back on the row", async () => {
    const user = await freshUser("clerk_set");
    const updated = await updateProfile(user.id, {
      customStatus: "no gym, volto as 20h",
    });
    expect(updated.custom_status).toBe("no gym, volto as 20h");
    expect(await storedStatus(user.id)).toBe("no gym, volto as 20h");
  });

  it("leaves it alone when the key is absent", async () => {
    // The exact bug a COALESCE-free `= $8` would introduce: changing an avatar
    // must not clear a recado the request never mentioned.
    const user = await freshUser("clerk_absent");
    await updateProfile(user.id, { customStatus: "jogando valorant" });
    const updated = await updateProfile(user.id, {
      avatarUrl: "https://example.test/a.png",
    });
    expect(updated.custom_status).toBe("jogando valorant");
  });

  it("clears it on an explicit null", async () => {
    // The exact bug a COALESCE would introduce: with one, this is a no-op and
    // there is no way to take a recado down at all.
    const user = await freshUser("clerk_clear");
    await updateProfile(user.id, { customStatus: "brb" });
    const updated = await updateProfile(user.id, { customStatus: null });
    expect(updated.custom_status).toBeNull();
    expect(await storedStatus(user.id)).toBeNull();
  });

  it("stores an empty string as null, so there is one way to say nothing", async () => {
    const user = await freshUser("clerk_empty");
    await updateProfile(user.id, { customStatus: "brb" });
    const updated = await updateProfile(user.id, { customStatus: "" });
    expect(updated.custom_status).toBeNull();
  });

  it("keeps emoji intact through the column", async () => {
    // A ZWJ family and an astral-plane skull. Postgres counts both as one
    // character each, which is what makes the SQL cap agree with the
    // TypeScript one; a mangled round trip here would mean the opposite.
    const user = await freshUser("clerk_emoji");
    const recado = "\u{1f480} \u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
    const updated = await updateProfile(user.id, { customStatus: recado });
    expect(updated.custom_status).toBe(recado);
  });

  it("accepts a full line of emoji, which a byte-counted cap would refuse", async () => {
    const user = await freshUser("clerk_full");
    const skulls = "\u{1f480}".repeat(CUSTOM_STATUS_MAX_LENGTH);
    const updated = await updateProfile(user.id, { customStatus: skulls });
    expect(updated.custom_status).toBe(skulls);
  });

  it("refuses an over-long value at the database, not only at the API", async () => {
    const user = await freshUser("clerk_long");
    await expect(
      getPool().query(`UPDATE users SET custom_status = $2 WHERE id = $1`, [
        user.id,
        "a".repeat(CUSTOM_STATUS_MAX_LENGTH + 1),
      ]),
    ).rejects.toThrow();
  });

  it("refuses a newline at the database", async () => {
    // The row is drawn on one line. A stored newline is a value no surface can
    // render honestly, so the column refuses it even if a caller skipped the
    // API's normalisation.
    const user = await freshUser("clerk_newline");
    await expect(
      getPool().query(`UPDATE users SET custom_status = $2 WHERE id = $1`, [
        user.id,
        "volto\nas 22h",
      ]),
    ).rejects.toThrow();
  });

  it("comes back on the member list, which is the surface it was built for", async () => {
    const owner = await freshUser("clerk_owner", "Rafa");
    await updateProfile(owner.id, { customStatus: "no gym" });
    const { server } = await createServer("QG", owner.id);

    const members = await listServerMembers(server.id);
    const row = members.find((member) => member.id === owner.id);
    expect(row?.customStatus).toBe("no gym");
  });

  it("is null on the member list for somebody who never wrote one", async () => {
    // Null rather than undefined or "": the row draws one line instead of
    // reserving space for a blank second one.
    const owner = await freshUser("clerk_quiet", "Bia");
    const { server } = await createServer("Sala", owner.id);
    const members = await listServerMembers(server.id);
    expect(members[0]!.customStatus).toBeNull();
  });

  it("rides the public user shape, which is how a DM row draws it", async () => {
    const user = await freshUser("clerk_public");
    await updateProfile(user.id, { customStatus: "so na call" });
    const result = await getPool().query(
      `SELECT id, display_name, username, discriminator, avatar_url, custom_status
         FROM users WHERE id = $1`,
      [user.id],
    );
    expect(toPublicUserSummary(result.rows[0]!).customStatus).toBe("so na call");
  });
});
