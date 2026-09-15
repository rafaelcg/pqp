import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  remuxControlSignaturePayload,
  remuxErrorResponseSchema,
  remuxListSessionsResponseSchema,
  remuxSessionInfoSchema,
  REMUX_CONTROL_NONCE_HEADER,
  REMUX_CONTROL_SIGNATURE_HEADER,
  REMUX_CONTROL_TIMESTAMP_HEADER,
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
 * Pure, so the whole matrix is testable with no environment and no database:
 * flag off -> `conventional`, whatever was requested. Flag on but the party
 * did not ask -> `conventional` (the default `docs/plans/LL_HLS.md` §4
 * requires). Flag on, asked, and either no allowlist or this server is on
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
  if (!isLiveHlsLLEnabled()) {
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
 * round). The caller (`reconcileLiveHlsNow` in `hls-egress.ts`) treats
 * `null` as "cannot decide this time" and makes NO mode change at all,
 * leaving whatever is currently running exactly as it is until the next
 * reconcile can actually ask.
 */
export async function requestedHlsModeForChannel(channelId: string): Promise<boolean | null> {
  try {
    const result = await getPool().query<{ low_latency_requested: boolean }>(
      `SELECT low_latency_requested FROM channel_sessions
       WHERE channel_id = $1 AND status = 'live'
       LIMIT 1`,
      [channelId],
    );
    return result.rows[0]?.low_latency_requested === true;
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
    const result = await getPool().query<{ channel_id: string }>(
      `UPDATE channel_sessions SET low_latency_requested = $1 WHERE id = $2
       RETURNING channel_id`,
      [requested, watchPartySessionId],
    );
    // A NEW PARTY IS NOT THE DEMOTED ONE. `noteLlDemotion` suppresses LL for
    // five minutes by channel, and without this a party starting on the same
    // channel inside that window would be forced onto the conventional ladder
    // by a verdict about a session that has already ended (a Farol finding on
    // PR #618). Pressing "Ir ao vivo" and asking for LL is the newest
    // statement about this channel, so it clears the memo; the durable
    // `low_latency_requested` it has just written is the only answer left.
    const channelId = result.rows[0]?.channel_id;
    if (requested && channelId) {
      forgetLlDemotion(channelId);
    }
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
 * episode. A demotion here means the same thing about the party, so a channel
 * demoted inside this window does not get LL re-selected however many times
 * the mode is re-resolved.
 */
const LL_DEMOTION_MEMO_MS = 5 * 60_000;

/** When this channel's LL session was last demoted, per channel. */
const llDemotedAt = new Map<string, number>();

/**
 * WHY BOTH A MEMO AND A COLUMN WRITE.
 *
 * `low_latency_requested` is the durable half: cleared, every reconcile on
 * every machine resolves `conventional` for the rest of this party, and the
 * next `goLive` writes it again unconditionally (`setRequestedHlsMode`), so a
 * demotion never outlives the party it happened to. That is the answer that
 * has to be right.
 *
 * The memo is the belt. The write can fail, and the read it feeds is a
 * DIFFERENT query on a different tick — between the demotion and the clear
 * landing, `requestedHlsModeForChannel` would still answer `true` and
 * `reconcileLiveHlsNow` would start a second LL session on top of the one
 * just given up on, which is the loop this whole fallback exists to end.
 * Process-local and five minutes long, it costs nothing and closes that gap
 * on the machine that did the demoting — the one that is about to reconcile.
 */
export function noteLlDemotion(channelId: string, now = Date.now()): void {
  for (const [id, at] of llDemotedAt) {
    if (now - at > LL_DEMOTION_MEMO_MS) {
      llDemotedAt.delete(id);
    }
  }
  llDemotedAt.set(channelId, now);
}

/** A newer party asked for LL on this channel: the old verdict is spent. */
export function forgetLlDemotion(channelId: string): void {
  llDemotedAt.delete(channelId);
}

/** Read by `reconcileLiveHlsNow`'s mode branch: LL is off for this channel. */
export function llDemotedRecently(channelId: string, now = Date.now()): boolean {
  const at = llDemotedAt.get(channelId);
  return at !== undefined && now - at < LL_DEMOTION_MEMO_MS;
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

/** The box's current answer for one specific session id, or null if it holds no such session. */
async function findRemuxSessionById(sessionId: string): Promise<RemuxSessionInfo | null> {
  try {
    const sessions = await remuxListSessions();
    return sessions.find((session) => session.sessionId === sessionId) ?? null;
  } catch {
    return null;
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
}

const llRooms = new Map<string, LlRoom>();
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
 * This does NOT mean an LL session is playable today: `renderSignedPlaylist`
 * has no idea what a `mode: 'll'` row is (`rung IS NULL` for one, so
 * `sessionRungs` treats it as a pre-ladder single-rendition session and goes
 * looking for a LiveKit-shaped object that was never written) and answers
 * "not found" rather than serving anything -- which is the honest, SAFE
 * failure this task's scope should produce: no client treats `mode: "ll"`
 * specially yet (`L2.4`), and the playlist front that would make this URL
 * actually resolve is `L2.1`/`L2.2`. What matters for L1.5 is that nothing
 * this server hands out can be played by someone the access check would
 * have refused, and that no response ever names the origin host.
 */
function llPlaylistUrl(channelId: string, startedAt: number): string {
  return `/api/voice/hls-playlist/${channelId}/${startedAt}`;
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
    }>(
      `SELECT id, started_at, remux_session_id, presenter_peer_id, stopping_at,
              stop_attempts, instance_id, watch_party_session_id
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
    // `failed` is treated like `refused` on purpose: a database we could not
    // ask is not permission, it is the absence of an answer, and the fail-
    // closed rule this whole file is built on (see `findOpenLlRow`) says do
    // nothing and let the next reconcile try.
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
  if (openRow) {
    // Our own unresolved attempt for this exact presenter: resume it
    // deterministically. `remuxSessionId` should already be set (the INSERT
    // below always writes it), but recomputing is the same value regardless
    // -- that recomputability is the whole point (see `deriveLlSessionId`).
    startedAt = openRow.startedAtMs;
    sessionId = openRow.remuxSessionId ?? deriveLlSessionId(channelId, startedAt);
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
      demotions.push({ channelId, sessionId: room.sessionId, reason: "session-gone" });
      continue;
    }
    if (remote.demoted === true || remote.state === "demoted") {
      demotions.push({
        channelId,
        sessionId: room.sessionId,
        // The box's own word for it (`idr-gap-exceeded`, `no-video`,
        // `part-stuck`), never a word invented here: an operator reading
        // `voice.hlsLlDemoted` and `pqp-remuxd`'s log has to see one reason.
        reason: remote.demotedReason ?? "demoted",
      });
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
    noteLlDemotion(channelId);
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
            stopping_at, stop_attempts, instance_id, watch_party_session_id
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
  lastLookupFailureLoggedAt.clear();
  llDemotedAt.clear();
  pendingDemotions.clear();
  llStartFailures = 0;
  llStopFailures = 0;
  llDemoted = 0;
}
