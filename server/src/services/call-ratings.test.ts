import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Prompted call quality, pinned against a real database.
 *
 * Two things here are rules rather than plumbing, and both live where a mocked
 * pool would never exercise them: a note is only kept on a low score, enforced
 * in the INSERT rather than trusted from the client, and the summary is an
 * aggregate that must stay correct when the table is empty, when one transport
 * has no rows, and when a rating's author later deletes their account.
 */

// TEST_DATABASE_URL wins; see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { callRatingSummary, recordCallRating } = await import(
  "./call-ratings.js"
);

describeDb("call ratings", () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE call_ratings RESTART IDENTITY CASCADE`);
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closePool();
  });

  async function rater(clerkId: string) {
    return upsertUser({ clerkId, displayName: "Ana", avatarUrl: null });
  }

  function input(rating: number, extra: Record<string, unknown> = {}) {
    return {
      rating,
      durationSeconds: 300,
      peerCount: 2,
      transport: "mesh" as const,
      hadScreenShare: false,
      ...extra,
    };
  }

  it("summarises an empty table without dividing by zero", async () => {
    const summary = await callRatingSummary(7);
    expect(summary.total).toBe(0);
    expect(summary.average).toBeNull();
    expect(summary.distribution).toEqual({});
    expect(summary.byTransport).toEqual([]);
    expect(summary.recentNotes).toEqual([]);
  });

  it("averages and counts what it was given", async () => {
    const user = await rater("clerk-a");
    for (const rating of [5, 4, 3]) {
      await recordCallRating(user.id, input(rating));
    }
    const summary = await callRatingSummary(7);
    expect(summary.total).toBe(3);
    expect(summary.average).toBe(4);
    expect(summary.distribution).toEqual({ "3": 1, "4": 1, "5": 1 });
  });

  it("keeps a note on a low score and drops one on a high score", async () => {
    // The rule the client also follows, enforced here because this is the only
    // place it cannot be bypassed. A note on a 5 is a compliment, and keeping
    // it would stop the operator's note list being a list of problems.
    const user = await rater("clerk-b");
    await recordCallRating(user.id, input(2, { note: "voz cortando" }));
    await recordCallRating(user.id, input(5, { note: "muito bom" }));

    const summary = await callRatingSummary(7);
    expect(summary.recentNotes).toHaveLength(1);
    expect(summary.recentNotes[0]!.note).toBe("voz cortando");
    expect(summary.recentNotes[0]!.rating).toBe(2);
  });

  it("keeps mesh and the SFU apart so they can be compared", async () => {
    // The entire reason transport is on the row: an average that mixes them
    // cannot answer whether the SFU is actually better.
    const user = await rater("clerk-c");
    await recordCallRating(user.id, input(2, { transport: "mesh" }));
    await recordCallRating(user.id, input(4, { transport: "mesh" }));
    await recordCallRating(user.id, input(5, { transport: "livekit" }));

    const summary = await callRatingSummary(7);
    const byTransport = Object.fromEntries(
      summary.byTransport.map((row) => [row.transport, row]),
    );
    expect(byTransport.mesh).toMatchObject({ total: 2, average: 3 });
    expect(byTransport.livekit).toMatchObject({ total: 1, average: 5 });
  });

  it("outlives the account that wrote it", async () => {
    // ON DELETE SET NULL, not CASCADE: a rating from somebody who later
    // deleted their account is still a true thing about how the product
    // performed that day, and dropping it would quietly flatter the average.
    const user = await rater("clerk-d");
    await recordCallRating(user.id, input(1, { note: "nao conectou" }));
    await getPool().query(`DELETE FROM users WHERE id = $1`, [user.id]);

    const summary = await callRatingSummary(7);
    expect(summary.total).toBe(1);
    expect(summary.average).toBe(1);
    expect(summary.recentNotes).toHaveLength(1);
  });

  it("stores mediaQuality and returns it on the note it rides beside", async () => {
    // The dashboard only ever sees media quality next to a note, because a
    // note only exists on a rating of 3 or less -- see `callRatingSummary`.
    const user = await rater("clerk-f");
    const mediaQuality = {
      outboundScreenShare: {
        frameRateMedian: 18,
        frameRateP10: 6,
        frameHeightMedian: 720,
        frameHeightP10: 360,
        bandwidthLimitedSeconds: 42,
        cpuLimitedSeconds: 0,
      },
      inboundScreenShare: null,
      packetLossPercent: 2.5,
      rttMsMedian: 80,
      relayed: true,
      reconnectCount: 1,
    };
    await recordCallRating(
      user.id,
      input(2, { note: "tela travando", mediaQuality }),
    );

    const summary = await callRatingSummary(7);
    expect(summary.recentNotes).toHaveLength(1);
    expect(summary.recentNotes[0]!.mediaQuality).toEqual(mediaQuality);
  });

  it("stores a rating with no mediaQuality as null, not an error", async () => {
    const user = await rater("clerk-g");
    await recordCallRating(user.id, input(1, { note: "sem dados" }));

    const summary = await callRatingSummary(7);
    expect(summary.recentNotes).toHaveLength(1);
    expect(summary.recentNotes[0]!.mediaQuality).toBeNull();
  });

  it("drops mediaQuality on a good score, the same rule and the same enforcement point as the note", async () => {
    // A reading on a good call is not diagnostic -- the dashboard never shows
    // it (it rides beside a note, which the client does not even ask for
    // above 3), and this rule is enforced here rather than trusted from a
    // client that could send it anyway.
    const user = await rater("clerk-h");
    const mediaQuality = {
      outboundScreenShare: null,
      inboundScreenShare: null,
      packetLossPercent: 0,
      rttMsMedian: 20,
      relayed: false,
      reconnectCount: 0,
    };
    await recordCallRating(user.id, input(5, { mediaQuality }));

    const row = await getPool().query<{ media_quality: unknown }>(
      `SELECT media_quality FROM call_ratings WHERE user_id = $1`,
      [user.id],
    );
    expect(row.rows[0]!.media_quality).toBeNull();
  });

  it("ignores ratings older than the window", async () => {
    const user = await rater("clerk-e");
    await recordCallRating(user.id, input(5));
    await getPool().query(
      `UPDATE call_ratings SET created_at = now() - interval '30 days'`,
    );
    await recordCallRating(user.id, input(1));

    const summary = await callRatingSummary(7);
    expect(summary.total).toBe(1);
    expect(summary.average).toBe(1);
  });
});
