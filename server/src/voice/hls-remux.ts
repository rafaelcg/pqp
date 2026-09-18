import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  remuxControlSignaturePayload,
  remuxErrorResponseSchema,
  remuxListSessionsResponseSchema,
  remuxSessionInfoSchema,
  REMUX_CONTROL_NONCE_HEADER,
  REMUX_CONTROL_SIGNATURE_HEADER,
  REMUX_CONTROL_TIMESTAMP_HEADER,
  LIVE_HLS_MODE_LL,
  LIVE_HLS_MODE_PARAM,
  type LiveHlsStream,
  type RemuxKeyframePolicy,
  type RemuxSessionInfo,
} from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { getPool } from "../db.js";
import {
  claimHlsSessionRow,
  ensureHlsOwnerHeartbeat,
  forgetPendingHlsSessionClaims,
  hlsOwnerInstanceId,
  liveOtherInstances,
  noteHlsSkippedOwnedElsewhere,
  ownedByLiveOtherInstance,
} from "./hls-ownership.js";

/**
 * The `pqp-remux` driver, beside the LiveKit egress driver in `hls-egress.ts`.
 *
 * `docs/plans/LL_HLS.md`, task L1.5. Dark behind `LIVE_HLS_LL` (default off):
 * with the flag unset, `resolveHlsMode` always answers `conventional`,
 * nothing here ever calls the control API, `llRooms` stays empty, and every
 * counter in `llHlsActivity()` reads zero. See
 * `packages/shared/src/hls-remux-control.ts` for the wire contract this
 * module speaks (start/stop/list, HMAC signing) — that file is the one both
 * `pqp-api` and `pqp-remux` (L1.6) build from, so the shape lives there, not
 * here.
 *
 * NOTHING IN THIS FILE IS KEPT IN PROCESS MEMORY AS THE ONLY RECORD OF
 * ANYTHING. Three rounds of Farol review on PR #580 found the same shape of
 * bug three times over an in-memory retry marker: it could be lost to a
 * restart, expire while the session it named was still running, or let an
 * unrelated later party match a stale id. The fix each time was the same
 * idea sharpened further, and this version is where it lands: a session's
 * identity is `deriveLlSessionId(channelId, startedAt)`, a pure function of
 * two values the `hls_sessions` row already carries durably, so ANY retry —
 * a POST whose response was lost, an attempt made after a restart, a boot
 * adoption sweep — recomputes the exact same id from the row instead of
 * remembering one. `llRooms` (in-memory) is a cache of what THIS process
 * currently believes is running, never the source of truth for what to do
 * next; the row is.
 *
 * What this module deliberately does NOT do, all left to later tasks:
 *
 *  - No camera, no mic archive. `pqp-remux` subscribes to one screen-share
 *    track and its own audio (per its own README, "Not yet" §
 *    "Presenter authorization") — there is nothing here for a webcam or a
 *    separate voice file to attach to.
 *  - No stall detection and no restart ladder: that is the BOX's watchdog
 *    (`tools/pqp-remux/README.md`, "Watchdog and the demotion contract"),
 *    which restarts a session once and then demotes it for good. This side
 *    only has to NOTICE — `sweepLlDemotions` below — and fall the party back
 *    to the conventional ladder.
 *  - No R2 writer. `origin_base_url` is stored because the LL playlist front
 *    (`L2.x`) needs it, not because anything here writes objects there.
 */

// ---------------------------------------------------------------------------
// Flag, allowlist, mode selection
// ---------------------------------------------------------------------------

function truthyEnv(name: string): boolean {
  const raw = process.env[name];
  return raw === "true" || raw === "1";
}

/** `LIVE_HLS_LL`, read per call like every other flag in this feature. */
export function isLiveHlsLLEnabled(): boolean {
  return truthyEnv("LIVE_HLS_LL");
}

/**
 * `LIVE_HLS_LL_ALLOWLIST`: comma-separated server ids. Mirrors
 * `liveHlsServerAllowlist` in `hls-egress.ts` exactly — unset or empty means
 * every server, once the flag and the request agree LL is wanted.
 */
