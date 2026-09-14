/**
 * WHO OWNS AN `hls_sessions` ROW, AND WHY A SECOND MACHINE HAS TO ASK.
 *
 * Every watch-party transcode is started by one API process and recorded as
 * an `hls_sessions` row. Until this file existed the row said nothing about
 * which process that was, and `reconcileStaleHlsSessions` was written on the
 * single-machine assumption it states out loud: "this process owns no session
 * at boot, so every open row is stale by definition". On one machine that is
 * true. On the two `pqp-api` machines production is moving to, it is false in
 * the worst possible way: machine B booting -- which is every rolling deploy,
 * every crash restart -- reads machine A's LIVE rows, ADOPTS the egresses A is
 * still driving (two monitors on one transcode, then a restart from whichever
 * one decides the playlist stalled first) and ENDS the rows for anything the
 * media server did not happen to list, which hands the retention sweep a live
 * party's segments. The audience sees the film stop. Nothing logs a cause,
 * because from each machine's point of view it did exactly the right thing.
 *
 * The fix is the pattern the voice registry already runs: a row carries the
 * `instance_id` of the process that started or adopted it, `voice_instances`
 * carries that process's heartbeat, and anything that would ADOPT, END or
 * STOP a session first asks whether the owner is still answering. A row whose
 * owner is alive belongs to that owner; a row with no owner (written before
 * this column, or by a self-host) or one whose owner's heartbeat has expired
 * is free, exactly as `reconcileVoiceRegistry` treats a dead instance's seats.
 *
 * `VOICE_REGISTRY` OFF MEANS OFF, and that is the self-host's whole story: one
 * process, no `voice_instances` heartbeats to read, every open row adoptable
 * the way it has always been. Every helper here short-circuits to "nobody else
 * owns anything" in that mode, with no round trip.
 *
 * "COULD NOT ASK" IS NOT "NOBODY OWNS IT". A failed lookup answers `null`, and
 * the callers that would stop or end something on the strength of it do
 * nothing instead -- the same rule `listActiveEgresses` states for the
 * retention sweep. Guessing the other way is how a deploy kills a stream.
 */
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import { INSTANCE_TTL_MS, isVoiceRegistryEnabled } from "./registry.js";

/**
 * The identity stamped into `hls_sessions.instance_id`. The same process id
 * the cluster bus tags its frames with and `voice_peers.instance_id` carries,
 * deliberately: one process is one owner everywhere, and a heartbeat row in
 * `voice_instances` is what proves it is still alive.
 */
export function hlsOwnerInstanceId(): string {
  return INSTANCE_ID;
}

export interface HlsOwnershipOptions {
  /** This process's identity. Overridable so a test can play two machines. */
  instanceId?: string;
  /** The heartbeat expiry rule, shared with the voice registry. */
  ttlMs?: number;
}

/**
 * Rows skipped because a live instance other than this one owns them, since
 * this process started. Pitfall 12: a guard nobody can count is a guard
 * nobody knows is running. On one machine this belongs at zero forever; on
 * two it should be non-zero within one deploy of a watch party running, and a
 * zero there means the stamp never landed.
 */
let skippedOwnedElsewhere = 0;

/** Throttle for the skip log: one line per subject per minute, not per tick. */
const lastLoggedAt = new Map<string, number>();
const SKIP_LOG_THROTTLE_MS = 60_000;
const SKIP_LOG_FORGET_MS = 10 * 60_000;

export function hlsSkippedOwnedElsewhereCount(): number {
  return skippedOwnedElsewhere;
}

export function resetHlsOwnershipForTests(): void {
  skippedOwnedElsewhere = 0;
  lastLoggedAt.clear();
  pendingClaims.clear();
}

/**
 * Count (always) and narrate (at most once a minute per subject) one row left
 * alone because another live instance owns it. The monitor tick calls this
 * every few seconds for a stream that may run for hours, so an unthrottled
 * line here would be the noisiest thing in the log and the counter would be
 * the only part anybody read.
 */
