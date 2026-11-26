import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * THE TAKE NOTICES, ON TWO MACHINES (CLAUDE.md pitfalls 12 and 19).
 *
 * Production runs two API machines on `CLUSTER_BUS=postgres`. A stranger's take
 * lands on A (that is A's HTTP request) while the starter has the app open on B.
 * Pinned with the real LISTEN/NOTIFY bus, real Postgres, and the
 * `jam_take_notices` flag as a `feature_flags` row written after
 * `startFeatureFlags()` (never the environment):
 *
 * - the starter's live frame sent on A reaches the socket on B, and A has no
 *   socket of theirs, so nothing is sent twice;
 * - the sender's decision frame (a distinct frame type) crosses the same way;
 * - one item for a burst, and when the takes land on BOTH machines at once the
 *   push is claimed exactly once, because the upsert is the claim;
 * - flag off on both machines (the row crosses the bus too): nothing written.
 *
 * Two instances are two module graphs (`vi.resetModules()`), as in
 * `nudge-cluster.test.ts`. Only the push vendor and the socket probe are stubbed.
 */

// This suite TRUNCATEs: it runs only against a localhost database, so a staging or
// production `DATABASE_URL` in the environment makes it skip instead of wiping users.
function localTestDatabase(): string | undefined {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    return undefined;
  }
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ? url : undefined;
  } catch {
    return undefined;
  }
}
const DATABASE_URL = localTestDatabase();
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.CLUSTER_BUS = "postgres";
process.env.VOICE_REGISTRY = "postgres";
delete process.env.JAM_TAKE_NOTICES;
process.env.VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:push@example.test";

interface Instance {
  bus: typeof import("../lib/bus.js");
  db: typeof import("../db.js");
  flags: typeof import("../lib/flags.js");
  sockets: typeof import("./sockets.js");
  push: typeof import("../services/push.js");
  notify: typeof import("../services/jam-public-notify.js");
  notices: typeof import("../services/jam-take-notices.js");
  users: typeof import("../services/users.js");
  transport: ReturnType<typeof import("../lib/bus-postgres.js").createPostgresBusTransport>;
}

const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = await import("../lib/bus.js");
  const db = await import("../db.js");
  const { createPostgresBusTransport } = await import("../lib/bus-postgres.js");
  const instance = {
    bus,
    db,
    flags: await import("../lib/flags.js"),
    sockets: await import("./sockets.js"),
    push: await import("../services/push.js"),
    notify: await import("../services/jam-public-notify.js"),
    notices: await import("../services/jam-take-notices.js"),
    users: await import("../services/users.js"),
    transport: createPostgresBusTransport(DATABASE_URL),
  };
  await db.initDb();
  bus.setBusTransport(instance.transport);
  await instance.transport.whenConnected();
  await instance.flags.startFeatureFlags();
  booted.push(instance);
  return instance;
}

interface Frame {
  type: string;
  kind?: string;
  decision?: string;
  songId?: string;
  instrument?: string | null;
}

