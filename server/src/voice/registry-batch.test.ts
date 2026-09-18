import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { VoicePeerWrite } from "./registry.js";

/**
 * THE WRITE COALESCER (`voice/registry-batch.ts`) AGAINST A REAL POSTGRES,
 * WITH THE FLAG ON AND WITH IT OFF.
 *
 * The measurement that made it exist, staging 2026-09-18: 800 seated sockets
 * rejoining at once put 4,604 callers on the pool's wait queue, past the
 * breaker's threshold, so every rejoin failed; ~700 seats leaving at once
 * took `checks.postgres.ms` to 1,225 with 141 queries queued. The statement
 * count below is the same measurement in a form CI can keep honest.
 *
 * What is pinned here:
 *
 *  - 500 joins then 500 leaves cost a handful of statements with the flag on
 *    and roughly two thousand with it off. The number is read from
 *    `lib/db-tx-metrics.ts`, which labels every registry call site, so the
 *    comparison is the same counter on both sides of the flag.
 *  - Per-peer ordering, which is CLAUDE.md pitfall 13 and not a nicety: an
 *    upsert for a peer the caller no longer holds is refused at FLUSH time,
 *    whether the delete that dropped it was in the same batch or an earlier
 *    one. That is the immortal-row bug, rebuilt against the batcher.
 *  - A join and a leave inside one window leave no row at all.
 *  - A flush that fails twice still lands every row, through the per-row
 *    fallback, and says so in `flushFailures`.
 *
 * Skips without a database, like the rest of the registry suites.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  deleteVoicePeer,
  markVoicePeerOrphaned,
  pinVoiceRoom,
  retireVoicePeerId,
  settleVoiceRegistryWrites,
  unpinVoiceRoomIfEmpty,
  upsertVoicePeer,
  getVoicePeerRow,
} = await import("./registry.js");
const {
  flushVoiceRegistryBatch,
  resetVoiceRegistryBatch,
  voiceRegistryBatchMetrics,
} = await import("./registry-batch.js");
const { dbTxByPath, resetDbTxMetrics } = await import(
  "../lib/db-tx-metrics.js"
);

const previousRegistry = process.env.VOICE_REGISTRY;
const previousBatch = process.env.VOICE_REGISTRY_BATCH;

function seat(channelId: string, peerId = randomUUID()): VoicePeerWrite {
  return {
    peerId,
    channelId,
    userId: randomUUID(),
    displayName: "Seat",
    avatarUrl: null,
    muted: false,
    deafened: false,
    sharingScreen: false,
    listeningMusic: true,
    cameraStreamId: null,
    screenAudioStreamId: null,
    canSpeak: true,
    canStream: true,
    canResume: true,
    orphanedAt: null,
    transport: "livekit",
  };
}

/** Every labelled registry round trip since the last reset, the two paths summed. */
function registryStatements(): number {
  return Object.entries(dbTxByPath())
    .filter(([label]) => label.startsWith("registry."))
    .reduce((sum, [, n]) => sum + n, 0);
}