export function noteHlsSkippedOwnedElsewhere(detail: {
  /** Which guard refused: `boot-adopt`, `boot-end`, `reap`, `ghost`, ... */
  site: string;
  channelId?: string | null;
  egressId?: string | null;
  sessionId?: string | null;
  ownerInstanceId?: string | null;
  now?: number;
}): void {
  skippedOwnedElsewhere += 1;
  const now = detail.now ?? Date.now();
  const key = `${detail.site}:${detail.egressId ?? detail.sessionId ?? detail.channelId ?? "?"}`;
  for (const [seen, at] of lastLoggedAt) {
    if (now - at > SKIP_LOG_FORGET_MS) {
      lastLoggedAt.delete(seen);
    }
  }
  const previous = lastLoggedAt.get(key);
  if (previous !== undefined && now - previous < SKIP_LOG_THROTTLE_MS) {
    return;
  }
  lastLoggedAt.set(key, now);
  logEvent("voice.hlsSkippedOwnedElsewhere", {
    site: detail.site,
    channelId: detail.channelId ?? null,
    egressId: detail.egressId ?? null,
    sessionId: detail.sessionId ?? null,
    ownerInstanceId: detail.ownerInstanceId ?? null,
  });
}

/**
 * Instance ids OTHER THAN THIS ONE whose `voice_instances` heartbeat is still
 * inside the TTL. Empty (no round trip) with the registry off. `null` when
 * the read failed, which every caller must treat as "do not judge a row by
 * this".
 *
 * One query for a whole boot sweep rather than one per row: a ladder is four
 * rows and a busy box a few ladders, and the answer is the same for all of
 * them.
 */