function recordingSocket() {
  const received: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

describeDb("take notices across two instances on the Postgres bus", () => {
  let a: Instance;
  let b: Instance;
  let starter: DbUser;
  let taker: DbUser;
  let songId: string;
  const pushed: Array<{ userId: string; body: string }> = [];

  const live = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === type);

  beforeAll(async () => {
    a = await bootInstance();
    b = await bootInstance();
    expect(a.bus.isBusEnabled() && b.bus.isBusEnabled()).toBe(true);
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);
    for (const instance of [a, b]) {
      instance.push.setLiveSocketProbeForTests(() => false);
      instance.push.setPushSenderForTests(async (subscription, payload) => {
        pushed.push({ userId: subscription.user_id, body: (JSON.parse(payload) as { body: string }).body });
      });
    }
  }, 30_000);

  beforeEach(async () => {
    pushed.length = 0;
    await a.db.getPool().query(
      `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    for (const instance of [a, b]) {
      instance.notices.resetJamTakeNoticeCountersForTests();
      instance.notify.takeJamPublicNoticesForTests();
      instance.notify.takeJamTakeDecisionsForTests();
    }
    await a.flags.startFeatureFlags();
    await b.flags.startFeatureFlags();
    starter = await a.users.upsertUser({ clerkId: `clerk_jtc_starter_${randomUUID()}`, displayName: "Starter", avatarUrl: null });
    taker = await a.users.upsertUser({ clerkId: `clerk_jtc_taker_${randomUUID()}`, displayName: "Taker", avatarUrl: null });
    // Only the notice rows are under test, so the song is a bare row in a throwaway server and channel.
    const server = await a.db.getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Jam', $1) RETURNING id`,
      [starter.id],
    );
    const channel = await a.db.getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type) VALUES ($1, 'jam', 'text') RETURNING id`,
      [server.rows[0]!.id],
    );
    const song = await a.db.getPool().query<{ id: string }>(
      `INSERT INTO jam_songs (channel_id, server_id, author_id, title) VALUES ($1, $2, $3, 'Lua cheia') RETURNING id`,
      [channel.rows[0]!.id, server.rows[0]!.id, starter.id],
    );
    songId = song.rows[0]!.id;
    await a.push.savePushSubscription(starter.id, {
      endpoint: `https://push.example.test/${starter.id}`,
      keys: { p256dh: "p", auth: "a" },
    });
  });

  afterAll(async () => {
    for (const instance of booted) {
      instance.push.setPushSenderForTests(null);
      instance.push.setLiveSocketProbeForTests(null);
      await instance.transport.close().catch(() => {});
      instance.flags.resetFeatureFlagsForTests();
      await instance.db.closePool().catch(() => {});
    }
  });

  const takeOn = (instance: Instance, instrument: "bass" | "drums") =>
    instance.notices.recordTakeForStarter({
      starterId: starter.id,
      takerId: taker.id,
      songId,
      title: "Lua cheia",
      instrument,
      serverId: null,
      channelId: null,
    });

  it("the starter's frame sent on A reaches the socket on B, once, and A holds nothing of theirs", async () => {
    const onB = recordingSocket();
    b.sockets.setAuthenticatedSocket(onB.socket, starter);

    await takeOn(a, "bass");
    a.notify.notifyJamPublic(starter.id, { kind: "take", songId, title: "Lua cheia", instrument: "bass" });

    await vi.waitFor(() => expect(live(onB.received, "jam-public-notice")).toHaveLength(1), { timeout: 5_000 });
    expect(live(onB.received, "jam-public-notice")[0]).toMatchObject({ kind: "take", songId, instrument: "bass" });
    // No second delivery trickles in.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live(onB.received, "jam-public-notice")).toHaveLength(1);
    // The durable item is one row, readable from either machine.
    for (const instance of [a, b]) {
      const read = await instance.notices.listJamTakeNotices(starter.id);
      expect(read.notices).toHaveLength(0); // no waiting take rows in jam_tracks: the live read empties it
    }
    const rows = await a.db.getPool().query(`SELECT count FROM jam_take_notices WHERE user_id = $1`, [starter.id]);
    expect(rows.rowCount).toBe(1);
  }, 30_000);

  it("the sender's decision frame is its own type and crosses the bus", async () => {
    const onB = recordingSocket();
    b.sockets.setAuthenticatedSocket(onB.socket, taker);

    await a.notices.recordTakeDecision(
      { senderId: taker.id, starterId: starter.id, songId, title: "Lua cheia", instrument: "bass", serverId: null, channelId: null },
      "accepted",
    );

    await vi.waitFor(() => expect(live(onB.received, "jam-take-decision")).toHaveLength(1), { timeout: 5_000 });
    expect(live(onB.received, "jam-take-decision")[0]).toMatchObject({ decision: "accepted", songId, instrument: "bass" });
    // Not the frame an old tab reads as a consent question.
    expect(live(onB.received, "jam-public-notice")).toHaveLength(0);
  }, 30_000);

  it("takes landing on both machines at once are one item and ONE push claim", async () => {
    await Promise.all([takeOn(a, "bass"), takeOn(b, "drums"), takeOn(a, "bass"), takeOn(b, "drums")]);

    const rows = await a.db.getPool().query<{ count: number; instruments: string[] }>(
      `SELECT count, instruments FROM jam_take_notices WHERE user_id = $1 AND kind = 'take'`,
      [starter.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.count).toBe(4);
    expect([...rows.rows[0]!.instruments].sort()).toEqual(["bass", "drums"]);

    const claimed = a.notices.jamTakeNoticeCounters().pushClaimed + b.notices.jamTakeNoticeCounters().pushClaimed;
    expect(claimed).toBe(1);
    const created = a.notices.jamTakeNoticeCounters().created + b.notices.jamTakeNoticeCounters().created;
    const merged = a.notices.jamTakeNoticeCounters().merged + b.notices.jamTakeNoticeCounters().merged;
    expect([created, merged]).toEqual([1, 3]);
    // One device, one push.
    await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pushed).toHaveLength(1);
  }, 30_000);

  it("a push that fails before reaching a device hands its claim back, so the next take may push", async () => {
    const pool = a.db.getPool();
    const real = pool.query.bind(pool);
    let failuresLeft = 1;
    const spy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (failuresLeft > 0 && typeof text === "string" && text.includes("FROM user_preferences")) {
        failuresLeft -= 1;
        return Promise.reject(new Error("connection terminated"));
      }
      return (real as (...args: unknown[]) => unknown)(text, ...rest);
    }) as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await takeOn(a, "bass");
      await vi.waitFor(() => expect(a.notices.jamTakeNoticeCounters().pushFailed).toBe(1), { timeout: 5_000 });
      await vi.waitFor(async () => {
        const row = await real(`SELECT pushed_at FROM jam_take_notices WHERE user_id = $1`, [starter.id]);
        expect((row as { rows: Array<{ pushed_at: Date | null }> }).rows[0]!.pushed_at).toBeNull();
      });
      // The claim is free again: the next take on the item pushes (it would be held back for
      // half an hour had the failed attempt kept it).
      await takeOn(a, "drums");
      await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
      expect(a.notices.jamTakeNoticeCounters()).toMatchObject({ pushClaimed: 2, pushFailed: 1 });
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  }, 30_000);

  it("flag off by a row on A: B stops writing too, and nothing is stored or pushed", async () => {
    await a.flags.setGlobalFlag("jam_take_notices", false, { kind: "dashboard" });
    await vi.waitFor(() => expect(b.flags.isEnabled("jam_take_notices")).toBe(false), { timeout: 5_000 });

    await takeOn(a, "bass");
    await takeOn(b, "drums");
    await a.notices.recordTakeDecision(
      { senderId: taker.id, starterId: starter.id, songId, title: "Lua cheia", instrument: "bass", serverId: null, channelId: null },
      "refused",
    );

    const rows = await a.db.getPool().query(`SELECT 1 FROM jam_take_notices`);
    expect(rows.rowCount).toBe(0);
    expect(pushed).toEqual([]);
    expect(a.notify.takeJamTakeDecisionsForTests()).toEqual([]);
    expect(a.notices.jamTakeNoticeCounters().skippedFlagOff + b.notices.jamTakeNoticeCounters().skippedFlagOff).toBe(3);
  }, 30_000);
});
