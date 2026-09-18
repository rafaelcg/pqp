import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { countedQuery } from "../lib/db-tx-metrics.js";
import { logEvent } from "../lib/log.js";
import type { VoicePeerWrite } from "./registry.js";

/**
 * THE WRITE COALESCER: one statement per kind per window instead of one
 * statement per seat change. `VOICE_REGISTRY_BATCH`, default off.
 *
 * WHY. With `VOICE_REGISTRY=postgres` every seat change is its own round
 * trip, so a mass event is a write storm rather than a write. Measured on
 * staging, 2026-09-18:
 *
 *  - 800 seated sockets rejoining at once: pool wait queue 4,604 on one API
 *    process (1,765 each with two), which is past `lib/db-breaker.ts`'s
 *    queue threshold of 8 for 5 s, so the breaker opens and every rejoin
 *    fails;
 *  - ~700 seats leaving at once: `checks.postgres.ms` 1,225 with 141 queries
 *    queued, for a minute.
 *
 * Two hundred concurrent cold bootstraps, which are reads, were fine: the
 * reads were fixed by `lib/read-cache.ts` and the writes were not. This is
 * item A2 of `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`.
 *
 * WHAT IT DOES. Peer upserts, peer deletes, orphan stamps, retired ids and
 * the two empty-room tidies are queued and flushed together every
 * `VOICE_REGISTRY_BATCH_MS` (default 50) or as soon as
 * `VOICE_REGISTRY_BATCH_MAX` (default 200) rows are waiting, as ONE
 * multi-row statement per kind inside ONE transaction on ONE pooled
 * connection. Five hundred joins in a window cost the pool one checkout and
 * the database two statements, not five hundred of each. At most one flush
 * is in flight at a time, which is the whole point: the queue absorbs the
 * burst so the pool never sees the fan-in.
 *
 * ORDER IS STILL PER PEER, AND THAT IS A CORRECTNESS RULE (CLAUDE.md pitfall
 * 13). A `set-voice-state` that arrives after a leave must never resurrect
 * the seat; on 2026-09-08 exactly that left ten immortal rows in production,
 * because two statements for one peer were in flight on two pooled
 * connections and Postgres ran them in the other order. Three things keep it
 * closed here:
 *
 *  1. `ws/voice.ts`'s `trackRowWrite` still chains a peer's writes: the
 *     thunk for a peer's second op is not called until the first op's flush
 *     has committed, so two ops for one peer are normally not even in the
 *     same batch, and across batches the queue is FIFO.
 *  2. If they do meet in one batch (a caller outside that chain), the queue
 *     holds at most ONE pending op per peer and the later one wins, folded
 *     rather than appended: a delete replaces an upsert, an upsert replaces
 *     a delete (it writes the whole row, so it subsumes both), and an
 *     orphan stamp lands INSIDE a pending upsert rather than over it, so the
 *     state change the upsert carried is not lost. That is also what makes
 *     the multi-row `ON CONFLICT (peer_id) DO UPDATE` legal at all: Postgres
 *     refuses a statement that would touch the same row twice.
 *  3. The "is this peer still seated" guard runs at FLUSH time, not at
 *     enqueue time. `ws/voice.ts` already refuses a stale write when it
 *     issues one; between an enqueue and its flush is a new window, and an
 *     upsert whose peer has left the map in the meantime is dropped instead
 *     of being written back over its own delete.
 *
 * FAILURE. A flush that throws is retried once as a whole. If the retry
 * throws too the flush is counted, logged as `voice.registry.batchFlushFailed`
 * and then replayed one row at a time, so a batch never loses a seat because
 * the batch was the thing that broke. Per-row replay uses the same statements
 * with one-element arrays, and swallows per row exactly as the unbatched
 * registry does: a failed registry write is logged and otherwise ignored.
 *
 * WHAT IS NOT BATCHED, ON PURPOSE. The instance heartbeat is already one row
 * per instance per tick, `sweepOwnStaleVoicePeers` and `reconcileVoiceRegistry`
 * are already one statement each however many peers they touch, and the
 * moderator mute, the raised hand and the watch party / music state writes
 * are not seat churn: they are one write per deliberate human action, and
 * putting them behind a 50 ms window would buy nothing and cost latency.
 */

