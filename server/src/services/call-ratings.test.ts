import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCallRatingSchema } from "@pqp/shared";

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
const {
  callRatingAudioHealthCounts,
  callRatingSummary,
  recordCallRating,
  resetCallRatingAudioHealthCounts,
} = await import(
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

  it("stores mediaQuality on a 5 exactly as on a 1, and still drops the note", async () => {
    // The request body the web client builds for a 5 (`buildRatingBody`),
    // parsed by the route's own schema, then stored. Until 2026-11 a good
    // call's reading was thrown away here, so a bad call had nothing to be
    // compared with.
    const user = await rater("clerk-h");
    const mediaQuality = {
      outboundScreenShare: null,
      inboundScreenShare: null,
      packetLossPercent: 0,
      rttMsMedian: 20,
      relayed: false,
      reconnectCount: 0,
    };
    const body = createCallRatingSchema.parse(
      JSON.parse(JSON.stringify(input(5, { note: "muito bom", mediaQuality }))),
    );
    await recordCallRating(user.id, body);

    const row = await getPool().query<{ media_quality: unknown; note: string | null }>(
      `SELECT media_quality, note FROM call_ratings WHERE user_id = $1`,
      [user.id],
    );
    expect(row.rows[0]!.media_quality).toEqual(mediaQuality);
    expect(row.rows[0]!.note).toBeNull();
  });

  it("compares good calls with low ones from the stored readings", async () => {
    const user = await rater("clerk-band");
    const reading = (
      loss: number | null,
      rtt: number | null,
      relayed: boolean | null,
      reconnectCount: number,
      audioHealth?: Record<string, unknown>,
    ) => ({
      outboundScreenShare: null,
      inboundScreenShare: null,
      packetLossPercent: loss,
      rttMsMedian: rtt,
      relayed,
      reconnectCount,
      ...(audioHealth ? { audioHealth } : {}),
    });
    const fault = { detected: 1, autoFixed: 1, asked: 0, manualFixed: 0, unresolved: 0 };
    // Good: 4, 5, 5 with readings, one 5 from a phone that sent none.
    await recordCallRating(user.id, input(4, { mediaQuality: reading(0, 30, false, 0) }));
    await recordCallRating(user.id, input(5, { mediaQuality: reading(1, 50, false, 0) }));
    await recordCallRating(
      user.id,
      input(5, { mediaQuality: reading(2, 100, false, 1, { micNotSending: fault }) }),
    );
    await recordCallRating(user.id, input(5));
    // Low: 1, 3 with readings, one 2 from an old client.
    await recordCallRating(
      user.id,
      input(1, { mediaQuality: reading(8, 300, true, 2, { inboundStalled: fault }) }),
    );
    await recordCallRating(
      user.id,
      input(3, { mediaQuality: reading(4, null, null, 0, { inboundStalled: fault }) }),
    );
    await recordCallRating(user.id, input(2));

    const { good, low } = (await callRatingSummary(7)).mediaByBand;
    expect(good).toMatchObject({
      ratings: 4,
      withMedia: 3,
      packetLossPercentMedian: 1,
      rttMsMedian: 50,
      relayedShare: 0,
    });
    expect(good.reconnectShare).toBeCloseTo(1 / 3, 3);
    expect(good.audioHealthCalls).toEqual({
      micNotSending: 1,
      micUnavailable: 0,
      playbackBlocked: 0,
      inboundStalled: 0,
      outputMissing: 0,
    });
    expect(low).toMatchObject({
      ratings: 3,
      withMedia: 2,
      // Two calls, one with no RTT: the median is the one that was measured.
      packetLossPercentMedian: 6,
      rttMsMedian: 300,
      reconnectShare: 0.5,
      // Only one of the two knew its path.
      relayedShare: 1,
    });
    expect(low.audioHealthCalls.inboundStalled).toBe(2);
  });

  it("answers an empty band with nulls and zeros, not NaN", async () => {
    const user = await rater("clerk-onlygood");
    await recordCallRating(user.id, input(5));
    const { good, low } = (await callRatingSummary(7)).mediaByBand;
    expect(good).toMatchObject({
      ratings: 1,
      withMedia: 0,
      packetLossPercentMedian: null,
      rttMsMedian: null,
      reconnectShare: null,
      relayedShare: null,
    });
    expect(low.ratings).toBe(0);
    expect(low.relayedShare).toBeNull();
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
  it("tallies audioHealth on every score, and the row now keeps it on every score too", async () => {
    resetCallRatingAudioHealthCounts();
    const user = await rater("clerk-ah");
    const mediaQuality = (audioHealth: Record<string, unknown>) => ({
      outboundScreenShare: null,
      inboundScreenShare: null,
      packetLossPercent: 0,
      rttMsMedian: 20,
      relayed: false,
      reconnectCount: 0,
      audioHealth,
    });
    const healed = { detected: 1, autoFixed: 1, asked: 0, manualFixed: 0, unresolved: 0 };
    const stuck = { detected: 2, autoFixed: 0, asked: 1, manualFixed: 0, unresolved: 1 };
    await recordCallRating(user.id, input(5, { mediaQuality: mediaQuality({ micNotSending: healed }) }));
    await recordCallRating(
      user.id,
      input(1, { note: "n escuto", mediaQuality: mediaQuality({ inboundStalled: stuck }) }),
    );

    expect(callRatingAudioHealthCounts()).toEqual({
      "micNotSending.calls": 1,
      "micNotSending.detected": 1,
      "micNotSending.autoFixed": 1,
      "inboundStalled.calls": 1,
      "inboundStalled.lowRated": 1,
      "inboundStalled.detected": 2,
      "inboundStalled.asked": 1,
      "inboundStalled.unresolved": 1,
    });
    const rows = await getPool().query<{ rating: number; media_quality: { audioHealth?: unknown } | null }>(
      `SELECT rating, media_quality FROM call_ratings WHERE user_id = $1 ORDER BY rating`,
      [user.id],
    );
    expect(rows.rows[0]!.media_quality?.audioHealth).toEqual({ inboundStalled: stuck });
    expect(rows.rows[1]!.media_quality?.audioHealth).toEqual({ micNotSending: healed });
  });

  it("still rates for an old client that sends no mediaQuality at all", async () => {
    // A phone, or a bundle from before the sampler: the body has no
    // `mediaQuality` key and must validate, store, and count.
    const user = await rater("clerk-old");
    const body = createCallRatingSchema.parse({
      rating: 5,
      durationSeconds: 120,
      peerCount: 1,
      transport: "livekit",
      hadScreenShare: false,
    });
    await recordCallRating(user.id, body);
    const row = await getPool().query<{ media_quality: unknown }>(
      `SELECT media_quality FROM call_ratings WHERE user_id = $1`,
      [user.id],
    );
    expect(row.rows[0]!.media_quality).toBeNull();
    expect((await callRatingSummary(7)).total).toBe(1);
  });
});
