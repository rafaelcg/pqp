import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * SEARCH PAGINATION MUST NOT DROP A RESULT, which is what
 * `paginates without repeating or skipping a result` in `api.test.ts` has been
 * saying, correctly, about twice in five runs.
 *
 * That was not a flaky test. The cursor was built from `last.created_at`, a JS
 * `Date`, which holds milliseconds; `timestamptz` stores microseconds. Every
 * cursor was therefore truncated downward, and because the page predicate is a
 * strict row comparison against the same tuple the ordering uses, every
 * equally-ranked row inside the boundary's millisecond compared GREATER than
 * the cursor and was dropped from the next page and from every page after it.
 * Skip-only, never a duplicate, and `hasMore` still reported the list
 * complete: an omission nobody can see.
 *
 * These fix the timestamps rather than racing for them, so the failure is
 * deterministic instead of two-in-five.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { searchMessages, decodeSearchCursor } = await import("./search.js");

describeDb("search pagination across a sub-millisecond boundary", () => {
  let author: { id: string };
  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    author = await upsertUser({
      clerkId: "clerk_search_cursor",
      displayName: "Ana",
      avatarUrl: null,
    });
    const created = await createServer("Servidor", author.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
  });

  /** Identical bodies, so every row ties on rank and the tiebreakers decide. */
  async function seedAt(...stamps: string[]): Promise<void> {
    for (const at of stamps) {
      await getPool().query(
        `INSERT INTO messages (channel_id, author_id, body, created_at)
         VALUES ($1, $2, 'lontra', $3::timestamptz)`,
        [channelId, author.id, at],
      );
    }
  }

  /** Walk every page the way a client does, and report what it saw. */
  async function paginate(limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await searchMessages(
        serverId,
        author.id,
        "lontra",
        limit,
        cursor ? (decodeSearchCursor(cursor) ?? undefined) : undefined,
      );
      seen.push(...res.results.map((r) => r.messageId));
      if (!res.hasMore || !res.nextCursor) {
        return seen;
      }
      cursor = res.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }

  async function allIds(): Promise<string[]> {
    const rows = await getPool().query<{ id: string }>(
      `SELECT id FROM messages`,
    );
    return rows.rows.map((r) => r.id);
  }

  it("returns every row when three share one millisecond", async () => {
    // The reproduction, exactly: one millisecond, three rows, tied rank.
    // Before the fix this returned ONE and said hasMore: false.
    await seedAt(
      "2026-01-01T12:00:00.500900Z",
      "2026-01-01T12:00:00.500500Z",
      "2026-01-01T12:00:00.500100Z",
    );

    const seen = await paginate(1);

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual((await allIds()).sort());
  });

  it("puts the page boundary itself inside a shared millisecond", async () => {
    // Four rows, two pages of two: the boundary lands between rows that share
    // a millisecond, which is the case the truncation actually mangled.
    await seedAt(
      "2026-02-02T09:30:00.250800Z",
      "2026-02-02T09:30:00.250400Z",
      "2026-02-02T09:30:00.250200Z",
      "2026-02-02T09:30:00.100000Z",
    );

    const seen = await paginate(2);

    expect(seen).toHaveLength(4);
    expect([...seen].sort()).toEqual((await allIds()).sort());
  });

  it("never returns the same row twice", async () => {
    // The other half of the guarantee, and the direction a lazier fix trades
    // into: widening the comparison to absorb the truncation would turn a
    // silent skip into a visible duplicate.
    await seedAt(
      "2026-03-03T08:00:00.750999Z",
      "2026-03-03T08:00:00.750998Z",
      "2026-03-03T08:00:00.750997Z",
      "2026-03-03T08:00:00.750996Z",
      "2026-03-03T08:00:00.750995Z",
    );

    const seen = await paginate(1);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
  });

  it("carries microseconds in the cursor rather than a rounded millisecond", async () => {
    await seedAt(
      "2026-04-04T07:00:00.123456Z",
      "2026-04-04T07:00:00.123123Z",
    );

    const first = await searchMessages(serverId, author.id, "lontra", 1);
    const cursor = decodeSearchCursor(first.nextCursor!);

    // The value that goes out has to be the value the row is ordered by. A
    // `Date` cannot hold this, which is the entire bug in one assertion.
    expect(cursor?.createdAt).toBe("2026-04-04T07:00:00.123456Z");
  });

  it("still accepts a millisecond cursor issued before this change", async () => {
    // A client mid-pagination across the deploy presents the old shape. It
    // must page, not 400.
    await seedAt("2026-05-05T06:00:00.400000Z", "2026-05-05T06:00:00.300000Z");
    const rows = await getPool().query<{ id: string }>(
      `SELECT id FROM messages ORDER BY created_at DESC`,
    );

    // The real cursor this build issues, rewritten into the shape the old one
    // had: same rank, same id, timestamp rounded down to milliseconds. Taking
    // the rank from a live page rather than inventing one is the difference
    // between exercising the decoder and exercising a number nothing ranks at.
    const first = await searchMessages(serverId, author.id, "lontra", 1);
    const fresh = decodeSearchCursor(first.nextCursor!)!;
    const legacy = Buffer.from(
      `${fresh.rank}|${new Date(fresh.createdAt).toISOString()}|${fresh.id}`,
      "utf8",
    ).toString("base64url");
    expect(new Date(fresh.createdAt).toISOString()).toBe(
      "2026-05-05T06:00:00.400Z",
    );

    const decoded = decodeSearchCursor(legacy);
    expect(decoded).not.toBeNull();
    const res = await searchMessages(
      serverId,
      author.id,
      "lontra",
      10,
      decoded!,
    );
    expect(res.results.map((r) => r.messageId)).toEqual([rows.rows[1]!.id]);
  });
});