/** Read per call, never cached: tests flip it, and a restart is the only other way it changes. */
export function isVoiceRegistryBatchEnabled(): boolean {
  const raw = (process.env.VOICE_REGISTRY_BATCH ?? "").toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}

export const DEFAULT_BATCH_MS = 50;
export const DEFAULT_BATCH_MAX = 200;

/**
 * How long one flush may spend inside its transaction. Measured p95 is three
 * milliseconds; five seconds is a ceiling, not a budget, and the only thing
 * it exists to stop is a flush that never returns holding the queue open
 * behind it.
 */
export const FLUSH_STATEMENT_TIMEOUT_MS = 5_000;

function batchMs(): number {
  const raw = Number(process.env.VOICE_REGISTRY_BATCH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BATCH_MS;
}

function batchMax(): number {
  const raw = Number(process.env.VOICE_REGISTRY_BATCH_MAX);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_BATCH_MAX;
}

// --- the queue --------------------------------------------------------------

type Waiter = () => void;

interface PeerUpsert {
  kind: "upsert";
  peer: VoicePeerWrite;
  /**
   * A delete this upsert replaced in the queue, kept rather than forgotten.
   *
   * An upsert writes the whole row, so it normally subsumes a delete it lands
   * on: the row ends up exactly as the map says, which is what a rejoin on
   * the same id means. But an upsert can also be DROPPED at flush time by the
   * stale-seat guard, and forgetting the delete would then leave the row
   * standing with nothing behind it — CLAUDE.md pitfall 13's immortal seat,
   * rebuilt out of the fix for it. So the delete is held, and the guard
   * falling back to it is the whole point of holding it.
   */
  supersededDelete: boolean;
  waiters: Waiter[];
}

interface PeerDelete {
  kind: "delete";
  waiters: Waiter[];
}

interface PeerOrphan {
  kind: "orphan";
  orphanedAt: Date | null;
  waiters: Waiter[];
}

type PeerOp = PeerUpsert | PeerDelete | PeerOrphan;

interface Queue {
  /** At most one pending op per peer; insertion order is the FIFO. */
  peers: Map<string, PeerOp>;
  retires: Map<string, Waiter[]>;
  /** Channels to drop the room row of, if it has no peers left. */
  roomTidies: Map<string, Waiter[]>;
  /** Channels to forget the watch party of, if the room has no peers left. */
  watchTidies: Map<string, Waiter[]>;
  /**
   * Peers already counted in `staleDropped` for this batch. A failed flush is
   * planned again on the retry and once more for the per-row replay, and a
   * number that belongs at zero must not read three when it happened once.
   */
  staleCounted: Set<string>;
}

function emptyQueue(): Queue {
  return {
    peers: new Map(),
    retires: new Map(),
    roomTidies: new Map(),
    watchTidies: new Map(),
    staleCounted: new Set(),
  };
}

let queue = emptyQueue();

function queued(): number {
  return (
    queue.peers.size +
    queue.retires.size +
    queue.roomTidies.size +
    queue.watchTidies.size
  );
}

// --- metrics ----------------------------------------------------------------

/**
 * `voice.registry.batch` on `GET /api/admin/metrics`. CLAUDE.md pitfall 12:
 * a flag production sets must carry the counter that proves it runs, and
 * `rowsCoalesced / batchFlushes` is that proof — it IS the compression ratio,
 * and a ratio of about 1 means the flag is on and buying nothing.
 */
let batchFlushes = 0;
let rowsCoalesced = 0;
let maxBatch = 0;
let flushFailures = 0;
let staleDropped = 0;
let maxPending = 0;

/** The last 256 flush durations, for the percentile. A ring, so it never grows. */
const FLUSH_SAMPLES = 256;
const flushMs: number[] = [];

function noteFlush(rows: number, ms: number): void {
  batchFlushes += 1;
  if (rows > maxBatch) {
    maxBatch = rows;
  }
  flushMs.push(ms);
  if (flushMs.length > FLUSH_SAMPLES) {
    flushMs.shift();
  }
}

export interface VoiceRegistryBatchMetrics {
  /** Flush transactions run since boot. */
  batchFlushes: number;
  /** Row writes absorbed by the coalescer since boot. Over `batchFlushes`, the compression. */
  rowsCoalesced: number;
  /** Rows in the largest single flush. */
  maxBatch: number;
  /** p95 of the last 256 flush durations, milliseconds. */
  flushMsP95: number;
  /** Flushes that failed twice and fell back to per-row writes. Belongs at zero. */
  flushFailures: number;
  /**
   * Upserts dropped at flush time because the peer had left the map in the
   * meantime: the pitfall-13 guard firing. Belongs at zero, and a climbing
   * number is the guard working rather than a leak.
   */
  staleDropped: number;
  /** Rows waiting for a flush right now. */
  pending: number;
  /**
   * The deepest the queue has ever been. THE NUMBER THAT SAYS A FLUSH IS
   * STUCK: one flush runs at a time, so while one is blocked the row cap
   * stops bounding anything and the queue is the only place the backlog
   * shows. `FLUSH_STATEMENT_TIMEOUT_MS` bounds how long that can last;
   * this says whether it ever happened. Sitting near `VOICE_REGISTRY_BATCH_MAX`
   * is healthy (that is the cap doing its job); far above it, repeatedly, is a
   * database that cannot keep up with the room.
   */
  maxPending: number;
}

export function voiceRegistryBatchMetrics(): VoiceRegistryBatchMetrics {
  const sorted = [...flushMs].sort((a, b) => a - b);
  const p95 =
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    batchFlushes,
    rowsCoalesced,
    maxBatch,
    flushMsP95: Math.round(p95 ?? 0),
    flushFailures,
    staleDropped,
    pending: queued(),
    maxPending,
  };
}