export async function liveOtherInstances(
  options: HlsOwnershipOptions = {},
): Promise<Set<string> | null> {
  if (!isVoiceRegistryEnabled()) {
    return new Set();
  }
  const me = options.instanceId ?? hlsOwnerInstanceId();
  const ttlMs = options.ttlMs ?? INSTANCE_TTL_MS;
  try {
    const result = await getPool().query<{ instance_id: string }>(
      // `::text` on both sides of the comparison, not because this process's
      // id is ever anything but a UUID, but so a row (or an override) that is
      // not one answers "no" instead of throwing inside a boot sweep.
      `SELECT instance_id::text AS instance_id FROM voice_instances
        WHERE instance_id::text <> $1
          AND heartbeat_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
      [me, ttlMs],
    );
    return new Set(result.rows.map((row) => row.instance_id));
  } catch (error) {
    logEvent("voice.hlsOwnerLookupFailed", {
      scope: "instances",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Is this row's owner somebody else who is still alive? `liveOthers` already
 * excludes this process, so an unowned row (NULL, the pre-column and
 * self-host shape) and this process's own rows are both free by construction.
 */
export function ownedByLiveOtherInstance(
  rowInstanceId: string | null | undefined,
  liveOthers: ReadonlySet<string>,
): boolean {
  return Boolean(rowInstanceId) && liveOthers.has(rowInstanceId!);
}

/**
 * Which of these LiveKit egress ids belong to a session row owned by another
 * live instance. For the guards that hold an egress id and no row: the health
 * monitor's reaper and the box-budget ghost filter.
 */
export async function egressIdsOwnedElsewhere(
  egressIds: readonly string[],
  options: HlsOwnershipOptions = {},
): Promise<Set<string> | null> {
  if (!isVoiceRegistryEnabled() || egressIds.length === 0) {
    return new Set();
  }
  const me = options.instanceId ?? hlsOwnerInstanceId();
  const ttlMs = options.ttlMs ?? INSTANCE_TTL_MS;
  try {
    const result = await getPool().query<{ egress_id: string }>(
      `SELECT DISTINCT s.egress_id
         FROM hls_sessions s
         -- voice_instances.instance_id is a UUID column and
         -- hls_sessions.instance_id is TEXT (nullable, and NULL is a real
         -- answer here), so the join casts rather than letting Postgres
         -- refuse uuid = text, or throw on a row that is not a UUID.
         JOIN voice_instances i ON i.instance_id::text = s.instance_id
        WHERE s.egress_id = ANY($1::text[])
          -- cleaned_at IS NULL is both right and fast: a swept row owns
          -- nothing, and it is the predicate idx_hls_sessions_egress is
          -- partial on, so this stays an index lookup as the table grows
          -- instead of scanning every session the deployment ever ran.
          AND s.cleaned_at IS NULL
          AND s.instance_id <> $2
          AND i.heartbeat_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')`,
      [[...egressIds], me, ttlMs],
    );
    return new Set(result.rows.map((row) => row.egress_id));
  } catch (error) {
    logEvent("voice.hlsOwnerLookupFailed", {
      scope: "egress",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The same question asked by `hls_sessions.id`, for the teardown path: the
 * room this process is stopping knows its own row ids.
 */
export async function sessionIdsOwnedElsewhere(
  sessionIds: readonly (string | null | undefined)[],
  options: HlsOwnershipOptions = {},
): Promise<Set<string> | null> {
  const ids = sessionIds.filter((id): id is string => Boolean(id));
  if (!isVoiceRegistryEnabled() || ids.length === 0) {
    return new Set();
  }
  const me = options.instanceId ?? hlsOwnerInstanceId();
  const ttlMs = options.ttlMs ?? INSTANCE_TTL_MS;
  try {
    const result = await getPool().query<{ id: string }>(
      `SELECT s.id
         FROM hls_sessions s
         -- voice_instances.instance_id is a UUID column and
         -- hls_sessions.instance_id is TEXT (nullable, and NULL is a real
         -- answer here), so the join casts rather than letting Postgres
         -- refuse uuid = text, or throw on a row that is not a UUID.
         JOIN voice_instances i ON i.instance_id::text = s.instance_id
        WHERE s.id = ANY($1::uuid[])
          AND s.instance_id <> $2
          AND i.heartbeat_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')`,
      [ids, me, ttlMs],
    );
    return new Set(result.rows.map((row) => row.id));
  } catch (error) {
    logEvent("voice.hlsOwnerLookupFailed", {
      scope: "session",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Re-stamp rows this process has just taken over, so the NEXT machine to boot
 * (or the one already running beside this one) can see an owner that is
 * answering. Adoption without this is half a fix: the row would still read as
 * the dead instance's and the sweep on the third machine would free it again.
 *
 * A CLAIM THAT FAILS IS NOT A CLAIM THAT DID NOT MATTER. The adoption itself
 * has already happened in memory -- this process is driving the egress -- so a
 * database blip here leaves a row that still names a dead instance (or nobody)
 * while a live process depends on it, which is precisely the state the next
 * machine's boot sweep is entitled to free. So a failure queues the ids and
 * `retryPendingHlsSessionClaims`, on the health monitor's tick, keeps trying
 * until the row says what is true. Answers whether the write landed.
 */
export async function claimHlsSessionRows(
  sessionIds: readonly string[],
  options: HlsOwnershipOptions & { reopen?: boolean } = {},
): Promise<boolean> {
  if (sessionIds.length === 0) {
    return true;
  }
  const me = options.instanceId ?? hlsOwnerInstanceId();
  try {
    await getPool().query(
      `UPDATE hls_sessions
          SET instance_id = $2${options.reopen ? ", ended_at = NULL" : ""}
        WHERE id = ANY($1::uuid[])`,
      [[...sessionIds], me],
    );
    for (const id of sessionIds) {
      pendingClaims.delete(id);
    }
    return true;
  } catch (error) {
    for (const id of sessionIds) {
      // The most demanding shape wins: a row that needed reopening still needs
      // it on the retry, even if a later claim for the same id did not.
      pendingClaims.set(id, (pendingClaims.get(id) ?? false) || Boolean(options.reopen));
    }
    logEvent("voice.hlsSessionClaimFailed", {
      count: sessionIds.length,
      pending: pendingClaims.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Session ids whose ownership stamp did not land, and whether to reopen them. */
const pendingClaims = new Map<string, boolean>();

/** For the dashboard and the tests: rows this process owns and cannot say so. */
export function pendingHlsSessionClaimCount(): number {
  return pendingClaims.size;
}

/**
 * Retry the stamps that failed, from the health monitor's tick. Two batches at
 * most (one per `reopen` shape) however many rows are waiting, and a no-op
 * with an empty queue, which is every tick on a healthy deployment.
 */
export async function retryPendingHlsSessionClaims(): Promise<void> {
  if (pendingClaims.size === 0) {
    return;
  }
  const reopen = [...pendingClaims].filter(([, wants]) => wants).map(([id]) => id);
  const plain = [...pendingClaims].filter(([, wants]) => !wants).map(([id]) => id);
  if (reopen.length > 0) {
    await claimHlsSessionRows(reopen, { reopen: true });
  }
  if (plain.length > 0) {
    await claimHlsSessionRows(plain);
  }
}