export function liveHlsLLAllowlist(): Set<string> | null {
  const raw = process.env.LIVE_HLS_LL_ALLOWLIST;
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Whether anything can actually SERVE an LL session's playlists.
 *
 * There is exactly one renderer for the LL multivariant playlist and the two
 * LL rungs, and it is the edge Worker (`tools/hls-edge`, `L2.1`/`L2.2`) —
 * this API's own playlist proxy has never known what a `mode = 'll'` row is
 * and answers "not found" for one, by design (see `llPlaylistUrl`). So
 * `LIVE_HLS_PLAYLIST_BASE_URL` being unset does not mean "serve LL a
 * slower way", it means "there is no LL". Picking `ll` anyway is how a party
 * ends up live, correct in every log, and black for everybody watching.
 *
 * Read from `process.env` directly rather than through `playlistBaseUrl()`
 * in `hls-egress.ts`: that module imports THIS one, and the dependency
 * between the two drivers stays one-way (see `llObjectPrefix`).
 *
 * Exported because the DURABLE read path has to ask the same question:
 * `liveHlsStreamFromDb` (`hls-egress.ts`) reconstructs a stream from an
 * `hls_sessions` row on an instance that may not be the one that started it,
 * and an instance with no edge front cannot address an `ll` row at all.
 */
export function llPlaylistFrontConfigured(): boolean {
  return envTrimmed("LIVE_HLS_PLAYLIST_BASE_URL") !== null;
}

/**
 * Pure, so the whole matrix is testable with no environment and no database:
 * flag off -> `conventional`, whatever was requested. Flag on but the party
 * did not ask -> `conventional` (the default `docs/plans/LL_HLS.md` §4
 * requires). No edge playlist front configured -> `conventional`, because
 * nothing else can serve an LL playlist at all (`llPlaylistFrontConfigured`).
 * Flag on, asked, a front, and either no allowlist or this server is on
 * it -> `ll`. Asked, flag on, allowlist set, server not on it ->
 * `conventional`, silently: the request is not a promise the client's ask
 * can enforce on its own.
 */
export function resolveHlsMode(input: {
  serverId: string | null | undefined;
  requestedMode: boolean;
}): "conventional" | "ll" {
  if (!input.requestedMode) {
    return "conventional";
  }
  if (!isLiveHlsLLEnabled()) {
    return "conventional";
  }
  if (!llPlaylistFrontConfigured()) {
    return "conventional";
  }
  const allowlist = liveHlsLLAllowlist();
  if (allowlist === null) {
    return "ll";
  }
  return input.serverId && allowlist.has(input.serverId) ? "ll" : "conventional";
}

/**
 * Whether THIS server may ask for LL-HLS at all -- `GET /api/live-hls/config`'s
 * `lowLatency.available`, which is the client's only gate for showing the
 * "Baixa latência (beta)" switch (`watch-party-options.tsx`). Same rule as
 * `resolveHlsMode` minus the request itself: the flag has to be on, and
 * either there is no allowlist or this server is on it. No server id (the
 * deployment-wide answer, asked before a client knows its server) reads the
 * flag alone and ignores the allowlist, same as `liveHlsConfig()`'s base
 * answer for every other field here.
 */
export function liveHlsLLAvailable(serverId: string | null | undefined): boolean {
  if (!isLiveHlsLLEnabled() || !llPlaylistFrontConfigured()) {
    return false;
  }
  const allowlist = liveHlsLLAllowlist();
  if (allowlist === null) {
    return true;
  }
  return Boolean(serverId && allowlist.has(serverId));
}

/**
 * `voice.hlsLlLookupFailed`, rate limited to once per channel per
 * `LOOKUP_FAILURE_LOG_WINDOW_MS` regardless of which of the two durable
 * reads below hit it — a channel stuck retrying every reconcile during an
 * outage must not turn into a log line every few seconds for as long as
 * that outage lasts.
 */
const LOOKUP_FAILURE_LOG_WINDOW_MS = 60_000;
const lastLookupFailureLoggedAt = new Map<string, number>();

function logLookupFailure(
  channelId: string,
  source: "open-row" | "requested-mode",
  error: unknown,
): void {
  const now = Date.now();
  const last = lastLookupFailureLoggedAt.get(channelId) ?? 0;
  if (now - last < LOOKUP_FAILURE_LOG_WINDOW_MS) {
    return;
  }
  lastLookupFailureLoggedAt.set(channelId, now);
  logEvent("voice.hlsLlLookupFailed", {
    channelId,
    source,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** The live party on a channel and what its "Ir ao vivo" asked for. */
export interface LiveHlsRequest {
  /** `channel_sessions.low_latency_requested` for the live party. */
  requested: boolean;
  /**
   * WHICH party that is. The demotion memo is keyed by this and nothing
   * else, so the answer has to travel with the request rather than being
   * re-read on its own: two reads are two different moments, and a party
   * that ended in between would pair one party's request with another
   * party's identity.
   */
  partySessionId: string | null;
  /**
   * When it started. The one thing that tells a party apart from a demoted
   * session whose own party is not yet known: a party live BEFORE that
   * session began could be the one it belonged to, a party created after it
   * emphatically could not. Same bound `attributeDemotion` uses.
   */
  partyCreatedAtMs: number | null;
}

/**
 * What a channel's most recent "go live" asked for — `channel_sessions.
 * low_latency_requested`, not process memory (a Farol finding on PR #580:
 * an in-memory version did not survive a restart, so the very next
 * reconcile after one resolved `conventional` and stopped the LL session
 * boot adoption had just brought back). Written by
 * `POST /api/watch-parties/:id/state` on every `goLive`, unconditionally —
 * a party going live again without asking must not inherit a previous
 * party's request for this channel.
 *
 * FAILS CLOSED, AND `null` IS THE FAILURE, NOT `false`. An earlier version
 * answered `false` on any read error, which is indistinguishable from a
 * genuine "this party never asked" — and `resolveHlsMode` then resolves
 * `conventional`, so a transient database hiccup mid-party could silently
 * tear down a running LL session (a Farol finding on PR #580, fourth
 * round). The caller (`resolveHlsModeForChannel` below) treats `null` as
 * "cannot decide this time" and makes NO mode change at all, leaving
 * whatever is currently running exactly as it is until the next reconcile
 * can actually ask.
 */
export async function liveHlsRequestForChannel(
  channelId: string,
): Promise<LiveHlsRequest | null> {
  try {
    const result = await getPool().query<{
      id: string;
      low_latency_requested: boolean;
      created_at_ms: string;
    }>(
      `SELECT id, low_latency_requested,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms
         FROM channel_sessions
        WHERE channel_id = $1 AND status = 'live'
        LIMIT 1`,
      [channelId],
    );
    const row = result.rows[0];
    return {
      requested: row?.low_latency_requested === true,
      partySessionId: row?.id ?? null,
      partyCreatedAtMs: row ? Number(row.created_at_ms) : null,
    };
  } catch (error) {
    logLookupFailure(channelId, "requested-mode", error);
    return null;
  }
}

/** `POST /api/watch-parties/:id/state`'s `goLive` handler calls this with the party's own row id. */
export async function setRequestedHlsMode(
  watchPartySessionId: string,
  requested: boolean,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE channel_sessions SET low_latency_requested = $1 WHERE id = $2`,
      [requested, watchPartySessionId],
    );
    // NOTHING TO FORGET. The demotion memo below is keyed by the party that
    // was demoted, and a new party is a new `channel_sessions` row, so its
    // id was never in the map: the newest statement about this channel wins
    // by construction rather than by a cache invalidation that only the
    // machine serving this HTTP request could perform (the 2026-09-15
    // production failure — see `noteLlDemotion`).
  } catch (error) {
    logEvent("voice.hlsLlRequestedModeWriteFailed", {
      watchPartySessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * THE SAME WINDOW THE BOX USES, on this side of the wire.
 * `DEMOTE_WINDOW_MS` in `internal/control/watchdog.go` is five minutes: a
 * second stall inside it demotes for good, a stall further apart is a fresh
 * episode. A demotion here means the same thing about the party, so a party
 * demoted inside this window does not get LL re-selected however many times
 * the mode is re-resolved.
 */
const LL_DEMOTION_MEMO_MS = 5 * 60_000;

/** When a party's LL session was demoted, keyed by `channel_sessions.id`. */
const llDemotedAt = new Map<string, number>();

/**
 * WHY BOTH A MEMO AND A COLUMN WRITE, AND WHY THE MEMO IS KEYED BY PARTY.
 *
 * `low_latency_requested` is the durable half: cleared, every reconcile on
 * every machine resolves `conventional` for the rest of this party, and the
 * next `goLive` writes it again unconditionally (`setRequestedHlsMode`), so a
 * demotion never outlives the party it happened to. That is the answer that
 * has to be right.
 *
 * The memo is the belt. The write can fail, and the read it feeds is a
 * DIFFERENT query on a different tick — between the demotion and the clear
 * landing, `liveHlsRequestForChannel` would still answer `true` and
 * `reconcileLiveHlsNow` would start a second LL session on top of the one
 * just given up on, which is the loop this whole fallback exists to end.
 * Process-local and five minutes long, it costs nothing and closes that gap
 * on the machine that did the demoting — the one that is about to reconcile.
 *
 * IT USED TO BE KEYED BY CHANNEL, AND ON TWO MACHINES THAT WAS WRONG.
 * Channel `d5559e70`, 2026-09-15: instance A demoted a session at 15:23:14
 * and memoed the channel. At 15:26:52 the host created a NEW party with the
 * switch on; the HTTP request landed on instance B, which wrote
 * `low_latency_requested = true` and cleared its own (empty) memo. The share
 * a few seconds later reconciled on A, whose channel memo was still set, so
 * the API silently started the conventional ladder for a party whose row
 * said `true` — the same shape as #603/#605/#606/#618/#625, per-process
 * state the other machine cannot see.
 *
 * Keyed by the demoted party's own id there is nothing to invalidate: a new
 * party has a new id and no entry, so the memo can only ever veto the one
 * party it is a verdict about, on the one machine that reached that verdict.
 * Entries are pruned on write and expire with the window, so a party that
 * ends takes its entry with it within five minutes either way.
 */
export function noteLlDemotion(partySessionId: string, now = Date.now()): void {
  ensureMemoPruneTimer();
  if (llDemotedAt.has(partySessionId)) {
    // Re-noting the same party: refresh it and move it to the end, so
    // insertion order stays write order for the eviction rule below.
    llDemotedAt.delete(partySessionId);
    llDemotedAt.set(partySessionId, now);
    return;
  }
  if (llDemotedAt.size >= MAX_LL_DEMOTION_MEMOS) {
    // THE CAP MAY ONLY TAKE AN EXPIRED ENTRY. Evicting the oldest outright
    // discards a LIVE veto, and the party it is about is then free to be
    // handed LL again inside the very window the memo exists to cover -- the
    // database-failure window, which is exactly when a burst of demotions
    // would fill this map in the first place (a Farol finding on this PR).
    //
    // One look answers it: insertion order is write order, so if the least
    // recently written entry is not expired, nothing else is either.
    const oldest = llDemotedAt.entries().next();
    if (!oldest.done && now - oldest.value[1] > LL_DEMOTION_MEMO_MS) {
      llDemotedAt.delete(oldest.value[0]);
    } else {
      // A thousand live demotions inside five minutes is a catastrophe, not
      // a busy evening. Nothing is dropped and the answer for every party
      // becomes "no LL until the sweep prunes this" -- fail closed, because
      // the alternative is guessing which veto was safe to lose.
      noteDemotionMemoFull(partySessionId, now);
      return;
    }
  }
  llDemotedAt.set(partySessionId, now);
}

/**
 * The memo is full of vetoes that are all still live. Until the sweep can
 * prune it, `llDemotedRecently` answers yes for every party: the one thing
 * that must not happen is a demoted party being handed LL again because its
 * entry lost a race for a slot.
 */
let memoSaturatedAt: number | null = null;
const MEMO_FULL_LOG_WINDOW_MS = 60_000;
let memoFullLoggedAt = 0;

function noteDemotionMemoFull(partySessionId: string, now: number): void {
  memoSaturatedAt = now;
  if (now - memoFullLoggedAt < MEMO_FULL_LOG_WINDOW_MS) {
    return;
  }
  memoFullLoggedAt = now;
  logEvent("voice.hlsLlDemotionMemoFull", {
    partySessionId,
    entries: llDemotedAt.size,
    cap: MAX_LL_DEMOTION_MEMOS,
  });
}

function demotionMemoSaturated(now: number): boolean {
  return (
    memoSaturatedAt !== null && now - memoSaturatedAt < LL_DEMOTION_MEMO_MS
  );
}

/**
 * WHEN A MAP KEYED ON A CLOCK ACTUALLY SHRINKS.
 *
 * Both of these expire on time rather than on an event, and the first
 * version swept them only when something was written to them: a burst of
 * demotions followed by a quiet evening left every historical party id in
 * memory until the next demotion happened to sweep it, and logging one
 * channel's decision walked every other channel's entry, which is O(C^2)
 * across a burst (two Farol findings on this PR).
 *
 * So they are swept from `sweepLlDemotions`, on the health monitor's
 * ten-second tick, whether or not anything is demoted -- and BEFORE that
 * function's own configuration check, because "LL is on but the remux
 * control URL is missing" is a deployment that still resolves modes, still
 * fills `lastModeResolved`, and used to get no pruning at all (a third).
 *
 * THE WRITE PATHS NEVER SCAN, NOT EVEN PAST A THRESHOLD. A first version
 * swept from the write once a map was large, which is the same quadratic
 * shape one threshold further out: with the map big, every demotion and
 * every mode line walks every entry (a Farol finding on this PR). A write is
 * `rememberBounded`, which is three constant-time Map operations and a
 * single eviction of the least recently written key when the cap is hit --
 * insertion order IS the eviction order, which is why a repeat write deletes
 * before it sets. So memory is bounded whether or not anything ever sweeps,
 * and nothing on the reconcile path is ever O(entries).
 *
 * A process with no monitor (the flag on, live HLS off, a test) gets a lazy
 * unref'd timer on its first insert, so the maps still empty on a clock
 * rather than merely staying under their cap.
 */
const MAX_LL_DEMOTION_MEMOS = 1024;
const MAX_MODE_DECISION_MEMOS = 1024;
const MEMO_PRUNE_INTERVAL_MS = 60_000;

let memoPruneTimer: ReturnType<typeof setInterval> | null = null;
/** Only a test reads it: what proves the write path does not walk the map. */
let memoEntriesScanned = 0;

function ensureMemoPruneTimer(): void {
  if (memoPruneTimer) {
    return;
  }
  memoPruneTimer = setInterval(() => {
    pruneLlMemos(Date.now());
  }, MEMO_PRUNE_INTERVAL_MS);
  memoPruneTimer.unref?.();
}

/**
 * Constant time, always. The delete before the set is not redundant: a Map
 * keeps its original insertion position on an overwrite, so without it the
 * eviction below would drop the key that has been written most often rather
 * than the one written longest ago.
 *
 * ONLY FOR `lastModeResolved`, whose entries are a log rate limit: losing one
 * costs an extra line and nothing else. `llDemotedAt` holds vetoes and refuses
 * to drop a live one, so it has its own rule in `noteLlDemotion`.
 */
function rememberBounded<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  cap: number,
): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  ensureMemoPruneTimer();
}

function pruneLlMemos(now: number): void {
  memoEntriesScanned += llDemotedAt.size + lastModeResolved.size;
  for (const [id, at] of llDemotedAt) {
    if (now - at > LL_DEMOTION_MEMO_MS) {
      llDemotedAt.delete(id);
    }
  }
  // SATURATION IS A STATEMENT ABOUT CAPACITY, SO IT IS RE-READ FROM CAPACITY.
  // A first version cleared it on every sweep, whether or not the sweep had
  // freed anything: a memo of 1,024 vetoes that are ALL still live prunes to
  // 1,024 vetoes, and clearing the flag there lifts the fail-closed answer
  // while the condition that demanded it is exactly as true as it was (a
  // Farol finding on PR #630, recorded as a known edge case at merge). The
  // party that could not be recorded would then be handed LL again, which is
  // the one outcome this whole memo exists to prevent.
  if (llDemotedAt.size < MAX_LL_DEMOTION_MEMOS) {
    memoSaturatedAt = null;
  } else if (memoSaturatedAt !== null) {
    // Still full, still saturated -- and re-stamped, so the flag's own
    // five-minute expiry cannot lapse underneath a condition that has not
    // ended. It ends when a sweep finds room, and not before.
    memoSaturatedAt = now;
  }
  for (const [id, entry] of lastModeResolved) {
    if (now - entry.at > MODE_RESOLVED_LOG_WINDOW_MS) {
      lastModeResolved.delete(id);
    }
  }
}

/**
 * Read by `resolveHlsModeForChannel`: LL is off for THIS party. A party we
 * could not identify (`null`) is never vetoed — the memo is a statement
 * about one party, and with no id to compare there is nothing it can say.
 */
export function llDemotedRecently(
  partySessionId: string | null,
  now = Date.now(),
): boolean {
  if (partySessionId === null) {
    return false;
  }
  if (demotionMemoSaturated(now)) {
    return true;
  }
  const at = llDemotedAt.get(partySessionId);
  return at !== undefined && now - at < LL_DEMOTION_MEMO_MS;
}

/**
 * A DEMOTION ON THIS CHANNEL WHOSE PARTY WE DO NOT YET KNOW.
 *
 * `hls_sessions.watch_party_session_id` is NULL for two reasons a row cannot
 * tell apart (see `attributeDemotion`), so a demotion can be queued with no
 * party to key the memo by -- and with the memo keyed by party, that left the
 * window between the demotion and the attribution landing completely
 * unguarded: a reconcile in between reads `low_latency_requested = true` and
 * starts LL straight back into the session the box has just given up on,
 * which is the loop the memo exists to end (a Farol finding on this PR; the
 * old channel-keyed memo covered it by covering everything).
 *
 * So while attribution is outstanding, a demotion vetoes the channel again --
 * but only a party that could actually BE the demoted one. A party created
 * after the demoted session started emphatically could not (the same bound
 * `attributeDemotion` uses), so the newer-party downgrade this whole change
 * exists to prevent stays prevented, on either machine.
 *
 * IT LASTS AS LONG AS THE DEMOTION DOES, not five minutes. A first version
 * expired this with `LL_DEMOTION_MEMO_MS` while the entry could still be
 * queued for retry for half an hour, so a prolonged attribution failure --
 * the very thing that produces an unattributed demotion in the first place --
 * reopened the window at the five minute mark and let LL restart into the
 * session the box had given up on (a Farol finding on this PR). The honest
 * rule is the one the entry itself states: while a demotion on this channel
 * does not know whose party it was, a party that could be it is refused.
 *
 * Self-limiting even so: attribution resolves on the very next
 * `runPendingDemotions`, which is the bottom of the same sweep, and fails
 * closed onto the live party after three attempts, which sets
 * `partySessionId` and ends this branch. The entry is dropped on completion
 * and abandoned after `DEMOTION_RETRY_TTL_MS` regardless.
 */
export function llDemotionPendingAttribution(
  channelId: string,
  partyCreatedAtMs: number | null,
): boolean {
  const entry = pendingDemotions.get(channelId);
  if (!entry || entry.partySessionId !== null || partyCreatedAtMs === null) {
    return false;
  }
  return partyCreatedAtMs <= entry.startedAtMs;
}

/** What `resolveHlsModeForChannel` decided, and every input it decided on. */
export interface ResolvedHlsMode {
  mode: "conventional" | "ll";
  /** The live party's `low_latency_requested`. */
  requested: boolean;
  /** The live party, or `null` when there is none. */
  partySessionId: string | null;
  /** That party's LL session was demoted on this machine inside the window. */
  partyDemoted: boolean;
  /**
   * A demotion on this channel is still waiting to learn whose party it was,
   * and this party is old enough to be it. Fails closed the same way
   * `partyDemoted` does; see `llDemotionPendingAttribution`.
   */
  demotionUnattributed: boolean;
  /** `LIVE_HLS_LL` on, a playlist front configured, and this server allowed. */
  llAvailable: boolean;
}

/**
 * THE WHOLE MODE DECISION, IN ONE PLACE, AND IT SAYS WHY.
 *
 * `reconcileLiveHlsNow` used to read the request, consult the memo and call
 * `resolveHlsMode` itself, and log nothing: a conventional ladder starting
 * for a party that asked for LL produced `voice.hlsStarted` and not one line
 * saying which of the four inputs said no. That is how the 2026-09-15
 * failure above went unexplained for an afternoon (pitfall 16's lesson: an
 * endpoint that refuses somebody must say why).
 *
 * `null` is "could not ask" and NOT a mode: the caller must change nothing
 * at all this reconcile. See `liveHlsRequestForChannel`.
 */
export async function resolveHlsModeForChannel(
  channelId: string,
  serverId: string | null | undefined,
  options: { sharing: boolean } = { sharing: false },
): Promise<ResolvedHlsMode | null> {
  // With `LIVE_HLS_LL` unset there is nothing to ask the database: no LL
  // session can exist, and a transient read failure must not be able to skip
  // the conventional reconcile (a Farol finding on the rebased PR #580: the
  // lookup ran, and failed closed, even with the flag off).
  const request: LiveHlsRequest | null = isLiveHlsLLEnabled()
    ? await liveHlsRequestForChannel(channelId)
    : { requested: false, partySessionId: null, partyCreatedAtMs: null };
  if (request === null) {
    return null;
  }
  const partyDemoted = llDemotedRecently(request.partySessionId);
  const demotionUnattributed = llDemotionPendingAttribution(
    channelId,
    request.partyCreatedAtMs,
  );
  const llAvailable = liveHlsLLAvailable(serverId);
  const mode = resolveHlsMode({
    serverId,
    requestedMode: request.requested && !partyDemoted && !demotionUnattributed,
  });
  // ONLY WHILE THERE IS A CHOICE TO EXPLAIN. With `LIVE_HLS_LL` unset every
  // decision is `conventional` for the one reason nobody needs telling, and
  // this whole branch is meant to leave the flag-off deployment byte-for-byte
  // what it was before L1.5 -- a log line a self-host cannot act on is not an
  // exception to that. The allowlist case IS logged, because "the flag is on
  // and this server still got conventional" is a real question.
  if (isLiveHlsLLEnabled()) {
    logHlsModeResolved({
      channelId,
      partySessionId: request.partySessionId,
      requested: request.requested,
      partyDemoted,
      demotionUnattributed,
      llAvailable,
      mode,
      sharing: options.sharing,
    });
  }
  return {
    mode,
    requested: request.requested,
    partySessionId: request.partySessionId,
    partyDemoted,
    demotionUnattributed,
    llAvailable,
  };
}

/**
 * ONE LINE PER DECISION, NOT PER ROSTER EVENT. `reconcileLiveHlsNow` runs on
 * every roster change, every `set-camera` frame and every relay push, so an
 * unconditional log here would be several lines a second for a busy room and
 * the useful one would be invisible. Logged when the decision CHANGES for a
 * channel — which is what a share starting, a mode flipping or a demotion
 * landing all are — and re-stated at most once per window otherwise, so a
 * long party still leaves a trail rather than one line at the start.
 */
const MODE_RESOLVED_LOG_WINDOW_MS = 5 * 60_000;
const lastModeResolved = new Map<string, { key: string; at: number }>();

function logHlsModeResolved(fields: {
  channelId: string;
  partySessionId: string | null;
  requested: boolean;
  partyDemoted: boolean;
  demotionUnattributed: boolean;
  llAvailable: boolean;
  mode: "conventional" | "ll";
  sharing: boolean;
}): void {
  const now = Date.now();
  const key = [
    fields.partySessionId ?? "-",
    fields.requested,
    fields.partyDemoted,
    fields.demotionUnattributed,
    fields.llAvailable,
    fields.mode,
    fields.sharing,
  ].join("|");
  const last = lastModeResolved.get(fields.channelId);
  if (last && last.key === key && now - last.at < MODE_RESOLVED_LOG_WINDOW_MS) {
    return;
  }
  // No sweep here at ANY size: one channel's log line must never walk every
  // other channel's entry (a Farol finding on this PR, twice). The cap in
  // `rememberBounded` bounds the map in constant time; `pruneLlMemos` empties
  // it on the health tick or the lazy timer.
  rememberBounded(
    lastModeResolved,
    fields.channelId,
    { key, at: now },
    MAX_MODE_DECISION_MEMOS,
  );
  logEvent("voice.hlsModeResolved", fields);
}

/**
 * A DEMOTION IS THREE WRITES, AND IT IS NOT DONE UNTIL ALL THREE ARE.
 *
 * Stopping the box session and ending the row; clearing the party's
 * `low_latency_requested`; and getting the conventional ladder started. Each
 * one can fail on its own, and the first version did them once and hoped: a
 * database blip at the wrong moment left `low_latency_requested` true for a
 * party whose remux had already given up, and the moment the five-minute memo
 * expired a reconcile started LL for it all over again, into the same failure
 * (a Farol finding on PR #618).
 *
 * So a demotion becomes an entry here, and the health monitor's tick re-runs
 * whatever is still outstanding until it lands. Every step is idempotent by
 * construction -- `retryStopOpenLlRow` only clears a row the box has
 * confirmed gone, the mode clear is a conditional UPDATE, and the reconcile
 * is a reconcile -- so re-running a step that half-succeeded is safe rather
 * than merely tolerable.
 *
 * ONE ENTRY PER CHANNEL, backed off, and bounded. A channel cannot be demoted
 * twice at once, the queue must not turn one unhappy database into repeated
 * serialized work on every tick, and a process that somehow queued thousands
 * would be leaking memory for state that stops being useful within the hour.
 */
interface PendingDemotion {
  channelId: string;
  /** The remux session that was demoted: the identity every step is about. */
  sessionId: string;
  /** Its `hls_sessions` row. Re-claimed on every attempt, never assumed. */
  rowId: string;
  /**
   * The party that asked for LL, read off the row. NULL is UNKNOWN, never
   * "there was none": the lookup that would have recorded it can itself have
   * failed at start, and treating that as "nothing to clear" leaves
   * `low_latency_requested` true for exactly the party the demotion is about
   * (a Farol finding on PR #618). Re-attributed lazily below.
   */
  partySessionId: string | null;
  /** When the demoted session started: what bounds a lazy re-attribution. */
  startedAtMs: number;
  /** How many times the lazy attribution has come back empty. */
  attributionAttempts: number;
  /** The box's own word for why. Carried into every log line. */
  reason: string;
  queuedAt: number;
  nextAttemptAt: number;
  attempts: number;
  /** The box session is gone and the row is ended. */
  stopped: boolean;
  /** `low_latency_requested` is FALSE, or there was never anything to clear. */
  cleared: boolean;
}

const pendingDemotions = new Map<string, PendingDemotion>();

/** As long as a demotion's own memo could still be the only thing holding LL off. */
const DEMOTION_RETRY_TTL_MS = 30 * 60_000;
/** Exponential, capped at a minute: a tick is 10s and the queue is a repair. */
const DEMOTION_BACKOFF_STEPS_MS = [0, 1_000, 5_000, 15_000, 30_000, 60_000] as const;
/**
 * More demoted channels than any deployment can plausibly have live at once.
 * Past it the OLDEST entry is dropped, loudly: an unbounded repair queue is a
 * leak, and the entry most likely to be worthless is the one that has been
 * failing longest.
 */
const MAX_PENDING_DEMOTIONS = 64;

function demotionBackoffMs(attempts: number): number {
  return DEMOTION_BACKOFF_STEPS_MS[
    Math.min(attempts, DEMOTION_BACKOFF_STEPS_MS.length - 1)
  ]!;
}

/** For the dashboard and the tests: demotions whose cleanup is not finished. */
export function pendingLlDemotionCount(): number {
  return pendingDemotions.size;
}

/**
 * How much the two clock-expiry memos are actually holding. Only a test asks:
 * "an expired entry is ignored" and "an expired entry is gone" read the same
 * from every other seam, and it was the second one Farol was right about.
 */
export function llMemoSizesForTests(): {
  demotedParties: number;
  modeDecisions: number;
  /** Entries any full sweep has walked since the last reset. */
  entriesScanned: number;
} {
  return {
    demotedParties: llDemotedAt.size,
    modeDecisions: lastModeResolved.size,
    entriesScanned: memoEntriesScanned,
  };
}

function queueDemotion(entry: PendingDemotion): void {
  if (!pendingDemotions.has(entry.channelId)) {
    while (pendingDemotions.size >= MAX_PENDING_DEMOTIONS) {
      const oldest = [...pendingDemotions.values()].reduce((a, b) =>
        a.queuedAt <= b.queuedAt ? a : b,
      );
      pendingDemotions.delete(oldest.channelId);
      logEvent("voice.hlsLlDemotionCleanupDropped", {
        channelId: oldest.channelId,
        reason: "queue-full",
      });
    }
  }
  pendingDemotions.set(entry.channelId, entry);
}

/**
 * The durable half of the fallback: THE party that asked stops asking.
 *
 * SCOPED TO THE PARTY ROW THE SESSION RECORDED, not to "whatever is live on
 * this channel". Those are the same answer most of the time and a different
 * one exactly when it matters: a cleanup that runs late (a retry after a
 * database failure, a slow tick) would otherwise clear a NEWER party's
 * request, silently downgrading a party that never had anything go wrong (a
 * Farol finding on PR #618). `hls_sessions.watch_party_session_id` is written
 * when the session starts, which is the one moment the two questions are
 * certainly the same, and read back off the row here.
 *
 * Answers whether this step is done. A party with no recorded id (a row from
 * before that column, or a session started with no live party) has nothing
 * durable to clear and says so: the five-minute memo is the whole fallback
 * there, which is what it is for.
 *
 * Never a silent write -- pitfall 15's rule -- because a party that quietly
 * stopped being low-latency is exactly the kind of state change nobody can
 * explain a week later.
 */
async function clearPartyLlRequest(entry: PendingDemotion): Promise<boolean> {
  if (entry.partySessionId === null && !(await attributeDemotion(entry))) {
    return false;
  }
  if (entry.partySessionId === null) {
    logEvent("voice.hlsLlRequestClearSkipped", {
      channelId: entry.channelId,
      reason: entry.reason,
    });
    return true;
  }
  try {
    const result = await getPool().query(
      `UPDATE channel_sessions SET low_latency_requested = FALSE
        WHERE id = $1 AND status = 'live' AND low_latency_requested`,
      [entry.partySessionId],
    );
    logEvent("voice.hlsLlRequestCleared", {
      channelId: entry.channelId,
      partySessionId: entry.partySessionId,
      reason: entry.reason,
      rows: result.rowCount ?? 0,
    });
    return true;
  } catch (error) {
    logEvent("voice.hlsLlRequestedModeWriteFailed", {
      channelId: entry.channelId,
      partySessionId: entry.partySessionId,
      reason: entry.reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * WORK OUT WHICH PARTY THIS SESSION BELONGED TO, AFTER THE FACT.
 *
 * `watch_party_session_id` is NULL for two different reasons and the row
 * cannot tell them apart: the session genuinely started with no live party
 * row, or the SELECT that would have recorded one failed. Reading NULL as the
 * first was the last hole in the fallback (a Farol finding on PR #618): the
 * demotion found nothing to clear, said so, and `low_latency_requested`
 * stayed true until the five-minute memo lapsed and a reconcile started LL
 * again, into the same failure.
 *
 * So NULL is treated as UNKNOWN and resolved here, bounded by the session's
 * own start: a party that was already live when the session began is one that
 * could have asked for it, and a party created afterwards is emphatically not
 * (that is the newer-party downgrade this whole attribution exists to avoid).
 *
 * FAILS CLOSED AFTER `ATTRIBUTION_MAX_ATTEMPTS`. If nothing can be attributed
 * that way, and a party is live on the channel, its request is cleared anyway
 * with a log that says the attribution was never established: a party
 * downgraded to the conventional ladder it was going to be handed anyway is a
 * smaller harm than a party looping back into a remux session that has
 * already given up. Answers whether the caller may proceed; `false` is "ask
 * again next tick".
 */
const ATTRIBUTION_MAX_ATTEMPTS = 3;

async function attributeDemotion(entry: PendingDemotion): Promise<boolean> {
  try {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM channel_sessions
        WHERE channel_id = $1 AND status = 'live'
          AND created_at <= to_timestamp($2 / 1000.0)
        ORDER BY created_at DESC
        LIMIT 1`,
      [entry.channelId, entry.startedAtMs],
    );
    const id = result.rows[0]?.id ?? null;
    if (id !== null) {
      entry.partySessionId = id;
      // NOW the memo can name a party. Until this resolved there was nothing
      // to key it by; see the memo note at the demotion site.
      noteLlDemotion(id);
      logEvent("voice.hlsLlDemotionAttributed", {
        channelId: entry.channelId,
        partySessionId: id,
        attempts: entry.attributionAttempts,
      });
      return true;
    }
  } catch (error) {
    logLookupFailure(entry.channelId, "requested-mode", error);
    return false;
  }
  entry.attributionAttempts += 1;
  if (entry.attributionAttempts < ATTRIBUTION_MAX_ATTEMPTS) {
    return false;
  }
  const live = await liveWatchPartyId(entry.channelId);
  if (!live.ok) {
    return false;
  }
  if (live.id === null) {
    // Nothing live to clear at all, which is the ordinary "the party already
    // ended" case. Proceed; the caller logs the skip.
    return true;
  }
  entry.partySessionId = live.id;
  // Failing closed onto whatever is live is already a documented tradeoff
  // (see above). The memo follows exactly the party the clear names, never
  // the channel, so the blast radius stays one party either way.
  noteLlDemotion(live.id);
  logEvent("voice.hlsLlRequestClearUnattributed", {
    channelId: entry.channelId,
    partySessionId: live.id,
    reason: entry.reason,
    attempts: entry.attributionAttempts,
  });
  return true;
}

/**
 * The live party on this channel right now. Used when a session starts,
 * to record which party asked; a demotion reads the recorded id instead (see
 * `clearPartyLlRequest`). `{ ok: false }` is a read that failed, which is NOT
 * "no party" -- the same distinction `findOpenLlRow` makes, for the same
 * reason.
 */
async function liveWatchPartyId(
  channelId: string,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  try {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM channel_sessions
        WHERE channel_id = $1 AND status = 'live'
        ORDER BY created_at DESC
        LIMIT 1`,
      [channelId],
    );
    return { ok: true, id: result.rows[0]?.id ?? null };
  } catch (error) {
    logLookupFailure(channelId, "requested-mode", error);
    return { ok: false };
  }
}

/**
 * Work the queue, and answer the channels whose conventional ladder should be
 * (re)started this tick. Dropped past `DEMOTION_RETRY_TTL_MS`: by then the
 * party has either ended, in which case every remaining step is a no-op, or
 * been going half an hour with a request nothing could act on, and replaying
 * the repair forever is its own failure.
 */
async function runPendingDemotions(now = Date.now()): Promise<string[]> {
  const reconcile: string[] = [];
  for (const [channelId, entry] of [...pendingDemotions]) {
    if (now - entry.queuedAt > DEMOTION_RETRY_TTL_MS) {
      pendingDemotions.delete(channelId);
      logEvent("voice.hlsLlDemotionCleanupAbandoned", {
        channelId,
        reason: entry.reason,
        attempts: entry.attempts,
        stopped: entry.stopped,
        cleared: entry.cleared,
      });
      continue;
    }
    if (now < entry.nextAttemptAt) {
      continue;
    }
    entry.attempts += 1;
    entry.nextAttemptAt = now + demotionBackoffMs(entry.attempts);

    if (!entry.stopped) {
      // STILL OURS? Re-asked on every attempt, not assumed from the attempt
      // that queued this: if this process's heartbeat lapsed in between,
      // another instance is entitled to have taken the row, and stopping the
      // box session or rewriting the row from here would kill a stream the
      // new owner is driving.
      const lookup = await findOpenLlRow(channelId);
      if (!lookup.ok) {
        continue;
      }
      const row = lookup.row;
      if (!row || row.id !== entry.rowId) {
        // The row this demotion was about is closed (or replaced). Nothing of
        // ours is open on the box under it; the remaining steps stand alone.
        entry.stopped = true;
      } else {
        const claim = await claimHlsSessionRow(row.id);
        if (claim === "refused") {
          pendingDemotions.delete(channelId);
          noteHlsSkippedOwnedElsewhere({
            site: "ll-demote",
            channelId,
            sessionId: row.id,
            ownerInstanceId: row.instanceId,
          });
          continue;
        }
        if (claim === "failed") {
          continue;
        }
        entry.stopped = await retryStopOpenLlRow(row, channelId);
      }
    }
    if (!entry.cleared) {
      entry.cleared = await clearPartyLlRequest(entry);
    }
    // ASKED FOR ON EVERY ATTEMPT, not only the first: the conventional ladder
    // is the whole point of the fallback, and a reconcile that did not manage
    // to start one (no sharer yet, a LiveKit hiccup) has to be asked again.
    reconcile.push(channelId);
    if (entry.stopped && entry.cleared) {
      pendingDemotions.delete(channelId);
    }
  }
  return reconcile;
}

// ---------------------------------------------------------------------------
// Control-plane client: signing and the three routes
// ---------------------------------------------------------------------------

function envTrimmed(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Base URL of the control API, e.g. `https://egress-1.pqp.gg:8443`. No trailing slash. */
export function remuxControlUrl(): string | null {
  const raw = envTrimmed("LIVE_HLS_REMUX_CONTROL_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function remuxControlSecret(): string | null {
  return envTrimmed("LIVE_HLS_REMUX_CONTROL_SECRET");
}

/**
 * Where parts and playlists for a session are actually served from (Caddy on
 * the egress box, `docs/plans/LL_HLS.md` §1), distinct from the control URL
 * above, which never serves media. Required to start a session: a session
 * nothing can ever play is not worth starting. NEVER sent to a client — see
 * `llPlaylistUrl`'s doc comment.
 */
export function remuxOriginBaseUrl(): string | null {
  const raw = envTrimmed("LIVE_HLS_REMUX_ORIGIN_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * What a fresh session is started with. Every field here is a `pqp-remux`
 * config knob (`tools/pqp-remux/README.md` "Config") re-exposed as a
 * `pqp-api` env var of the same shape, prefixed `LIVE_HLS_REMUX_` to keep
 * "this box's own env" and "what the API asked the box for" visibly
 * separate. Defaults match the Go binary's own defaults, so an operator who
 * sets nothing gets the same session `pqp-remux` would run standalone.
 */
export function remuxSessionConfig(): {
  partMs: number;
  segmentMs: number;
  ringSegments: number;
  keyframePolicy: RemuxKeyframePolicy;
  pliPaceMs: number;
  pliGateFactor: number;
} {
  const policy = process.env.LIVE_HLS_REMUX_KEYFRAME_POLICY?.trim();
  return {
    partMs: positiveIntFromEnv("LIVE_HLS_REMUX_PART_MS", 500),
    segmentMs: positiveIntFromEnv("LIVE_HLS_REMUX_SEGMENT_MS", 4000),
    ringSegments: positiveIntFromEnv("LIVE_HLS_REMUX_RING_SEGMENTS", 6),
    keyframePolicy: policy === "pli" ? "pli" : "natural",
    pliPaceMs: positiveIntFromEnv("LIVE_HLS_REMUX_PLI_PACE_MS", 500),
    // 1, not 1.5. The remux closes a segment on the first IDR at or
    // AFTER `segmentMs`, and a Chromium screen share only sends an IDR
    // when asked, so a gate of 1.5x makes the earliest boundary the
    // fragmenter can possibly see land at 1.5x the target. Production on
    // 2026-09-15 ran 1.5 against a 4s target and closed segments at 7 to
    // 11 seconds (`targetDurationSecs` 11). See
    // `tools/pqp-remux/internal/keyframe/gater.go`'s `defaultGateFactor`,
    // which this has to stay equal to -- the comment there is the long
    // version, and "defaults match the Go binary's own defaults" above is
    // the rule.
    pliGateFactor: positiveFloatFromEnv("LIVE_HLS_REMUX_PLI_GATE_FACTOR", 1),
  };
}

/** What the go-live badge claims for an LL session. Not yet measured (`L3.x`). */
export function llDelaySeconds(): number {
  return positiveIntFromEnv("LIVE_HLS_REMUX_DELAY_SECONDS", 3);
}

const REMUX_CONTROL_TIMEOUT_MS = 5_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
let nowImpl: () => number = () => Date.now();

/** Test hook: inject a fake control server and a fake clock for signing. */
export function setHlsRemuxTestHooks(hooks: {
  fetch?: FetchLike;
  now?: () => number;
}): void {
  if (hooks.fetch) {
    fetchImpl = hooks.fetch;
  }
  if (hooks.now) {
    nowImpl = hooks.now;
  }
}

export class RemuxControlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RemuxControlError";
  }
}

function signRequest(
  method: string,
  path: string,
  rawBody: string,
): { timestamp: string; nonce: string; signature: string } {
  const secret = remuxControlSecret();
  if (!secret) {
    throw new RemuxControlError("LIVE_HLS_REMUX_CONTROL_SECRET is not set");
  }
  const timestamp = String(nowImpl());
  // 16 random bytes as hex (32 chars): well within pqp-remux's maxNonceLen
  // (256) and, per request, unlikely enough to repeat that the box's replay
  // cache (2x the clock-skew window) can treat an exact match as a replay.
  const nonce = randomBytes(16).toString("hex");
  const payload = remuxControlSignaturePayload(method, path, timestamp, nonce, rawBody);
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return { timestamp, nonce, signature };
}

/** `POST`/`GET`/`DELETE` against the control API, signed, with a hard timeout. */
async function remuxFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const base = remuxControlUrl();
  if (!base) {
    throw new RemuxControlError("LIVE_HLS_REMUX_CONTROL_URL is not set");
  }
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const { timestamp, nonce, signature } = signRequest(method, path, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMUX_CONTROL_TIMEOUT_MS);
  try {
    return await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        [REMUX_CONTROL_TIMESTAMP_HEADER]: timestamp,
        [REMUX_CONTROL_NONCE_HEADER]: nonce,
        [REMUX_CONTROL_SIGNATURE_HEADER]: signature,
      },
      body: rawBody.length > 0 ? rawBody : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed = remuxErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return parsed.data.error;
    }
  } catch {
    // Not JSON, or not the expected shape. Fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
}

async function remuxStartSession(
  input: ReturnType<typeof buildStartRequest>,
): Promise<RemuxSessionInfo> {
  const response = await remuxFetch("POST", "/sessions", input);
  if (response.status !== 200 && response.status !== 201 && response.status !== 409) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
  return remuxSessionInfoSchema.parse(await response.json());
}

async function remuxStopSession(sessionId: string): Promise<void> {
  const response = await remuxFetch("DELETE", `/sessions/${sessionId}`);
  // Idempotent: a session already gone is not a failure to stop it.
  if (response.status !== 204 && response.status !== 404) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
}

async function remuxListSessions(): Promise<RemuxSessionInfo[]> {
  const response = await remuxFetch("GET", "/sessions");
  if (response.status !== 200) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
  return remuxListSessionsResponseSchema.parse(await response.json()).sessions;
}

/**
 * The box's current answer for one specific session id.
 *
 * THREE ANSWERS, not two: collapsing a list failure into "not found" was how
 * a transient control-API blip during a rolling deploy could look like "the
 * remux is gone" and hand `startLlSession` a licence to POST a second start
 * on top of a session that was still running. `failed` is "could not ask" —
 * the same fail-closed shape `listActiveEgresses() === null` has on the
 * conventional side — and every caller must treat it as stand-down, never as
 * a reason to start.
 */
async function findRemuxSessionById(
  sessionId: string,
): Promise<RemuxSessionInfo | null | "failed"> {
  try {
    const sessions = await remuxListSessions();
    return sessions.find((session) => session.sessionId === sessionId) ?? null;
  } catch {
    return "failed";
  }
}

function buildStartRequest(input: {
  sessionId: string;
  channelId: string;
}): {
  sessionId: string;
  room: string;
  channelId: string;
  partMs: number;
  segmentMs: number;
  ringSegments: number;
  keyframePolicy: RemuxKeyframePolicy;
  pliPaceMs: number;
  pliGateFactor: number;
} {
  const cfg = remuxSessionConfig();
  return {
    sessionId: input.sessionId,
    // The LiveKit room name IS the voice channel id everywhere else in this
    // codebase (`startRung` passes `channelId` straight to
    // `startTrackCompositeEgress`), so LL keeps the same identity rather than
    // inventing a second name for the same room.
    room: input.channelId,
    channelId: input.channelId,
    partMs: cfg.partMs,
    segmentMs: cfg.segmentMs,
    ringSegments: cfg.ringSegments,
    keyframePolicy: cfg.keyframePolicy,
    pliPaceMs: cfg.pliPaceMs,
    pliGateFactor: cfg.pliGateFactor,
  };
}

// ---------------------------------------------------------------------------
// Deterministic session identity
// ---------------------------------------------------------------------------

/**
 * The remux `sessionId` for this channel's session that started at this
 * instant — a pure function of the two values, so it is recomputable from
 * the `hls_sessions` row alone, forever, by anything that reads that row: a
 * retried start after an ambiguous POST, a process that restarted between
 * inserting the row and hearing back from the box, or `adoptLlHlsSessions`'s
 * boot sweep. Nothing about "which attempt this is" is ever tracked in
 * memory (see the file header) precisely so this is the only thing that has
 * to be recomputed.
 *
 * sha256 rather than a library UUID v5: no new dependency for one hash, and
 * the version/variant nibbles below only exist to keep the result shaped
 * like every other id in `hls_sessions.remux_session_id` (a
 * `z.string().uuid()` in the wire contract) — collision resistance comes
 * from sha256 over the exact (channelId, startedAt) pair, not from the UUID
 * shape.
 */
export function deriveLlSessionId(channelId: string, startedAt: number): string {
  const hash = createHash("sha256").update(`${channelId}:${startedAt}`).digest("hex");
  const variantNibble = "89ab"[Number.parseInt(hash[16]!, 16) % 4];
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variantNibble}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Session bookkeeping and the DB rows
// ---------------------------------------------------------------------------

interface LlRoom {
  sessionId: string;
  startedAt: number;
  presenterPeerId: string;
  stream: LiveHlsStream;
  /**
   * When THIS process first observed the box session producing no video at
   * all (`partsWritten === 0`), or undefined once it has produced any part.
   * The readiness backstop in `sweepLlDemotions` measures against it. Wall
   * clock here, deliberately not the box's own `startedAtMs`, so neither
   * clock skew nor a resumed session (same id, older box start) can false-trip
   * it: it is "how long have WE seen this stuck", reset the moment a part
   * appears.
   */
  noVideoSinceMs?: number;
}

const llRooms = new Map<string, LlRoom>();

/**
 * How long a live LL room may report zero video before the readiness backstop
 * in `sweepLlDemotions` demotes it. Comfortably past both the observed
 * first-part latency (~12s `playlistWaitMs` in production) and the box's own
 * `FirstPartTimeoutMs` (60s), so this only ever fires when the box's own
 * no-video rule already should have and did not. `LIVE_HLS_LL_READY_TIMEOUT_MS`
 * overrides it; a non-positive or unparseable value keeps the default.
 */
function llReadyTimeoutMs(): number {
  const raw = process.env.LIVE_HLS_LL_READY_TIMEOUT_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 75_000;
}
let llStartFailures = 0;
/** A `remuxStopSession` call failed, at either the normal-stop or retry path. Belongs at zero. */
let llStopFailures = 0;
/**
 * Sessions the box gave up on that this process fell back to the conventional
 * ladder, since boot (`sweepLlDemotions`). Declared and reported since L1.5,
 * and never once incremented until 2026-09-15: the box demoted a live party
 * fourteen seconds in, said so on `GET /sessions`, and nothing on this side
 * was asking. A counter with no writer is pitfall 12's shape, and this one
 * sat at zero through the incident it was invented to name.
 */
let llDemoted = 0;

function llObjectPrefix(channelId: string, startedAt: number): string {
  // Same scheme as `hlsObjectPrefix` in `hls-egress.ts` (`live/<channel>/<startedAt>-<suffix>`),
  // kept as a local literal rather than an import to avoid a two-way module
  // dependency between the two drivers: `hls-egress.ts` calls into this file,
  // this file must never need to reach back into it for a format string.
  return `live/${channelId}/${startedAt}-ll`;
}

/**
 * What a viewer is actually handed as `LiveHlsStream.hlsUrl`, and
 * deliberately the SAME shape `viewerPlaylistUrl` in `hls-egress.ts` uses for
 * the conventional ladder -- never the egress box's raw origin URL, and
 * never anything a client could copy and use to bypass a later access
 * revocation. `origin_base_url` (the egress box's Caddy) stays server-side:
 * it is stored on the row and read by this API's own playlist proxy (once
 * `L2.x` teaches it about `mode: 'll'`), never put in a response.
 *
 * A Farol review of the first version of this file (PR #580) is why: that
 * version pointed `hlsUrl` straight at `${originBaseUrl}/${sessionId}/playlist.m3u8`,
 * an object nothing checks a token against, and every recipient of a
 * `voice-stream` / `channel-live` frame or a `GET /api/channels/:id/live`
 * response would have received a bearer link -- copy it, and anybody in the
 * world who ever saw it could play a private party's stream forever, with no
 * way to revoke it short of ending the session. Routing through this API's
 * own path means every existing consumer (`pushLiveHls`'s per-peer send,
 * `stampViewerStream`) mints and appends the SAME signed, per-user,
 * per-session `?t=` capability the conventional path already requires --
 * `extractChannelId`'s regex in `hls-viewer-token.ts` matches this exact
 * prefix, so it works with no changes there, and the same route's existing
 * refusal of a request with no valid token applies here too (see
 * `hls-playlist-route.test.ts`).
 *
 * THE `?mode=ll` MARKER IS THE POINT OF THIS FUNCTION NOW.
 * `LIVE_HLS_MODE_PARAM` (`packages/shared/src/live-hls.ts`) is what tells the
 * edge Worker's master route that THIS request is for an LL session, so it
 * renders the LL multivariant playlist because the URL says so rather than
 * because a probe of the remux origin happened to find `state.json` already
 * written. Without it the Worker guessed, and a session two hundred
 * milliseconds old — which has no state yet and is unambiguously LL — was
 * answered with the conventional ladder's master four times in production on
 * 2026-09-15. See that constant's doc comment for the whole argument, and
 * `resolveHlsMode` for why an API with no edge front never picks `ll` at all.
 *
 * `stampViewerStream` appends `?t=` with `&` once this has already put a
 * query string on the path, and `extractChannelId` there matches on the path
 * prefix, so neither needed changing.
 *
 * This API's OWN proxy still has no idea what a `mode = 'll'` row is
 * (`renderSignedPlaylist`: `rung IS NULL`, so `sessionRungs` treats it as a
 * pre-ladder single-rendition session and goes looking for a LiveKit-shaped
 * object that was never written) and answers "not found" rather than serving
 * anything. That is why `resolveHlsMode` refuses `ll` with no edge front: the
 * honest failure is never picking the mode, not handing out a URL only a
 * component that is not deployed could answer.
 */
export function llPlaylistUrl(channelId: string, startedAt: number): string {
  return `/api/voice/hls-playlist/${channelId}/${startedAt}?${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`;
}

async function recordLlSessionStarted(
  channelId: string,
  startedAt: number,
  remuxSessionId: string,
  presenterPeerId: string,
  partTargetMs: number,
  originBaseUrl: string,
  watchPartySessionId: string | null,
): Promise<boolean> {
  try {
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, mode, remux_session_id,
          presenter_peer_id, part_target_ms, origin_base_url, instance_id,
          watch_party_session_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 'll', $4, $5, $6, $7, $8, $9)
       ON CONFLICT (object_prefix) DO NOTHING`,
      [
        channelId,
        llObjectPrefix(channelId, startedAt),
        startedAt,
        remuxSessionId,
        presenterPeerId,
        partTargetMs,
        originBaseUrl,
        // Which API process drives this session: the other machine's boot
        // sweep reads it before adopting or ending anything. See
        // `hls-ownership.ts`.
        hlsOwnerInstanceId(),
        // WHICH PARTY ASKED. Recorded here, at the only moment "the party
        // that asked for this session" and "the party that is live on this
        // channel" are certainly the same. A demotion reads it back off the
        // row rather than asking the channel again.
        watchPartySessionId,
      ],
    );
    return true;
  } catch (error) {
    logEvent("voice.hlsLlSessionRecordFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function recordLlSessionEnded(channelId: string, startedAt: number): Promise<void> {
  try {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE object_prefix = $1 AND ended_at IS NULL`,
      [llObjectPrefix(channelId, startedAt)],
    );
  } catch (error) {
    logEvent("voice.hlsLlSessionEndFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One round trip for every stale row, not one per row (a Farol finding on PR #580). */
async function recordLlSessionsEndedByIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  // A queued ownership stamp for a row we are ending would reopen it on its
  // next retry, leaving a row retention can never collect. Drop it first.
  forgetPendingHlsSessionClaims(ids);
  try {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW() WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [ids],
    );
  } catch (error) {
    logEvent("voice.hlsLlSessionEndFailed", {
      ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Mark a row as mid-teardown: `stopping_at` is bumped to now and
 * `stop_attempts` incremented every time this is called, which is the pacing
 * `stopBackoffMs` reads. Keyed by the object prefix, the same way
 * `recordLlSessionEnded` is, since the callers that need this (`stopLlSession`)
 * only have `(channelId, startedAt)` in hand, not a row id.
 */
async function markLlSessionStopping(channelId: string, startedAt: number): Promise<void> {
  try {
    await getPool().query(
      `UPDATE hls_sessions
       SET stopping_at = NOW(), stop_attempts = stop_attempts + 1
       WHERE object_prefix = $1 AND ended_at IS NULL`,
      [llObjectPrefix(channelId, startedAt)],
    );
  } catch (error) {
    logEvent("voice.hlsLlSessionRecordFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Start / stop / reconcile — the seam `hls-egress.ts` calls
// ---------------------------------------------------------------------------

/** Whether this process currently holds an LL session for this channel. */
export function llHasRoom(channelId: string): boolean {
  return llRooms.has(channelId);
}

export function llStreamFor(channelId: string): LiveHlsStream | null {
  return llRooms.get(channelId)?.stream ?? null;
}

interface OpenLlRow {
  id: string;
  startedAtMs: number;
  remuxSessionId: string | null;
  presenterPeerId: string | null;
  stoppingAtMs: number | null;
  stopAttempts: number;
  /** Which API process last started, resumed or adopted it. NULL = nobody's. */
  instanceId: string | null;
  /** The `channel_sessions` row that asked for LL. NULL on a pre-column row. */
  watchPartySessionId: string | null;
  /**
   * `part_target_ms` AS STORED, which is what a resume must hand the
   * audience rather than whatever `LIVE_HLS_REMUX_PART_MS` says right now:
   * the box session being resumed is still writing at the cadence it was
   * started with, and an operator who changed the env between the two would
   * otherwise have every viewer size their buffer for a cadence nothing is
   * producing. NULL on a row written before the column had a value.
   */
  partTargetMs: number | null;
}

/**
 * This channel's one open (`ended_at IS NULL`) LL row, if any — the durable
 * retry point.
 *
 * FAILS CLOSED: `{ ok: false }` on a database error is a DIFFERENT answer
 * from `{ ok: true, row: null }` ("asked, genuinely no open row"). Collapsing
 * the two into a bare `null` was the bug (a Farol finding on PR #580, fourth
 * round): `startLlSession` would read that as "nothing to resume" and mint a
 * SECOND session while the first might still be running perfectly well, the
 * exact failure this whole file exists to avoid. Every caller must check
 * `ok` before doing anything with `row`.
 */
async function findOpenLlRow(
  channelId: string,
): Promise<{ ok: true; row: OpenLlRow | null } | { ok: false }> {
  try {
    const result = await getPool().query<{
      id: string;
      started_at: string;
      remux_session_id: string | null;
      presenter_peer_id: string | null;
      stopping_at: string | null;
      stop_attempts: number;
      instance_id: string | null;
      watch_party_session_id: string | null;
      part_target_ms: number | null;
    }>(
      `SELECT id, started_at, remux_session_id, presenter_peer_id, stopping_at,
              stop_attempts, instance_id, watch_party_session_id, part_target_ms
       FROM hls_sessions
       WHERE channel_id = $1 AND mode = 'll' AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [channelId],
    );
    const row = result.rows[0];
    if (!row) {
      return { ok: true, row: null };
    }
    return {
      ok: true,
      row: {
        id: row.id,
        startedAtMs: new Date(row.started_at).getTime(),
        remuxSessionId: row.remux_session_id,
        presenterPeerId: row.presenter_peer_id,
        stoppingAtMs: row.stopping_at ? new Date(row.stopping_at).getTime() : null,
        stopAttempts: row.stop_attempts,
        instanceId: row.instance_id,
        watchPartySessionId: row.watch_party_session_id,
        partTargetMs: row.part_target_ms,
      },
    };
  } catch (error) {
    logLookupFailure(channelId, "open-row", error);
    return { ok: false };
  }
}

/** Backoff for retrying a stop: paced, not hammered, on every reconcile or boot sweep. */
const STOP_RETRY_BACKOFF_STEPS_MS = [1_000, 5_000, 15_000, 30_000] as const;
function stopBackoffMs(attempts: number): number {
  return STOP_RETRY_BACKOFF_STEPS_MS[Math.min(attempts, STOP_RETRY_BACKOFF_STEPS_MS.length - 1)]!;
}

/**
 * Retry stopping a row already marked `stopping_at` (or push it into that
 * state for the first time) until the box confirms it. Used both by
 * `startLlSession` (a foreign or mid-teardown row found in this channel's
 * way) and `adoptLlHlsSessions`'s boot sweep — the two places that inherit a
 * row this process's own `llRooms` does not currently explain.
 *
 * Returns whether the row is now closed (`ended_at` set). `false` covers
 * both "still backing off, did not even try" and "tried, the box refused" —
 * callers only ever need to know whether they may now treat the room as
 * free.
 */
async function retryStopOpenLlRow(row: OpenLlRow, channelId: string): Promise<boolean> {
  if (!row.remuxSessionId) {
    // Recorded intent that never got far enough to have a box-side id worth
    // asking about (deterministic, so this can only be a row whose insert
    // succeeded but nothing after it ever ran) — nothing to tell the box.
    await recordLlSessionsEndedByIds([row.id]);
    return true;
  }
  if (row.stoppingAtMs !== null && Date.now() - row.stoppingAtMs < stopBackoffMs(row.stopAttempts)) {
    return false;
  }
  await getPool()
    .query(
      `UPDATE hls_sessions SET stopping_at = NOW(), stop_attempts = stop_attempts + 1 WHERE id = $1`,
      [row.id],
    )
    .catch((error: unknown) => {
      logEvent("voice.hlsLlSessionRecordFailed", {
        channelId,
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  try {
    await remuxStopSession(row.remuxSessionId);
  } catch (error) {
    llStopFailures += 1;
    logEvent("voice.hlsLlStopFailed", {
      channelId,
      sessionId: row.remuxSessionId,
      reason: "retry",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  await recordLlSessionsEndedByIds([row.id]);
  logEvent("voice.hlsLlStopped", { channelId, sessionId: row.remuxSessionId, reason: "retry" });
  return true;
}

async function startLlSession(
  channelId: string,
  presenterPeerId: string,
): Promise<LiveHlsStream | null> {
  const originBaseUrl = remuxOriginBaseUrl();
  if (!remuxControlUrl() || !remuxControlSecret() || !originBaseUrl) {
    llStartFailures += 1;
    logEvent("voice.hlsLlStartFailed", { channelId, reason: "not-configured" });
    return null;
  }
  const cfg = remuxSessionConfig();

  const lookup = await findOpenLlRow(channelId);
  if (!lookup.ok) {
    // FAIL CLOSED: a database read failure here is treated as "try again
    // later", never as "no row" -- reading it the other way is exactly what
    // let a second, untracked session start on top of one that might still
    // be running perfectly well (a Farol finding on PR #580, fourth round).
    // No insert, no remux call, nothing torn down: the next reconcile is
    // what retries.
    llStartFailures += 1;
    logEvent("voice.hlsLlStartFailed", { channelId, reason: "lookup-failed" });
    return null;
  }
  let openRow = lookup.row;
  if (openRow) {
    // A ROW ANOTHER LIVE MACHINE OWNS IS NOT THIS PROCESS'S TO RESUME, STOP OR
    // END. `claimHlsSessionRow` is a conditional UPDATE, so this is a
    // compare-and-set rather than a read-then-act: two machines booting three
    // seconds apart (2026-09-14) both read the same open row, stamped with the
    // pre-restart instance that is not answering any more, and both acted --
    // one resumed the remux session, the other stopped it as an orphan.
    // Exactly one of them can win this UPDATE.
    //
    // THE HEARTBEAT GOES FIRST for the reason `ensureHlsOwnerHeartbeat`
    // states: a claimant that cannot say it is alive is one the other
    // machine is entitled to take the row straight back from. The boot
    // sweep and `adoptRunningLlHlsSession` already do this; a start that
    // still reaches an open row (handover, remux gone) must too.
    //
    // `failed` is treated like `refused` on purpose: a database we could not
    // ask is not permission, it is the absence of an answer, and the fail-
    // closed rule this whole file is built on (see `findOpenLlRow`) says do
    // nothing and let the next reconcile try.
    if (!(await ensureHlsOwnerHeartbeat())) {
      llStartFailures += 1;
      logEvent("voice.hlsLlStartFailed", {
        channelId,
        reason: "heartbeat-unavailable",
      });
      return null;
    }
    const claim = await claimHlsSessionRow(openRow.id);
    if (claim !== "claimed") {
      llStartFailures += 1;
      if (claim === "refused") {
        noteHlsSkippedOwnedElsewhere({
          site: "ll-start",
          channelId,
          sessionId: openRow.id,
          ownerInstanceId: openRow.instanceId,
        });
      }
      logEvent("voice.hlsLlStartFailed", {
        channelId,
        reason: claim === "refused" ? "row-owned-elsewhere" : "claim-failed",
      });
      return null;
    }
  }
  if (openRow && (openRow.stoppingAtMs !== null || openRow.presenterPeerId !== presenterPeerId)) {
    // Not this presenter's session, or already mid-teardown: finish closing
    // it before this room gets anything new. A durable version of the same
    // rule `reconcileLlHlsNow` already applies from its in-memory `llRooms`
    // -- this is what catches the case that map does not know about (a row
    // left over from before a restart, or from an attempt this process
    // never got to track).
    const closed = await retryStopOpenLlRow(openRow, channelId);
    if (!closed) {
      llStartFailures += 1;
      logEvent("voice.hlsLlStartFailed", { channelId, reason: "foreign-row-unresolved" });
      return null;
    }
    openRow = null;
  }

  let startedAt: number;
  let sessionId: string;
  // The cadence the AUDIENCE is told about. A fresh session writes at
  // whatever `LIVE_HLS_REMUX_PART_MS` says now; a resumed one is still the
  // box session that was started earlier, so its row's stored value is the
  // truth (see `OpenLlRow.partTargetMs`). A NULL on a pre-column row falls
  // back to today's config, which is what it would have been written with.
  let partTargetMs = cfg.partMs;
  if (openRow) {
    // Our own unresolved attempt for this exact presenter: resume it
    // deterministically. `remuxSessionId` should already be set (the INSERT
    // below always writes it), but recomputing is the same value regardless
    // -- that recomputability is the whole point (see `deriveLlSessionId`).
    startedAt = openRow.startedAtMs;
    sessionId = openRow.remuxSessionId ?? deriveLlSessionId(channelId, startedAt);
    partTargetMs = openRow.partTargetMs ?? cfg.partMs;
  } else {
    startedAt = Date.now();
    sessionId = deriveLlSessionId(channelId, startedAt);
    const party = await liveWatchPartyId(channelId);
    const inserted = await recordLlSessionStarted(
      channelId,
      startedAt,
      sessionId,
      presenterPeerId,
      cfg.partMs,
      originBaseUrl,
      party.ok ? party.id : null,
    );
    if (!inserted) {
      // No remux call was ever made: nothing on the box to roll back.
      llStartFailures += 1;
      logEvent("voice.hlsLlStartFailed", { channelId, reason: "record-failed" });
      return null;
    }
  }

  let info: RemuxSessionInfo;
  try {
    const existing = await findRemuxSessionById(sessionId);
    if (existing === "failed") {
      // COULD NOT ASK IS NOT "GONE". Starting on a list failure is the
      // rolling-deploy shape that looks identical to a restart and is not
      // one: the box may still be writing parts for this exact sessionId.
      llStartFailures += 1;
      logEvent("voice.hlsLlStartFailed", {
        channelId,
        reason: "list-failed",
        sessionId,
      });
      return null;
    }
    if (existing) {
      logEvent("voice.hlsLlStartFoundExisting", { channelId, sessionId });
      info = existing;
    } else {
      info = await remuxStartSession(buildStartRequest({ sessionId, channelId }));
    }
  } catch (error) {
    // The row is left exactly as it is: open, unresolved, `remux_session_id`
    // already set to `sessionId`. The NEXT attempt for this channel calls
    // `findOpenLlRow`, gets this same row back, and recomputes this exact
    // same `sessionId` -- there is nothing else to remember.
    llStartFailures += 1;
    logEvent("voice.hlsLlStartFailed", {
      channelId,
      reason: "control-api-error",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const stream: LiveHlsStream = {
    hlsUrl: llPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId,
    delaySeconds: llDelaySeconds(),
    mode: "ll",
    // THE CADENCE THIS SESSION ACTUALLY WRITES AT, not the deployment
    // default a player would otherwise have to assume: it is what sizes
    // hls.js's hold-back and the stall watchdog's part timer
    // (`client/src/lib/hls-live-edge.ts`). The same number went onto the
    // row at `recordLlSessionStarted`, so a resume reads back what it
    // started with.
    partTargetMs,
  };
  llRooms.set(channelId, { sessionId, startedAt, presenterPeerId, stream });
  logEvent("voice.hlsLlStarted", { channelId, sessionId, subscribed: info.subscribed });
  return stream;
}

/**
 * Every teardown carries a `reason` (pitfall 15's rule, and this driver has
 * no excuse to relearn it on day one).
 *
 * A FAILED STOP MOVES THE ROW TO `stopping`, IT DOES NOT FORGET IT. `llRooms`
 * forgets the room either way (this process is done treating it as a live
 * stream this call), but the row keeps `ended_at` NULL and now carries
 * `stopping_at` — the next `startLlSession` for this channel (via
 * `findOpenLlRow`) or the next boot sweep (`adoptLlHlsSessions`) retries the
 * DELETE, paced by `stopBackoffMs`. Earlier versions of this function either
 * forgot the room unconditionally (a Farol finding on PR #580: the remote
 * session then outlived everything tracking it) or kept retrying only from
 * an in-memory marker with no ceiling (the next finding: the marker could
 * expire while still the only reference to a still-running session). A row
 * has neither problem: it cannot be lost to a restart, and there is no
 * separate expiry to accidentally discard the only pointer to a live
 * session — `retryStopOpenLlRow` only ever stops retrying once the box
 * confirms the session is actually gone.
 */
export async function stopLlSession(channelId: string, reason: string): Promise<void> {
  const room = llRooms.get(channelId);
  if (!room) {
    return;
  }
  llRooms.delete(channelId);
  await markLlSessionStopping(channelId, room.startedAt);
  try {
    await remuxStopSession(room.sessionId);
  } catch (error) {
    llStopFailures += 1;
    logEvent("voice.hlsLlStopFailed", {
      channelId,
      sessionId: room.sessionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await recordLlSessionEnded(channelId, room.startedAt);
  logEvent("voice.hlsLlStopped", { channelId, sessionId: room.sessionId, reason });
}

/**
 * THE PRESENTER MOVED MACHINES; THE REMUX DID NOT.
 *
 * `#625` closed this for the conventional LiveKit ladder (`adoptRunningLiveHlsSession`
 * in `hls-egress.ts`). LL was deliberately left out of that pass — an LL row has
 * no `egress_id`, so asking LiveKit whether the session is still listed can never
 * match — and the comment there said the LL half already had the shape via
 * `reconcileLlHlsNow` → `startLlSession`. That was half true: `startLlSession`
 * claims an open row before it acts, but it is still a *start* path. On a
 * machine that was already up when the presenter resumed onto it, the only
 * route into a healthy remux session was that start, which on a transient
 * `GET /sessions` failure treated "could not ask" as "gone" and POSTed a
 * second start, and which had no `fresh` / `stand-down` split for a claim this
 * process lost. The loser of a two-machine race could therefore stop (or
 * restart) the winner's healthy remux session — the same rolling-deploy
 * incident #625 fixed for the ladder, arriving through the LL door.
 *
 * This is the LL twin of that adoption, asked at the same moment the seat is
 * adopted rather than only at boot (`adoptLlHlsSessions`):
 *
 *  1. open, not-stopping `mode='ll'` row for this channel, same presenter;
 *  2. no row owned by an instance still answering its `voice_instances`
 *     heartbeat;
 *  3. the remux box still lists the session, and it is not demoted;
 *  4. `ensureHlsOwnerHeartbeat()`, then `claimHlsSessionRow` as the verdict;
 *  5. adopt into `llRooms` with the row's `startedAt` / playlist URL — no
 *     `POST /sessions`, no `DELETE`, nothing for a viewer to notice.
 *
 * `"No"` is two different answers, the same split #625 learned the hard way:
 * `fresh` is a genuine restart (nothing to inherit, a different presenter, the
 * remux no longer lists it); `stand-down` is "somebody alive holds this, or
 * the question could not be answered" (owner still answering, list/lookup/
 * heartbeat failed, claim lost). On stand-down the caller does NOTHING this
 * reconcile and asks again on the next roster event. Starting on any of those
 * would be the same incident one step further along.
 *
 * WHAT IT DELIBERATELY DOES NOT ASK: LiveKit. An LL row names a remux session,
 * and the only sweep entitled to judge those rows is the one that asks the box
 * holding them (`docs/plans/LL_HLS.md` §5). Conventional stale sweeps keep
 * excluding `mode='ll'` for exactly that reason.
 */
type LlResumeAdoption =
  | { kind: "adopted"; stream: LiveHlsStream }
  | { kind: "fresh" }
  | { kind: "stand-down"; reason: string };

/**
 * The last non-adopted answer per channel AND PRESENTER, and when it was
 * decided — same shape and reason as the conventional `resumeDecisionCache`.
 * A room filling up must not put a row read and a remux `GET /sessions`
 * behind every join; a stand-down decided while A was sharing says nothing
 * about B.
 */
const llResumeDecisionCache = new Map<
  string,
  { at: number; decision: LlResumeAdoption }
>();
const LL_RESUME_DECISION_TTL_MS = 5_000;
const LL_RESUME_DECISION_MAX_ENTRIES = 128;
const llResumeRefusalLoggedAt = new Map<string, number>();
const LL_RESUME_REFUSAL_LOG_THROTTLE_MS = 30_000;

export async function adoptRunningLlHlsSession(
  channelId: string,
  presenterPeerId: string,
  now = nowImpl(),
): Promise<LlResumeAdoption> {
  if (!isLiveHlsLLEnabled() || !remuxControlUrl() || !remuxControlSecret()) {
    return { kind: "fresh" };
  }
  if (llRooms.has(channelId)) {
    return { kind: "fresh" };
  }
  // LENGTH-PREFIXED, not `a:b` — same reason as the conventional twin: both
  // halves are ids this process is handed, and a separator either could
  // contain would let two pairs share one key.
  const decisionKey = `${channelId.length}:${channelId}:${presenterPeerId}`;
  const cached = llResumeDecisionCache.get(decisionKey);
  if (cached && now - cached.at < LL_RESUME_DECISION_TTL_MS) {
    return cached.decision;
  }
  const remember = (decision: LlResumeAdoption): LlResumeAdoption => {
    if (llResumeDecisionCache.size > LL_RESUME_DECISION_MAX_ENTRIES) {
      for (const [seen, entry] of llResumeDecisionCache) {
        if (now - entry.at >= LL_RESUME_DECISION_TTL_MS) {
          llResumeDecisionCache.delete(seen);
        }
      }
    }
    llResumeDecisionCache.set(decisionKey, { at: now, decision });
    return decision;
  };

  const lookup = await findOpenLlRow(channelId);
  if (!lookup.ok) {
    return remember({ kind: "stand-down", reason: "lookup-failed" });
  }
  const row = lookup.row;
  if (!row || !row.remuxSessionId) {
    // Ordinary case for a share that is starting: nothing to inherit.
    return remember({ kind: "fresh" });
  }
  if (row.stoppingAtMs !== null) {
    // Mid-teardown: not ours to adopt as live. `startLlSession` already knows
    // how to finish closing it before anything new is minted.
    return remember({ kind: "fresh" });
  }

  const refuse = (
    kind: LlResumeAdoption["kind"] & ("fresh" | "stand-down"),
    reason: string,
    detail: Record<string, unknown> = {},
  ): LlResumeAdoption => {
    const key = `${channelId}:${reason}`;
    const stamped = Date.now();
    for (const [seen, at] of llResumeRefusalLoggedAt) {
      if (stamped - at > LL_RESUME_REFUSAL_LOG_THROTTLE_MS) {
        llResumeRefusalLoggedAt.delete(seen);
      }
    }
    const previous = llResumeRefusalLoggedAt.get(key);
    if (
      previous === undefined ||
      stamped - previous >= LL_RESUME_REFUSAL_LOG_THROTTLE_MS
    ) {
      llResumeRefusalLoggedAt.set(key, stamped);
      logEvent("voice.hlsLlResumeNotAdopted", {
        channelId,
        presenterPeerId,
        kind,
        reason,
        ...detail,
      });
    }
    return remember(
      kind === "fresh" ? { kind: "fresh" } : { kind: "stand-down", reason },
    );
  };

  if (row.presenterPeerId !== presenterPeerId) {
    // A DIFFERENT PERSON IS PRESENTING NOW. A resume keeps its peer id, so a
    // mismatch here is a genuine handover and deserves its own session.
    return refuse("fresh", "presenter-changed", {
      startedAt: row.startedAtMs,
      was: row.presenterPeerId,
    });
  }

  const liveOthers = await liveOtherInstances();
  if (liveOthers === null) {
    return refuse("stand-down", "owner-lookup-failed", {
      startedAt: row.startedAtMs,
    });
  }
  if (ownedByLiveOtherInstance(row.instanceId, liveOthers)) {
    noteHlsSkippedOwnedElsewhere({
      site: "ll-resume-adopt",
      channelId,
      sessionId: row.id,
      ownerInstanceId: row.instanceId,
    });
    // AND THE CALLER STARTS NOTHING EITHER. Falling through to
    // `startLlSession` on a live owner's row is how a rolling deploy's
    // survivor used to race the draining machine's last heartbeat.
    return remember({ kind: "stand-down", reason: "owned-elsewhere" });
  }

  let remote: RemuxSessionInfo | null;
  try {
    const sessions = await remuxListSessions();
    remote =
      sessions.find((session) => session.sessionId === row.remuxSessionId) ?? null;
  } catch (error) {
    logEvent("voice.hlsLlResumeLookupFailed", {
      channelId,
      presenterPeerId,
      error: error instanceof Error ? error.message : String(error),
    });
    // COULD NOT ASK IS NOT "NOTHING TO INHERIT".
    return remember({ kind: "stand-down", reason: "list-failed" });
  }
  if (!remote) {
    // The remux really does not hold it. That is a genuine restart, and the
    // caller's `startLlSession` is the right answer to it.
    return refuse("fresh", "no-live-session", {
      startedAt: row.startedAtMs,
      remuxSessionId: row.remuxSessionId,
    });
  }
  if (remote.demoted === true || remote.state === "demoted") {
    // Demoted is over for the LL half. Do not adopt it as live, and do not
    // fall through to a start that would resume the same demoted remux id
    // either — stand down and let the next health tick's demotion sweep (once
    // a machine holds the row in `llRooms`, e.g. via boot adopt) finish the
    // cleanup. A healthy rolling-deploy handoff never lands here.
    return refuse("stand-down", "demoted", {
      startedAt: row.startedAtMs,
      remuxSessionId: row.remuxSessionId,
      demotedReason: remote.demotedReason ?? null,
    });
  }

  if (!(await ensureHlsOwnerHeartbeat())) {
    return refuse("stand-down", "heartbeat-unavailable", {
      startedAt: row.startedAtMs,
    });
  }
  const claim = await claimHlsSessionRow(row.id);
  if (claim !== "claimed") {
    // A CLAIM THIS PROCESS LOST IS NOT A RESTART. Falling through to
    // `startLlSession` on either `refused` or `failed` would have the loser
    // of a two-machine race mint a second remux session (or stop the
    // winner's) — the incident this function exists to end.
    return refuse("stand-down", `claim-${claim}`, {
      startedAt: row.startedAtMs,
      sessionId: row.id,
    });
  }

  const startedAt = row.startedAtMs;
  const stream: LiveHlsStream = {
    hlsUrl: llPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId,
    delaySeconds: llDelaySeconds(),
    mode: "ll",
    partTargetMs: row.partTargetMs ?? remuxSessionConfig().partMs,
  };
  llRooms.set(channelId, {
    sessionId: row.remuxSessionId,
    startedAt,
    presenterPeerId,
    stream,
  });
  // Not remembered in the decision cache: an adoption is answered once and
  // every later call short-circuits on `llRooms.has` above.
  logEvent("voice.hlsLlSessionResumeAdopted", {
    channelId,
    presenterPeerId,
    startedAt,
    from: row.instanceId,
    sessionId: row.remuxSessionId,
    rowId: row.id,
  });
  return { kind: "adopted", stream };
}

/**
 * The LL half of `reconcileLiveHlsNow`, single-flighted per channel. No
 * track probing: unlike the conventional ladder, `pqp-remux` finds the
 * presenter's screen share itself (its README, "Presenter authorization" —
 * the first `SCREEN_SHARE` source it sees), so there is nothing here to
 * compare a track sid against. A presenter reconnecting under a fresh peer
 * id is therefore NOT specially reattached the way the conventional path
 * does it: the simpler rule below (same peer id keeps the session, any
 * other change restarts it) is correct for L1.5's scope and can be
 * sharpened once `L1.6`'s watchdog exists to make a restart cheap to
 * recover from.
 *
 * SELF-CONTAINED SINGLE-FLIGHT. `hls-egress.ts`'s own `reconcileLiveHls`
 * already serializes calls per channel with its own queue, but a Farol
 * review of PR #580 flagged relying on that alone: this function is
 * exported and nothing in its own module enforces that a caller never
 * invokes it twice concurrently for one channel. `llReconcileQueue` below is
 * the same promise-chain-per-key pattern, kept in this file so the guarantee
 * holds regardless of what calls it.
 */
export function reconcileLlHlsNow(
  channelId: string,
  presenterPeerId: string | null,
): Promise<LiveHlsStream | null> {
  const previous = llReconcileQueue.get(channelId) ?? Promise.resolve();
  const chained = previous
    .catch(() => undefined)
    .then(() => reconcileLlHlsNowLocked(channelId, presenterPeerId));
  llReconcileQueue.set(channelId, chained);
  void chained.finally(() => {
    if (llReconcileQueue.get(channelId) === chained) {
      llReconcileQueue.delete(channelId);
    }
  });
  return chained;
}

const llReconcileQueue = new Map<string, Promise<LiveHlsStream | null>>();

async function reconcileLlHlsNowLocked(
  channelId: string,
  presenterPeerId: string | null,
): Promise<LiveHlsStream | null> {
  if (!presenterPeerId) {
    if (llRooms.has(channelId)) {
      await stopLlSession(channelId, "no-share");
    }
    return null;
  }
  const current = llRooms.get(channelId);
  if (current && current.presenterPeerId === presenterPeerId) {
    return current.stream;
  }
  if (current) {
    await stopLlSession(channelId, "presenter-changed");
    if (llRooms.has(channelId)) {
      // The stop above did not land (still in the map): do not start a
      // second session on top of one this process cannot confirm is gone.
      // The next reconcile tries the stop again first.
      logEvent("voice.hlsLlSwitchDeferred", { channelId, presenterPeerId });
      return llRooms.get(channelId)!.stream;
    }
  } else {
    // NOTHING LOCAL, BUT MAYBE NOT NOTHING AT ALL. This process holds no LL
    // room for a channel it has never presented — and also for one whose
    // presenter has just RESUMED here off a machine that is draining for a
    // deploy, while the remux carries on untouched on its own box. The two
    // look identical from here and only one of them wants a new remux
    // session. Mirror of `adoptRunningLiveHlsSession` on the conventional
    // side (#625); gated on `current` having been absent so a genuine
    // handover (the stop above) still falls through to a fresh start.
    const resumed = await adoptRunningLlHlsSession(channelId, presenterPeerId);
    if (resumed.kind === "adopted") {
      return resumed.stream;
    }
    if (resumed.kind === "stand-down") {
      // Somebody else alive is driving this, or the question could not be
      // answered. Starting on either would race the winner's healthy remux
      // session. Do nothing at all and ask again on the next roster event.
      return null;
    }
  }
  return startLlSession(channelId, presenterPeerId);
}

// ---------------------------------------------------------------------------
// The demotion contract: noticing, and falling back
// ---------------------------------------------------------------------------

/**
 * WHAT THE BOX GAVE UP ON, AND WHAT THIS PROCESS OWES THE AUDIENCE FOR IT.
 *
 * `tools/pqp-remux/README.md` §"Watchdog and the demotion contract" is one
 * half of a promise: the box restarts a stalled session once, demotes it for
 * good on the second stall (or immediately on an IDR gap), closes the
 * pipeline, and KEEPS the session listed with `demoted: true` so `pqp-api`
 * can notice on its next poll. This function is the other half, and until
 * 2026-09-15 it did not exist.
 *
 * What that cost, on the first real LL party in production (2026-09-14,
 * 21:50 UTC): `pqp-remuxd` logged `demoting (idr-gap-exceeded)` fourteen
 * seconds after the session started and dropped its LiveKit subscription.
 * The `hls_sessions` row stayed open with `mode = 'll'`, every viewer kept
 * being handed the LL playlist, the edge Worker logged
 * `hlsEdge.llStateFetchFailed` twelve times over, the conventional ladder was
 * never started — and the audience had no picture at all until an unrelated
 * restart. Every piece of the machinery worked except the one that looks.
 *
 * Three states are treated as "this session is over":
 *
 *  - `demoted: true` — the contract's own word, with the box's `reason`.
 *  - `state: "demoted"` — the same thing said the other way, because the box
 *    sends both and a client that trusts only one field trusts the field it
 *    happens to have read (pitfall 9's shape).
 *  - not listed at all — the process on the box restarted, or somebody
 *    `DELETE`d it. `llRooms` holding a session the box does not have is the
 *    self-heal case the 2026-09-14 boot race left behind: machine B kept
 *    `llSessions = 1` in memory for a session machine A had stopped.
 *
 * FAILS CLOSED, LOUDLY. A control API that cannot be reached answers nothing
 * and changes nothing: demoting a healthy party because one HTTP request
 * timed out is a rebuffer for every viewer, and the next tick is ten seconds
 * away. Same rule as `listActiveEgresses() === null` in the conventional
 * sweep.
 *
 * Returns the channels whose party now needs the conventional ladder started.
 * It does NOT start one itself: `hls-egress.ts` owns that path, imports this
 * module and must never be imported back (see `llObjectPrefix`).
 */
export async function sweepLlDemotions(now = Date.now()): Promise<string[]> {
  // BEFORE THE CONFIGURATION CHECK, not after it. Both maps are filled by
  // mode resolution, which runs on `LIVE_HLS_LL` alone; a deployment with
  // the flag on and no remux control URL returns below without ever having
  // demoted anything and would never sweep them (a Farol finding on this
  // PR). In-memory work on a ten-second tick, so it costs nothing to do it
  // unconditionally.
  pruneLlMemos(now);
  if (!isLiveHlsLLEnabled() || !remuxControlUrl() || !remuxControlSecret()) {
    return [];
  }
  // DETECTION IS GATED ON HAVING A SESSION; THE REPAIR IS NOT. A cleanup step
  // that failed belongs to a demotion this process has already acted on, and
  // `llRooms` is empty precisely because it did -- gating the queue on a live
  // session would be a repair that can only run while there is nothing to
  // repair.
  if (llRooms.size === 0) {
    return runPendingDemotions(now);
  }
  let remoteSessions: RemuxSessionInfo[];
  try {
    remoteSessions = await remuxListSessions();
  } catch (error) {
    logEvent("voice.hlsLlHealthPollFailed", {
      sessions: llRooms.size,
      error: error instanceof Error ? error.message : String(error),
    });
    // The poll failed, so nothing NEW is demoted as far as this process can
    // tell -- but whatever is already queued still wants finishing.
    return runPendingDemotions(now);
  }
  const remoteById = new Map(remoteSessions.map((session) => [session.sessionId, session]));

  const demotions: { channelId: string; sessionId: string; reason: string }[] = [];
  for (const [channelId, room] of [...llRooms]) {
    const remote = remoteById.get(room.sessionId);
    if (!remote) {
      room.noVideoSinceMs = undefined;
      demotions.push({ channelId, sessionId: room.sessionId, reason: "session-gone" });
      continue;
    }
    if (remote.demoted === true || remote.state === "demoted") {
      room.noVideoSinceMs = undefined;
      demotions.push({
        channelId,
        sessionId: room.sessionId,
        // The box's own word for it (`idr-gap-exceeded`, `no-video`,
        // `part-stuck`), never a word invented here: an operator reading
        // `voice.hlsLlDemoted` and `pqp-remuxd`'s log has to see one reason.
        reason: remote.demotedReason ?? "demoted",
      });
      continue;
    }
    // READINESS BACKSTOP. The box is supposed to demote a session that never
    // produces a single part -- its own `FirstPartTimeoutMs` "no-video" rule
    // (`internal/control/watchdog.go`). But a session that hangs BEFORE it
    // ever subscribes to the presenter's track has been seen sit at
    // `partsWritten === 0` for a whole party without the box ever flagging it:
    // production channel `d5559e70`, 2026-09-16, an LL session ran 49 minutes
    // at `subscribed=false`, zero parts, no `demoted`, no `session-gone`, and
    // every viewer got nothing while the sweep left it alone every tick. This
    // is the API-side backstop for exactly that: a session this process has
    // watched produce NO video for longer than the readiness window is
    // demoted to the conventional (loss-concealing, and here simply WORKING)
    // ladder, so a stuck LL rung falls back in ~a minute instead of hanging
    // for the length of the film. `partsWritten === 0` is the whole gate: a
    // source that produced parts and then went quiet (a static tab) has
    // `partsWritten > 0` and is the box's `sourceIdle` case, never demoted
    // here.
    if (remote.partsWritten === 0) {
      room.noVideoSinceMs ??= now;
      if (now - room.noVideoSinceMs > llReadyTimeoutMs()) {
        demotions.push({ channelId, sessionId: room.sessionId, reason: "no-video-timeout" });
        continue;
      }
    } else {
      room.noVideoSinceMs = undefined;
    }
  }

  for (const { channelId, sessionId, reason } of demotions) {
    // WHICH ROW IS THIS DEMOTION ABOUT? Resolved from the box's own session
    // id against the channel's open row, never from "the newest LL row here":
    // the identity that travels through every step below is the remux
    // session, and a row that does not name it is somebody else's session or
    // a stale entry in this process's map.
    const lookup = await findOpenLlRow(channelId);
    if (!lookup.ok) {
      // Could not ask. Change nothing at all this tick; the next one is ten
      // seconds away and the room stays in the map until it can.
      continue;
    }
    const row = lookup.row;
    if (!row || row.remuxSessionId !== sessionId) {
      // The row is gone, or names a different session: this entry is stale
      // bookkeeping, not a live session of ours. Heal the map and touch
      // nothing else -- no DELETE to the box, no write to somebody's row.
      llRooms.delete(channelId);
      logEvent("voice.hlsLlForgotStaleRoom", { channelId, reason });
      continue;
    }
    // STILL OURS TO ACT ON? `llRooms` is process memory and this process may
    // have been out of touch for a while: if its heartbeat lapsed, another
    // instance is entitled to have claimed the row and restarted the party,
    // and stopping the box session or rewriting the row from here would kill
    // a stream the new owner is driving (a Farol finding on PR #618 -- the
    // very failure the rest of this change exists to stop, arriving through
    // the one path that had no claim in front of it). Re-asked on every
    // retry too, inside `runPendingDemotions`.
    const claim = await claimHlsSessionRow(row.id);
    if (claim !== "claimed") {
      if (claim === "refused") {
        noteHlsSkippedOwnedElsewhere({
          site: "ll-demote",
          channelId,
          sessionId: row.id,
          ownerInstanceId: row.instanceId,
        });
        llRooms.delete(channelId);
      }
      continue;
    }
    llDemoted += 1;
    logEvent("voice.hlsLlDemoted", { channelId, reason });
    // THE MEMO FIRST. The cleanup below and the reconcile that follows it
    // both re-resolve the mode, and a memo written after them would let the
    // very next reconcile start a second LL session for the party just given
    // up on. See `noteLlDemotion`.
    //
    // Keyed by the party the session recorded, so a party starting later on
    // this channel is untouched by this verdict on ANY machine. A row with
    // no recorded party is UNKNOWN rather than "none" (`attributeDemotion`),
    // and the memo is written there the moment the attribution resolves --
    // which is `runPendingDemotions` at the bottom of this same sweep.
    if (row.watchPartySessionId !== null) {
      noteLlDemotion(row.watchPartySessionId);
    }
    // THE MAP IS RELEASED HERE, NOT WHEN THE BOX CONFIRMS. A session the box
    // has demoted is producing nothing either way, and holding it would keep
    // `llHasRoom` answering yes and keep the conventional path from starting.
    // The DELETE and the row's own `ended_at` are the queue's first step,
    // retried until the box agrees.
    llRooms.delete(channelId);
    queueDemotion({
      channelId,
      sessionId,
      rowId: row.id,
      // Off the ROW, so the clear names the party that asked for this
      // session rather than whatever happens to be live when the write runs.
      // NULL here is UNKNOWN, not "none": `attributeDemotion` resolves it.
      partySessionId: row.watchPartySessionId,
      startedAtMs: row.startedAtMs,
      attributionAttempts: 0,
      reason: `demoted:${reason}`,
      queuedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      stopped: false,
      cleared: false,
    });
  }
  return runPendingDemotions(now);
}


// ---------------------------------------------------------------------------
// Boot adoption
// ---------------------------------------------------------------------------

/** How many control-plane requests the boot sweep holds in flight at once. */
const ORPHAN_STOP_CONCURRENCY = 4;

/**
 * `docs/plans/LL_HLS.md` §5's own grace: how long a row another process just
 * wrote is left alone by this one's boot sweep, whatever the heartbeats say.
 */
const LL_BOOT_GRACE_MS = 60_000;

interface StaleLlRow {
  id: string;
  channel_id: string;
  started_at: string;
  ended_at: string | null;
  remux_session_id: string | null;
  presenter_peer_id: string | null;
  stopping_at: string | null;
  stop_attempts: number;
  /** Which API process last started or adopted it. NULL = nobody's. */
  instance_id: string | null;
  watch_party_session_id: string | null;
  part_target_ms: number | null;
}

function toOpenLlRow(row: StaleLlRow): OpenLlRow {
  return {
    id: row.id,
    startedAtMs: new Date(row.started_at).getTime(),
    remuxSessionId: row.remux_session_id,
    presenterPeerId: row.presenter_peer_id,
    stoppingAtMs: row.stopping_at ? new Date(row.stopping_at).getTime() : null,
    stopAttempts: row.stop_attempts,
    instanceId: row.instance_id,
    watchPartySessionId: row.watch_party_session_id,
    partTargetMs: row.part_target_ms,
  };
}

/** Run `fn` over `items`, at most `limit` in flight at once, waiting for each batch. */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(fn));
  }
}

/**
 * The LL half of `reconcileStaleHlsSessions`: called once at boot, after the
 * conventional adoption, so a restart of `pqp-api` does not tear down a
 * live low-latency party either. Same two-sweep shape as
 * `reapForeignEgresses`/`sweepOwnStaleVoicePeers` (pitfall 13's rule — both
 * directions get a case for their own rows): every row this process might
 * own is reconciled against what the box actually reports, and neither side
 * is trusted alone.
 *
 *  - a row already `stopping_at` -> retried here too (bounded, backed off),
 *    never adopted as live no matter what the box still answers for it.
 *  - a live remote session with an owning, non-stopping row -> adopted into
 *    `llRooms`.
 *  - a live remote session with no row, a row with no presenter, or a row
 *    that is mid-teardown -> the box is asked to stop it: nobody here can
 *    (or should) rebuild a live room for it.
 *  - a row with no matching remote session, not already handled above ->
 *    ended: the box does not hold it any more, so its retention row should
 *    not sit open forever.
 *
 * `null` (rather than the zero-in-every-field result) when the control API
 * could not be asked at all — same fail-safe as `reconcileStaleHlsSessions`'s
 * `listActiveEgresses() === null` branch: ending rows on a network hiccup
 * would let the retention sweep collect a session the box is still happily
 * running.
 */
export async function adoptLlHlsSessions(): Promise<{
  adopted: number;
  ended: number;
  stopped: number;
} | null> {
  if (!isLiveHlsLLEnabled() || !remuxControlUrl() || !remuxControlSecret()) {
    return { adopted: 0, ended: 0, stopped: 0 };
  }
  let remoteSessions: RemuxSessionInfo[];
  try {
    remoteSessions = await remuxListSessions();
  } catch (error) {
    logEvent("voice.hlsLlBootReconcileSkipped", {
      reason: "list-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  // THE SAME TWO-MACHINE RULE THE CONVENTIONAL BOOT SWEEP RUNS. A row whose
  // owner is still answering its `voice_instances` heartbeat belongs to that
  // machine: not adopted here (it already has a driver), not stopped, not
  // ended. Without this the LL driver has the conventional driver's bug --
  // machine B ends and stops machine A's live session on every deploy. A
  // lookup we could not run answers null and stops the whole pass, exactly
  // like a control API we could not list.
  const liveOthers = await liveOtherInstances();
  if (liveOthers === null) {
    logEvent("voice.hlsLlBootReconcileSkipped", { reason: "owner-lookup-failed" });
    return null;
  }
  // BEFORE ANY CLAIM BELOW, so the claims that follow are decidable at all:
  // two machines booting inside one heartbeat TTL with neither row written
  // yet would each read the other as dead and take the row back in turn. A
  // beat that did not land ABORTS THE PASS (a Farol finding on PR #618):
  // claiming while invisible is that same race one step further along, and
  // the next boot sweep -- or the monitor's own revisit -- is seconds away.
  if (!(await ensureHlsOwnerHeartbeat())) {
    logEvent("voice.hlsLlBootReconcileSkipped", { reason: "heartbeat-failed" });
    return null;
  }

  const rows = await getPool().query<StaleLlRow>(
    `SELECT id, channel_id, started_at, ended_at, remux_session_id, presenter_peer_id,
            stopping_at, stop_attempts, instance_id, watch_party_session_id, part_target_ms
     FROM hls_sessions
     WHERE mode = 'll' AND cleaned_at IS NULL
       AND (ended_at IS NULL OR ended_at > NOW() - INTERVAL '1 hour')`,
  );
  const ownedElsewhere = (row: StaleLlRow): boolean =>
    ownedByLiveOtherInstance(row.instance_id, liveOthers);
  for (const row of rows.rows) {
    // Only the OPEN rows are counted as skips: an ended row inside the
    // one-hour window is read here purely so an orphan stop can name it, and
    // this pass was never going to touch it either way.
    if (row.ended_at === null && ownedElsewhere(row)) {
      noteHlsSkippedOwnedElsewhere({
        site: "ll-boot",
        channelId: row.channel_id,
        sessionId: row.id,
        ownerInstanceId: row.instance_id,
      });
    }
  }

  // A row mid-teardown is retried here, bounded and backed off, and is
  // excluded from every other bucket below: it must never be adopted as
  // live no matter what the box still answers for its id.
  const stoppingRows = rows.rows.filter(
    (row) => row.ended_at === null && row.stopping_at !== null && !ownedElsewhere(row),
  );
  let retriedStops = 0;
  await runBounded(stoppingRows, ORPHAN_STOP_CONCURRENCY, async (row) => {
    if (await retryStopOpenLlRow(toOpenLlRow(row), row.channel_id)) {
      retriedStops += 1;
    }
  });

  // ONLY AN OPEN, NOT-STOPPING ROW (`ended_at IS NULL AND stopping_at IS
  // NULL`) OWNS A SESSION. The query above also reads rows ended within the
  // last hour -- purely so the loop below can still name them when logging
  // an orphan stop -- but `stopLlSession` only marks a row ended once the
  // box has confirmed the session gone, so a row with `ended_at` set here
  // means THIS process already believes that session is stopped. Adopting
  // it anyway because the box still happens to answer with it (a Farol
  // finding on PR #580: a failed DELETE outside this process's own stop
  // path, or a straight race with the 1-hour window) would resurrect a
  // party that was told it ended. Such a row is treated exactly like "no
  // row at all" below: the box is asked to stop it, not owned again.
  const rowByRemuxId = new Map(
    rows.rows
      .filter(
        (row) => row.remux_session_id && row.ended_at === null && row.stopping_at === null,
      )
      .map((row) => [row.remux_session_id!, row]),
  );
  // A remote session whose row another live machine owns is skipped whole: it
  // must not be adopted here, and it must not fall into `toStop` as a session
  // with "no row" either, which would stop a stream that has a healthy driver.
  const remuxIdsOwnedElsewhere = new Set(
    rows.rows
      .filter((row) => row.remux_session_id && ownedElsewhere(row))
      .map((row) => row.remux_session_id!),
  );
  const remoteById = new Map(remoteSessions.map((session) => [session.sessionId, session]));

  let adopted = 0;
  /** Rows another booting machine won the claim for. Never adopted, never stopped. */
  let claimRefusals = 0;
  /** Rows whose claim could not be written at all. Same treatment, different cause. */
  let claimFailures = 0;
  const toStop: { sessionId: string; reason: "no-presenter" | "no-row" }[] = [];
  for (const remote of remoteSessions) {
    if (remuxIdsOwnedElsewhere.has(remote.sessionId)) {
      continue;
    }
    const row = rowByRemuxId.get(remote.sessionId);
    if (!row || !row.presenter_peer_id) {
      toStop.push({
        sessionId: remote.sessionId,
        reason: row ? "no-presenter" : "no-row",
      });
      continue;
    }
    // CLAIM BEFORE ADOPTING, NOT AFTER. The stamp used to be a batch write
    // issued once the whole loop had already put every row in `llRooms`,
    // which is a read-then-act across two machines: on 2026-09-14 B resumed a
    // session while A, booting three seconds later, was still reading rows
    // stamped with the instance both of them had replaced. Whoever loses this
    // conditional UPDATE never enters the map, never starts anything and --
    // crucially -- never falls through to `toStop` either, because a session
    // the winner is driving is not an orphan.
    const claim = await claimHlsSessionRow(row.id);
    if (claim !== "claimed") {
      if (claim === "refused") {
        noteHlsSkippedOwnedElsewhere({
          site: "ll-boot-adopt",
          channelId: row.channel_id,
          sessionId: row.id,
          ownerInstanceId: row.instance_id,
        });
        claimRefusals += 1;
      } else {
        // The database could not be asked, which is not permission either.
        // Counted apart from a refusal: one is another machine winning, the
        // other is this pass being unable to decide at all.
        claimFailures += 1;
      }
      continue;
    }
    const startedAt = new Date(row.started_at).getTime();
    llRooms.set(row.channel_id, {
      sessionId: remote.sessionId,
      startedAt,
      presenterPeerId: row.presenter_peer_id,
      stream: {
        hlsUrl: llPlaylistUrl(row.channel_id, startedAt),
        startedAt,
        presenterPeerId: row.presenter_peer_id,
        delaySeconds: llDelaySeconds(),
        mode: "ll",
        // OFF THE ROW, not off this process's own config: an adopted
        // session was started by somebody else (a previous boot, the other
        // machine) and is still writing at the cadence it was started with.
        partTargetMs: row.part_target_ms ?? remuxSessionConfig().partMs,
      },
    });
    adopted += 1;
    logEvent("voice.hlsLlSessionAdopted", {
      channelId: row.channel_id,
      sessionId: remote.sessionId,
    });
  }
  // The stamp already landed, per row, inside the loop above: it is what
  // decided each adoption rather than a repair issued after the fact.
  if (claimRefusals > 0 || claimFailures > 0) {
    logEvent("voice.hlsLlAdoptClaimRefused", {
      refused: claimRefusals,
      failed: claimFailures,
    });
  }

  // Bounded parallel cleanup, not one round trip per orphan in a row (this
  // runs before `listen()`) and not every orphan fired at once either (an
  // unbounded control-plane/network fan-out at exactly the moment the
  // process is also trying to come up -- a Farol finding on PR #580).
  let stopped = 0;
  await runBounded(toStop, ORPHAN_STOP_CONCURRENCY, async ({ sessionId, reason }) => {
    try {
      await remuxStopSession(sessionId);
      stopped += 1;
      logEvent("voice.hlsLlOrphanStopped", { sessionId, reason });
    } catch (error) {
      logEvent("voice.hlsLlOrphanStopFailed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // A ROW SOMEBODY ELSE WROTE SECONDS AGO IS NOT STALE, IT IS IN PROGRESS.
  // `startLlSession` inserts the row BEFORE it POSTs the box, so there is a
  // window where a perfectly healthy start has a row and no remote session
  // yet. A machine booting inside that window (a rolling deploy is two boots
  // three seconds apart) may not even see the other's `voice_instances`
  // heartbeat yet, so `ownedElsewhere` answers false and the row looks
  // abandoned. The plan's own 60s grace (`docs/plans/LL_HLS.md` §5, "the
  // grace exists so an API deploy does not reap a healthy session") is the
  // rule: a row this process did not stamp itself is left alone until it is
  // older than that.
  const meNow = hlsOwnerInstanceId();
  const nowMs = Date.now();
  const startingElsewhere = (row: StaleLlRow): boolean =>
    row.instance_id !== null &&
    row.instance_id !== meNow &&
    nowMs - new Date(row.started_at).getTime() < LL_BOOT_GRACE_MS;
  const staleIds = rows.rows
    .filter((row) => row.ended_at === null && row.stopping_at === null)
    .filter((row) => !ownedElsewhere(row))
    .filter((row) => !startingElsewhere(row))
    .filter((row) => !(row.remux_session_id && remoteById.has(row.remux_session_id)))
    .map((row) => row.id);
  await recordLlSessionsEndedByIds(staleIds);
  if (staleIds.length > 0) {
    logEvent("voice.hlsLlRowsEndedNoSession", { count: staleIds.length });
  }

  return { adopted, ended: staleIds.length + retriedStops, stopped };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function llHlsActivity(): {
  sessions: number;
  startFailures: number;
  stopFailures: number;
  demoted: number;
} {
  return {
    sessions: llRooms.size,
    startFailures: llStartFailures,
    stopFailures: llStopFailures,
    demoted: llDemoted,
  };
}

export function resetHlsRemuxForTests(): void {
  fetchImpl = (url, init) => fetch(url, init);
  nowImpl = () => Date.now();
  llRooms.clear();
  llReconcileQueue.clear();
  llResumeDecisionCache.clear();
  llResumeRefusalLoggedAt.clear();
  lastLookupFailureLoggedAt.clear();
  lastModeResolved.clear();
  llDemotedAt.clear();
  if (memoPruneTimer) {
    clearInterval(memoPruneTimer);
    memoPruneTimer = null;
  }
  memoEntriesScanned = 0;
  memoSaturatedAt = null;
  memoFullLoggedAt = 0;
  pendingDemotions.clear();
  llStartFailures = 0;
  llStopFailures = 0;
  llDemoted = 0;
}