/** Test seam: a clean slate, queue and counters both. */
export function resetVoiceRegistryBatch(): void {
  if (timer) {
    realClearTimeout(timer);
    timer = null;
  }
  // Anything still queued is dropped, but its callers are released rather
  // than left awaiting a flush that will never come: a test that resets
  // mid-flight would otherwise hang instead of failing.
  settle(queue);
  queue = emptyQueue();
  batchFlushes = 0;
  rowsCoalesced = 0;
  maxBatch = 0;
  flushFailures = 0;
  staleDropped = 0;
  maxPending = 0;
  flushMs.length = 0;
}

// --- enqueue ----------------------------------------------------------------

function defer(waiters: Waiter[]): Promise<void> {
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function resolveAll(waiters: Waiter[]): void {
  for (const waiter of waiters) {
    waiter();
  }
  waiters.length = 0;
}

/**
 * A peer's whole row. Replaces whatever was pending for that peer, because it
 * writes every column: an upsert after a delete leaves the row exactly as the
 * map says it should be, which is the same end state, and an upsert after an
 * upsert is simply the newer one. A delete it replaced is remembered rather
 * than forgotten — see `supersededDelete` above for why that is not optional.
 */
export function enqueueVoicePeerUpsert(peer: VoicePeerWrite): Promise<void> {
  const pending = queue.peers.get(peer.peerId);
  const waiters = pending ? pending.waiters : [];
  const op: PeerUpsert = {
    kind: "upsert",
    peer,
    supersededDelete:
      pending?.kind === "delete" ||
      (pending?.kind === "upsert" && pending.supersededDelete),
    waiters,
  };
  queue.peers.set(peer.peerId, op);
  rowsCoalesced += 1;
  const promise = defer(waiters);
  kickIfFull();
  return promise;
}

/** A peer's row, gone, and the room row with it if it was the last seat. */
export function enqueueVoicePeerDelete(peerId: string): Promise<void> {
  const pending = queue.peers.get(peerId);
  const waiters = pending ? pending.waiters : [];
  queue.peers.set(peerId, { kind: "delete", waiters });
  rowsCoalesced += 1;
  const promise = defer(waiters);
  kickIfFull();
  return promise;
}

/**
 * Socket gone, seat held (or the reverse on resume).
 *
 * Folded INTO a pending upsert rather than queued over it: the orphan stamp
 * touches two columns and the upsert touches sixteen, so replacing one with
 * the other would silently drop whatever state change the upsert carried (a
 * mute in the same 50 ms window as the socket closing). A pending delete
 * wins: there is no seat left to hold.
 */
export function enqueueVoicePeerOrphan(
  peerId: string,
  orphanedAt: Date | null,
): Promise<void> {
  const pending = queue.peers.get(peerId);
  if (pending?.kind === "upsert") {
    pending.peer = { ...pending.peer, orphanedAt };
    rowsCoalesced += 1;
    const promise = defer(pending.waiters);
    kickIfFull();
    return promise;
  }
  if (pending?.kind === "delete") {
    rowsCoalesced += 1;
    return defer(pending.waiters);
  }
  const waiters = pending ? pending.waiters : [];
  queue.peers.set(peerId, { kind: "orphan", orphanedAt, waiters });
  rowsCoalesced += 1;
  const promise = defer(waiters);
  kickIfFull();
  return promise;
}

function enqueueKeyed(
  map: Map<string, Waiter[]>,
  key: string,
): Promise<void> {
  let waiters = map.get(key);
  if (!waiters) {
    waiters = [];
    map.set(key, waiters);
  }
  rowsCoalesced += 1;
  const promise = defer(waiters);
  kickIfFull();
  return promise;
}

/** Block reconstruct of a hung-up id cluster-wide for the token's life. */
export function enqueueVoicePeerRetire(peerId: string): Promise<void> {
  return enqueueKeyed(queue.retires, peerId);
}

/** Drop a room row that has no peers. */
export function enqueueVoiceRoomTidy(channelId: string): Promise<void> {
  return enqueueKeyed(queue.roomTidies, channelId);
}

/** Forget a room's party once nobody is in it anywhere. */
export function enqueueVoiceWatchPartyTidy(channelId: string): Promise<void> {
  return enqueueKeyed(queue.watchTidies, channelId);
}

// --- the flush loop ---------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

/**
 * THE WINDOW RUNS ON THE REAL CLOCK, captured at load before any suite can
 * replace it.
 *
 * The window is a wall-clock debounce in front of the database, not
 * application logic anybody should be able to step through, and a test that
 * fakes time to age an orphan out of its 90 s resume window must not also be
 * stepping this timer. Two of the seat-leak suites do exactly that: they
 * install fake timers, advance ninety seconds, and would otherwise chase a
 * drain timer that reschedules itself inside the window they are advancing,
 * with a real Postgres round trip in the middle of every hop. The drain seam
 * (`flushVoiceRegistryBatch`) is how a test gets the rows deterministically,
 * and it never touches a timer at all.
 */
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

function kickIfFull(): void {
  const depth = queued();
  if (depth > maxPending) {
    maxPending = depth;
  }
  if (depth >= batchMax()) {
    void kick();
    return;
  }
  schedule();
}

function schedule(): void {
  // A flush in flight reschedules itself on the way out; a timer already set
  // is the window everything enqueued since shares.
  if (timer || flushing || queued() === 0) {
    return;
  }
  timer = realSetTimeout(() => {
    timer = null;
    void kick();
  }, batchMs());
  timer.unref?.();
}

/**
 * ONE FLUSH AT A TIME, which is the cap the pool cares about. A burst that
 * arrives while a flush is running does not start a second transaction; it
 * queues, and the running flush schedules the next window as it finishes.
 */
function kick(): Promise<void> {
  if (flushing) {
    return flushing;
  }
  if (queued() === 0) {
    return Promise.resolve();
  }
  if (timer) {
    realClearTimeout(timer);
    timer = null;
  }
  const batch = queue;
  queue = emptyQueue();
  flushing = runFlush(batch).finally(() => {
    flushing = null;
    // `kickIfFull` and not `schedule`: a queue that filled to the cap while
    // this flush ran should not then wait out another window.
    kickIfFull();
  });
  return flushing;
}

/** Test seam: drain the queue now and wait for every pending row to land. */
export async function flushVoiceRegistryBatch(): Promise<void> {
  // Bounded: each pass either flushes something or finds nothing to flush,
  // and nothing here enqueues.
  for (let pass = 0; pass < 1000; pass++) {
    if (flushing) {
      await flushing;
      continue;
    }
    if (queued() === 0) {
      return;
    }
    await kick();
  }
}

function batchRows(batch: Queue): number {
  return (
    batch.peers.size +
    batch.retires.size +
    batch.roomTidies.size +
    batch.watchTidies.size
  );
}

async function runFlush(batch: Queue): Promise<void> {
  const rows = batchRows(batch);
  const started = Date.now();
  try {
    await writeBatch(batch);
  } catch (first) {
    logEvent("voice.registry.batchFlushRetry", {
      rows,
      error: first instanceof Error ? first.message : String(first),
    });
    try {
      // Re-enqueue once, as the same batch: the stale-peer guard re-runs, so
      // a seat that left during the failed attempt is not written back.
      await writeBatch(batch);
    } catch (second) {
      flushFailures += 1;
      logEvent("voice.registry.batchFlushFailed", {
        rows,
        error: second instanceof Error ? second.message : String(second),
      });
      await writePerRow(batch);
    }
  }
  noteFlush(rows, Date.now() - started);
  settle(batch);
}

/** Every waiter in the batch, whatever path served it. Never rejects: the
 *  unbatched registry's contract is that a failed write is logged, not thrown. */
function settle(batch: Queue): void {
  for (const op of batch.peers.values()) {
    resolveAll(op.waiters);
  }
  for (const waiters of batch.retires.values()) {
    resolveAll(waiters);
  }
  for (const waiters of batch.roomTidies.values()) {
    resolveAll(waiters);
  }
  for (const waiters of batch.watchTidies.values()) {
    resolveAll(waiters);
  }
}

// --- the statements ---------------------------------------------------------

interface Plan {
  upserts: VoicePeerWrite[];
  deletes: string[];
  orphans: { peerId: string; orphanedAt: Date | null }[];
  retires: string[];
  watchTidies: string[];
  /** Room rows to drop if empty: asked for, plus every channel a delete touched. */
  roomTidies: Set<string>;
}

/**
 * The batch as statements, with the stale-peer guard applied HERE and not at
 * enqueue time. See the header: this is the window `ws/voice.ts`'s own check
 * cannot cover, because its check ran when the write was asked for and the
 * seat can go away before the flush.
 */
function planOf(batch: Queue): Plan {
  const plan: Plan = {
    upserts: [],
    deletes: [],
    orphans: [],
    retires: [...batch.retires.keys()],
    watchTidies: [...batch.watchTidies.keys()],
    roomTidies: new Set(batch.roomTidies.keys()),
  };
  for (const [peerId, op] of batch.peers) {
    if (op.kind === "upsert") {
      if (op.peer.stillSeated && !op.peer.stillSeated()) {
        if (!batch.staleCounted.has(peerId)) {
          batch.staleCounted.add(peerId);
          staleDropped += 1;
        }
        logEvent("voice.registry.batchStaleUpsert", {
          peerId,
          voiceChannelId: op.peer.channelId,
          userId: op.peer.userId,
          supersededDelete: op.supersededDelete,
        });
        // The delete this upsert replaced still has to happen: the seat is
        // gone from the map and the row must go with it.
        if (op.supersededDelete) {
          plan.deletes.push(peerId);
        }
        continue;
      }
      plan.upserts.push(op.peer);
    } else if (op.kind === "delete") {
      plan.deletes.push(peerId);
    } else {
      plan.orphans.push({ peerId, orphanedAt: op.orphanedAt });
    }
  }
  return plan;
}

const UPSERT_ROOMS_SQL = `INSERT INTO voice_rooms (channel_id, transport)
   SELECT * FROM UNNEST($1::uuid[], $2::text[])
   ON CONFLICT (channel_id) DO NOTHING`;

const UPSERT_PEERS_SQL = `INSERT INTO voice_peers (
     peer_id, channel_id, user_id, instance_id, display_name, avatar_url,
     muted, deafened, sharing_screen, listening_music, camera_stream_id,
     screen_audio_stream_id, can_speak, can_stream, can_resume, orphaned_at
   )
   SELECT * FROM UNNEST(
     $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[],
     $7::boolean[], $8::boolean[], $9::boolean[], $10::boolean[], $11::text[],
     $12::text[], $13::boolean[], $14::boolean[], $15::boolean[], $16::timestamptz[]
   )
   ON CONFLICT (peer_id) DO UPDATE SET
     channel_id = EXCLUDED.channel_id,
     user_id = EXCLUDED.user_id,
     instance_id = EXCLUDED.instance_id,
     display_name = EXCLUDED.display_name,
     avatar_url = EXCLUDED.avatar_url,
     muted = EXCLUDED.muted,
     deafened = EXCLUDED.deafened,
     sharing_screen = EXCLUDED.sharing_screen,
     listening_music = EXCLUDED.listening_music,
     camera_stream_id = EXCLUDED.camera_stream_id,
     screen_audio_stream_id = EXCLUDED.screen_audio_stream_id,
     can_speak = EXCLUDED.can_speak,
     can_stream = EXCLUDED.can_stream,
     can_resume = EXCLUDED.can_resume,
     orphaned_at = EXCLUDED.orphaned_at,
     updated_at = NOW()`;

const ORPHAN_SQL = `UPDATE voice_peers p
      SET orphaned_at = v.orphaned_at, instance_id = $3, updated_at = NOW()
     FROM UNNEST($1::uuid[], $2::timestamptz[]) AS v(peer_id, orphaned_at)
    WHERE p.peer_id = v.peer_id`;

const DELETE_SQL = `DELETE FROM voice_peers
    WHERE peer_id = ANY($1::uuid[])
    RETURNING peer_id, channel_id`;

const RETIRE_SQL = `INSERT INTO voice_retired_peers (peer_id)
   SELECT * FROM UNNEST($1::uuid[])
   ON CONFLICT (peer_id) DO UPDATE SET retired_at = NOW()`;

const ROOM_TIDY_SQL = `DELETE FROM voice_rooms r
    WHERE r.channel_id = ANY($1::uuid[])
      AND NOT EXISTS (SELECT 1 FROM voice_peers p WHERE p.channel_id = r.channel_id)`;

const WATCH_TIDY_SQL = `UPDATE voice_rooms r
      SET watch_party = NULL, watch_party_rev = 0
    WHERE r.channel_id = ANY($1::uuid[])
      AND r.watch_party IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM voice_peers p WHERE p.channel_id = r.channel_id)`;

function upsertParams(upserts: readonly VoicePeerWrite[]): unknown[] {
  return [
    upserts.map((p) => p.peerId),
    upserts.map((p) => p.channelId),
    upserts.map((p) => p.userId),
    upserts.map(() => INSTANCE_ID),
    upserts.map((p) => p.displayName),
    upserts.map((p) => p.avatarUrl),
    upserts.map((p) => p.muted),
    upserts.map((p) => p.deafened),
    upserts.map((p) => p.sharingScreen),
    upserts.map((p) => p.listeningMusic),
    upserts.map((p) => p.cameraStreamId),
    upserts.map((p) => p.screenAudioStreamId),
    upserts.map((p) => p.canSpeak),
    upserts.map((p) => p.canStream),
    upserts.map((p) => p.canResume),
    upserts.map((p) => p.orphanedAt),
  ];
}

/**
 * One transaction, one connection, one statement per kind.
 *
 * ORDER INSIDE THE TRANSACTION. Room rows first, because a peer's foreign key
 * needs one; then peer upserts; then orphan stamps (no peer is in both, the
 * queue guarantees it); then deletes; then the retired ids; then the two
 * empty-room tidies, which must run after the deletes so they see them. A
 * flush's own deletes ARE visible to its own room tidy, which is stronger
 * than the unbatched path managed: there, two of a room's seats leaving at
 * once each checked the room before the other's delete had committed.
 *
 * Across instances the documented window stays exactly as it was: two
 * machines emptying one room in the same instant can each miss the other's
 * uncommitted delete and leave a room row with no peers, which
 * `reconcileVoiceRegistry`'s room sweep clears after `roomGraceMs` and which
 * `pinVoiceRoom` already treats as a pin the next joiner adopts.
 */
async function writeBatch(batch: Queue): Promise<void> {
  const plan = planOf(batch);
  if (
    plan.upserts.length === 0 &&
    plan.deletes.length === 0 &&
    plan.orphans.length === 0 &&
    plan.retires.length === 0 &&
    plan.roomTidies.size === 0 &&
    plan.watchTidies.length === 0
  ) {
    return;
  }
  const client = await getPool().connect();
  try {
    // BEGIN and COMMIT are counted too: a flush's real cost to the database
    // is a handful of round trips for a batch of work, and a statement budget
    // that hides its own transaction overhead is not a budget.
    await countedQuery(client, "registry.batchTx", "BEGIN");
    // THE FLUSH IS BOUNDED, because one flush runs at a time and a stuck one
    // would otherwise hold the queue open for as long as the database took to
    // answer. `pool.connect()` already has `connectionTimeoutMillis` (10 s);
    // this covers the other half, a statement that is accepted and never
    // returns (a lock wait, a stalled replica). Past the bound the flush fails
    // like any other failure: retried once, then replayed row by row. Costs
    // one round trip per flush, which is the cheapest place to buy a hard
    // ceiling on the one code path in this file that is allowed to block.
    await countedQuery(
      client,
      "registry.batchTx",
      `SET LOCAL statement_timeout = ${FLUSH_STATEMENT_TIMEOUT_MS}`,
    );
    await runPlan(client, plan);
    await countedQuery(client, "registry.batchTx", "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runPlan(client: PoolClient, plan: Plan): Promise<void> {
  if (plan.upserts.length > 0) {
    // Distinct channels only: `ON CONFLICT DO NOTHING` tolerates a repeat,
    // but there is no reason to ship four hundred copies of one uuid.
    const rooms = new Map<string, string>();
    for (const peer of plan.upserts) {
      if (!rooms.has(peer.channelId)) {
        rooms.set(peer.channelId, peer.transport);
      }
    }
    await countedQuery(client, "registry.batchUpsertRooms", UPSERT_ROOMS_SQL, [
      [...rooms.keys()],
      [...rooms.values()],
    ]);
    await countedQuery(
      client,
      "registry.batchUpsertPeers",
      UPSERT_PEERS_SQL,
      upsertParams(plan.upserts),
    );
  }
  if (plan.orphans.length > 0) {
    await countedQuery(client, "registry.batchOrphan", ORPHAN_SQL, [
      plan.orphans.map((o) => o.peerId),
      plan.orphans.map((o) => o.orphanedAt),
      INSTANCE_ID,
    ]);
  }
  if (plan.deletes.length > 0) {
    const gone = await countedQuery<{ peer_id: string; channel_id: string }>(
      client,
      "registry.batchDelete",
      DELETE_SQL,
      [plan.deletes],
    );
    for (const row of gone.rows) {
      plan.roomTidies.add(row.channel_id);
    }
  }
  if (plan.retires.length > 0) {
    await countedQuery(client, "registry.batchRetire", RETIRE_SQL, [
      plan.retires,
    ]);
  }
  // A channel this flush seated somebody into is not empty, so neither tidy
  // can match it. Dropping those ids is free, and for the watch party it is
  // also a belt: the tidy clears a party from a room with no peers, and the
  // one way that could erase a party somebody just started is if the joiner's
  // row were not visible when it ran. Inside a flush it always is (the
  // upserts are statements above this one), and this makes it unconditional
  // rather than a consequence of statement order.
  const seated = new Set(plan.upserts.map((peer) => peer.channelId));
  const roomTidies = [...plan.roomTidies].filter((id) => !seated.has(id));
  const watchTidies = plan.watchTidies.filter((id) => !seated.has(id));
  if (roomTidies.length > 0) {
    await countedQuery(client, "registry.batchRoomTidy", ROOM_TIDY_SQL, [
      roomTidies,
    ]);
  }
  if (watchTidies.length > 0) {
    await countedQuery(client, "registry.batchWatchTidy", WATCH_TIDY_SQL, [
      watchTidies,
    ]);
  }
}

/**
 * The fallback after two failed flushes: the same statements, one row at a
 * time, off the pool rather than out of a transaction. Each row swallows its
 * own error into a log, which is the unbatched registry's own contract — a
 * database blip degrades this instance, it does not eject anybody from a
 * call. Slow by construction and only ever reached when batching has already
 * failed twice.
 */
async function writePerRow(batch: Queue): Promise<void> {
  const plan = planOf(batch);
  const pool = getPool();
  const one = async (label: string, text: string, params: unknown[]) => {
    try {
      await countedQuery(pool, label, text, params);
    } catch (error) {
      logEvent("voice.registryWriteFailed", {
        op: label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const peer of plan.upserts) {
    await one("registry.batchFallbackUpsertRoom", UPSERT_ROOMS_SQL, [
      [peer.channelId],
      [peer.transport],
    ]);
    await one(
      "registry.batchFallbackUpsert",
      UPSERT_PEERS_SQL,
      upsertParams([peer]),
    );
  }
  for (const orphan of plan.orphans) {
    await one("registry.batchFallbackOrphan", ORPHAN_SQL, [
      [orphan.peerId],
      [orphan.orphanedAt],
      INSTANCE_ID,
    ]);
  }
  for (const peerId of plan.deletes) {
    try {
      const gone = await countedQuery<{ channel_id: string }>(
        pool,
        "registry.batchFallbackDelete",
        DELETE_SQL,
        [[peerId]],
      );
      for (const row of gone.rows) {
        plan.roomTidies.add(row.channel_id);
      }
    } catch (error) {
      logEvent("voice.registryWriteFailed", {
        op: "registry.batchFallbackDelete",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const peerId of plan.retires) {
    await one("registry.batchFallbackRetire", RETIRE_SQL, [[peerId]]);
  }
  for (const channelId of plan.roomTidies) {
    await one("registry.batchFallbackRoomTidy", ROOM_TIDY_SQL, [[channelId]]);
  }
  for (const channelId of plan.watchTidies) {
    await one("registry.batchFallbackWatchTidy", WATCH_TIDY_SQL, [[channelId]]);
  }
}