async function countPeers(channelId: string): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM voice_peers WHERE channel_id = $1`,
    [channelId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describeDb("voice registry write coalescer", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
    process.env.VOICE_REGISTRY = previousRegistry;
    process.env.VOICE_REGISTRY_BATCH = previousBatch;
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    delete process.env.VOICE_REGISTRY_BATCH;
    delete process.env.VOICE_REGISTRY_BATCH_MS;
    delete process.env.VOICE_REGISTRY_BATCH_MAX;
    resetVoiceRegistryBatch();
    resetDbTxMetrics();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    resetVoiceRegistryBatch();
    vi.restoreAllMocks();
  });

  /**
   * THE NUMBER. Five hundred seats in, five hundred out, no waiting between
   * them, counted the same way on both sides of the flag.
   *
   * With the flag off each seat is its own pair of statements on its own
   * pooled connection, which is the shape that put 4,604 callers on the wait
   * queue. With it on the whole storm is two flushes' worth of multi-row
   * statements, transaction control included.
   */
  it("turns 500 joins and 500 leaves into a handful of statements", async () => {
    const channel = randomUUID();
    const peers = Array.from({ length: 500 }, () => seat(channel));

    // --- flag off: the shape that broke ---------------------------------
    resetDbTxMetrics();
    await Promise.all(peers.map((peer) => upsertVoicePeer(peer)));
    await settleVoiceRegistryWrites();
    await Promise.all(peers.map((peer) => deleteVoicePeer(peer.peerId)));
    await settleVoiceRegistryWrites();
    const unbatched = registryStatements();
    expect(await countPeers(channel)).toBe(0);
    expect(unbatched).toBeGreaterThan(1_000);

    // --- flag on: the same thousand row writes -------------------------
    process.env.VOICE_REGISTRY_BATCH = "on";
    resetVoiceRegistryBatch();
    resetDbTxMetrics();
    const again = Array.from({ length: 500 }, () => seat(channel));
    await Promise.all(again.map((peer) => upsertVoicePeer(peer)));
    await settleVoiceRegistryWrites();
    expect(await countPeers(channel)).toBe(500);
    await Promise.all(again.map((peer) => deleteVoicePeer(peer.peerId)));
    await settleVoiceRegistryWrites();
    const batched = registryStatements();

    expect(await countPeers(channel)).toBe(0);
    // Four flushes, each BEGIN + SET LOCAL statement_timeout + at most three
    // statements + COMMIT. Thirty is slack for the harness draining more
    // eagerly than a 50 ms window would.
    expect(batched).toBeLessThan(30);
    expect(batched * 30).toBeLessThan(unbatched);

    const metrics = voiceRegistryBatchMetrics();
    expect(metrics.rowsCoalesced).toBe(1_000);
    // Four flushes, not a thousand: the 200-row cap fires mid-burst and the
    // remainder rides the next window, twice over (in, then out).
    expect(metrics.batchFlushes).toBeLessThanOrEqual(6);
    expect(metrics.maxBatch).toBeGreaterThanOrEqual(200);
    expect(metrics.flushFailures).toBe(0);
  });

  /**
   * CLAUDE.md PITFALL 13, REBUILT AGAINST THE BATCHER. A `set-voice-state`
   * that arrives after a leave must not put the seat back. The guard is the
   * caller's own "do I still hold this peer", asked at flush time rather than
   * at enqueue time, because the window between those two is new and is
   * exactly where the row would be resurrected.
   */
  it("refuses an upsert whose seat left after the write was asked for", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const channel = randomUUID();
    const peer = seat(channel);
    let seated = true;
    const write = { ...peer, stillSeated: () => seated };

    await upsertVoicePeer(write);
    await settleVoiceRegistryWrites();
    expect(await getVoicePeerRow(peer.peerId)).not.toBeNull();

    // The hangup: the map drops the peer, the row goes.
    seated = false;
    await deleteVoicePeer(peer.peerId);
    await settleVoiceRegistryWrites();
    expect(await getVoicePeerRow(peer.peerId)).toBeNull();

    // The late frame, a whole window later. It is not a row, it is a log line.
    await upsertVoicePeer({ ...write, muted: true });
    await settleVoiceRegistryWrites();
    expect(await getVoicePeerRow(peer.peerId)).toBeNull();
    expect(voiceRegistryBatchMetrics().staleDropped).toBe(1);
  });

  /** The same race with both halves inside ONE window: the delete is the
   *  later op, so it is what the queue keeps, and the guard never has to fire. */
  it("keeps the delete when a leave and a late state change share a window", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    process.env.VOICE_REGISTRY_BATCH_MS = "10000";
    const channel = randomUUID();
    const peer = seat(channel);
    await upsertVoicePeer({ ...peer, stillSeated: () => true });
    await flushVoiceRegistryBatch();
    expect(await getVoicePeerRow(peer.peerId)).not.toBeNull();

    let seated = true;
    void deleteVoicePeer(peer.peerId);
    seated = false;
    void upsertVoicePeer({ ...peer, muted: true, stillSeated: () => seated });
    await flushVoiceRegistryBatch();

    expect(await getVoicePeerRow(peer.peerId)).toBeNull();
    expect(voiceRegistryBatchMetrics().staleDropped).toBe(1);
  });

  /** A seat that comes and goes inside one window costs one statement group
   *  and leaves nothing behind, room row included. */
  it("leaves no row when a join and a leave share one window", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    process.env.VOICE_REGISTRY_BATCH_MS = "10000";
    const channel = randomUUID();
    await pinVoiceRoom(channel, "livekit");
    const peer = seat(channel);

    void upsertVoicePeer({ ...peer, stillSeated: () => true });
    void deleteVoicePeer(peer.peerId);
    void unpinVoiceRoomIfEmpty(channel);
    await flushVoiceRegistryBatch();

    expect(await getVoicePeerRow(peer.peerId)).toBeNull();
    const rooms = await getPool().query(
      `SELECT 1 FROM voice_rooms WHERE channel_id = $1`,
      [channel],
    );
    expect(rooms.rowCount).toBe(0);
  });

  /**
   * An orphan stamp that lands on a pending upsert is FOLDED INTO it rather
   * than queued over it. Replacing would have thrown away the state change
   * the upsert carried — a mute in the same window as the socket closing —
   * and left the row describing the person from before they muted.
   */
  it("folds an orphan stamp into a pending upsert without losing its state", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    process.env.VOICE_REGISTRY_BATCH_MS = "10000";
    const channel = randomUUID();
    const peer = seat(channel);
    await upsertVoicePeer(peer);
    await flushVoiceRegistryBatch();

    const orphanedAt = new Date();
    void upsertVoicePeer({ ...peer, muted: true });
    void markVoicePeerOrphaned(peer.peerId, orphanedAt);
    await flushVoiceRegistryBatch();

    const row = await getVoicePeerRow(peer.peerId);
    expect(row?.muted).toBe(true);
    expect(row?.orphanedAt?.getTime()).toBe(orphanedAt.getTime());
  });

  /** A retired id still blocks a reconstruct, batched like everything else. */
  it("retires ids in the same flush", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(ids.map((id) => retireVoicePeerId(id)));
    await settleVoiceRegistryWrites();
    const result = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM voice_retired_peers WHERE peer_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(Number(result.rows[0]?.n)).toBe(3);
  });

  /**
   * A FLUSH FAILURE MUST NOT COST A SEAT. Both transactional attempts are
   * made to fail at the checkout; the batch is then replayed one row at a
   * time off the pool, which is slow and is meant to be, and every row still
   * lands. `flushFailures` is how an operator sees it happened at all.
   */
  it("still lands every row when the batch transaction fails twice", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const channel = randomUUID();
    const peers = [seat(channel), seat(channel), seat(channel)];

    const pool = getPool();
    let failures = 2;
    const realConnect = pool.connect.bind(pool);
    const spy = vi
      .spyOn(pool, "connect")
      .mockImplementation(((...args: unknown[]) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("pool exhausted"));
        }
        return (realConnect as (...a: unknown[]) => unknown)(...args);
      }) as typeof pool.connect);

    await Promise.all(peers.map((peer) => upsertVoicePeer(peer)));
    await settleVoiceRegistryWrites();
    spy.mockRestore();

    expect(await countPeers(channel)).toBe(3);
    expect(voiceRegistryBatchMetrics().flushFailures).toBe(1);
  });

  /**
   * The cap, not the clock: a burst past `VOICE_REGISTRY_BATCH_MAX` flushes
   * at once rather than sitting out the window. With a window of a minute,
   * nothing below would land at all if the cap did not fire.
   */
  it("flushes on the row cap without waiting for the window", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    process.env.VOICE_REGISTRY_BATCH_MS = "60000";
    process.env.VOICE_REGISTRY_BATCH_MAX = "5";
    const channel = randomUUID();
    const peers = Array.from({ length: 5 }, () => seat(channel));
    const writes = peers.map((peer) => upsertVoicePeer(peer));
    await Promise.all(writes);
    expect(await countPeers(channel)).toBe(5);
    expect(voiceRegistryBatchMetrics().batchFlushes).toBe(1);
  });

  /** With the flag off nothing is queued and the statements are the old ones. */
  it("is inert with the flag off", async () => {
    const channel = randomUUID();
    const peer = seat(channel);
    await upsertVoicePeer(peer);
    await settleVoiceRegistryWrites();
    expect(await getVoicePeerRow(peer.peerId)).not.toBeNull();
    expect(voiceRegistryBatchMetrics().batchFlushes).toBe(0);
    expect(dbTxByPath()["registry.upsertPeer"]).toBe(1);
    expect(dbTxByPath()["registry.batchUpsertPeers"]).toBeUndefined();
  });
});
