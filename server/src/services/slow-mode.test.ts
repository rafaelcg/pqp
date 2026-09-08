import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Slow mode's clock, against a real database.
 *
 * The gating logic -- which channel types are covered, which permissions walk
 * through, that a refusal for another reason never spends a turn -- is pinned
 * in ws/chat.test.ts, which runs without Postgres. What can only be pinned
 * here is the part that used to be a `Map` in the API process: that the wait
 * is one budget per person per channel, that it survives a second machine,
 * and that two sends racing produce one message rather than two.
 */

// TEST_DATABASE_URL wins -- see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { chargeSlowMode, refundSlowMode, sweepSlowModeClocks } = await import(
  "./slow-mode.js"
);

/** Pretend `seconds` of wall clock have gone by since this person's send. */
async function rewind(channelId: string, userId: string, seconds: number) {
  await getPool().query(
    `UPDATE channel_slowmode_sends
        SET last_sent_at = last_sent_at - make_interval(secs => $3::int)
      WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId, seconds],
  );
}

describeDb("slow mode clock", () => {
  let member: { id: string };
  let other: { id: string };
  let channelId: string;
  let otherChannelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "member",
      avatarUrl: null,
    });
    other = await upsertUser({
      clerkId: "clerk_other",
      displayName: "other",
      avatarUrl: null,
    });
    const created = await createServer("Slow", member.id);
    const texts = created.channels.filter((c) => c.type === "text");
    channelId = texts[0]!.id;
    const second = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'segundo', 'text', 99) RETURNING id`,
      [created.server.id],
    );
    otherChannelId = second.rows[0]!.id;
  });

  it("refuses inside the window and allows once it has passed", async () => {
    expect(await chargeSlowMode(channelId, member.id, 30)).toEqual({ ok: true });

    const held = await chargeSlowMode(channelId, member.id, 30);
    expect(held.ok).toBe(false);
    if (held.ok) throw new Error("unreachable");
    expect(held.retryAfterMs).toBeGreaterThan(28_000);
    expect(held.retryAfterMs).toBeLessThanOrEqual(30_000);

    // Still held one second short of the interval, and the countdown it
    // reports has come down rather than restarting.
    await rewind(channelId, member.id, 29);
    const nearly = await chargeSlowMode(channelId, member.id, 30);
    expect(nearly.ok).toBe(false);
    if (nearly.ok) throw new Error("unreachable");
    expect(nearly.retryAfterMs).toBeLessThanOrEqual(1_000);
    expect(nearly.retryAfterMs).toBeGreaterThan(0);

    await rewind(channelId, member.id, 2);
    expect(await chargeSlowMode(channelId, member.id, 30)).toEqual({ ok: true });
  });

  it("is per person, not one budget for the whole channel", async () => {
    expect(await chargeSlowMode(channelId, member.id, 30)).toEqual({ ok: true });
    expect(await chargeSlowMode(channelId, other.id, 30)).toEqual({ ok: true });
    expect((await chargeSlowMode(channelId, member.id, 30)).ok).toBe(false);
    expect((await chargeSlowMode(channelId, other.id, 30)).ok).toBe(false);
  });

  it("is per channel, so a wait in one does not hold the other", async () => {
    expect(await chargeSlowMode(channelId, member.id, 30)).toEqual({ ok: true });
    expect(await chargeSlowMode(otherChannelId, member.id, 30)).toEqual({
      ok: true,
    });
    expect((await chargeSlowMode(channelId, member.id, 30)).ok).toBe(false);
  });

  /**
   * Lowering the interval has to free the room now, not at the end of the old
   * one. The clock stores when you last posted, never a deadline, exactly so
   * a moderator who drops ten minutes to five seconds does not leave two
   * hundred people staring at a countdown for the number they just deleted.
   */
  it("reads the channel's current interval, not the one in force at send", async () => {
    expect(await chargeSlowMode(channelId, member.id, 600)).toEqual({ ok: true });
    expect((await chargeSlowMode(channelId, member.id, 600)).ok).toBe(false);

    await rewind(channelId, member.id, 10);
    expect(await chargeSlowMode(channelId, member.id, 5)).toEqual({ ok: true });
  });

  it("turns the wait off entirely at zero", async () => {
    expect(await chargeSlowMode(channelId, member.id, 0)).toEqual({ ok: true });
    expect(await chargeSlowMode(channelId, member.id, 0)).toEqual({ ok: true });
    const stored = await getPool().query(
      `SELECT 1 FROM channel_slowmode_sends WHERE channel_id = $1`,
      [channelId],
    );
    expect(stored.rowCount).toBe(0);
  });

  /**
   * A charge that succeeded followed by a write that produced nothing leaves
   * the sender with no message and no reason to wait.
   */
  it("hands the turn back on a refund", async () => {
    expect(await chargeSlowMode(channelId, member.id, 300)).toEqual({ ok: true });
    expect((await chargeSlowMode(channelId, member.id, 300)).ok).toBe(false);

    await refundSlowMode(channelId, member.id);
    expect(await chargeSlowMode(channelId, member.id, 300)).toEqual({ ok: true });
  });

  /**
   * Two sends in flight at once. `ON CONFLICT DO UPDATE` takes a row lock, so
   * the second statement re-reads the row the first wrote and finds the
   * interval unspent. One message, not two -- which is the whole reason this
   * is a single statement rather than a read followed by a write.
   */
  it("lets exactly one of a burst of concurrent sends through", async () => {
    // Twenty rather than two on purpose. A read-then-write version of this
    // passes a two-way race often enough to look correct; with twenty in
    // flight against a pool of ten, every read in the first batch lands
    // before any write and the whole batch gets in. One statement is what
    // makes this a one.
    const burst = await Promise.all(
      Array.from({ length: 20 }, () =>
        chargeSlowMode(channelId, member.id, 300),
      ),
    );
    expect(burst.filter((one) => one.ok)).toHaveLength(1);
  });

  it("sweeps clocks nobody is waiting on and leaves live ones alone", async () => {
    await chargeSlowMode(channelId, member.id, 300);
    await chargeSlowMode(otherChannelId, member.id, 300);
    await rewind(otherChannelId, member.id, 2 * 24 * 60 * 60);

    expect(await sweepSlowModeClocks()).toBe(1);
    expect((await chargeSlowMode(channelId, member.id, 300)).ok).toBe(false);
  });
});

/**
 * Two "instances", one database.
 *
 * Same trick as ws/cluster.test.ts: a second *module graph* is what catches
 * the failure that matters, because module state is exactly what does not
 * cross a machine boundary. Importing the service twice under
 * `vi.resetModules()` gives two independent copies with two independent pg
 * pools, sharing nothing but the database -- the shape of a two-replica
 * deploy.
 *
 * This test is the reason the clock is a row. Against the first version of
 * slow mode, which kept a token bucket in a module `Map`, instance B starts
 * empty and charges happily: a sender whose two requests land on different
 * machines gets two sends out of a one-send budget, and nothing anywhere logs
 * that it happened. Here B refuses, because it reads what A wrote.
 */
describeDb("slow mode across two instances", () => {
  let member: { id: string };
  let channelId: string;
  let a: typeof import("./slow-mode.js");
  let b: typeof import("./slow-mode.js");
  let closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await initDb();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    member = await upsertUser({
      clerkId: "clerk_two_machines",
      displayName: "member",
      avatarUrl: null,
    });
    const created = await createServer("Two machines", member.id);
    channelId = created.channels.find((c) => c.type === "text")!.id;

    vi.resetModules();
    a = await import("./slow-mode.js");
    const dbA = await import("../db.js");
    vi.resetModules();
    b = await import("./slow-mode.js");
    const dbB = await import("../db.js");
    // Two graphs is only a real two-instance harness if the pools are
    // genuinely separate. If this ever collapses to one module the test
    // becomes a tautology, so assert the split rather than assume it.
    expect(dbA.getPool()).not.toBe(dbB.getPool());
    closers = [dbA.closePool, dbB.closePool];
  });

  afterAll(async () => {
    for (const close of closers) {
      await close();
    }
    await closePool();
  });

  it("charges on one machine and holds on the other", async () => {
    expect(await a.chargeSlowMode(channelId, member.id, 300)).toEqual({
      ok: true,
    });

    const onB = await b.chargeSlowMode(channelId, member.id, 300);
    expect(onB.ok).toBe(false);
    if (onB.ok) throw new Error("unreachable");
    expect(onB.retryAfterMs).toBeGreaterThan(0);

    // And the refund crosses back the other way, so a failed write on B does
    // not strand a turn that A is the only one who can see.
    await b.refundSlowMode(channelId, member.id);
    expect(await a.chargeSlowMode(channelId, member.id, 300)).toEqual({
      ok: true,
    });
  });
});
