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
import {
  heartbeatVoiceInstance,
  INSTANCE_TTL_MS,
  isVoiceRegistryEnabled,
} from "./registry.js";

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
  tornDownAt.clear();
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
  options: HlsOwnershipOptions & {
    reopen?: boolean;
    /**
     * When this claim was decided, in wall-clock ms. THE WRITE IS CONDITIONAL
     * ON IT: a row whose `ended_at` is NEWER than this was torn down after the
     * claim was decided, and reopening it then would resurrect a session whose
     * egress is gone. Defaults to now, which is right for a claim issued
     * inline; a queued retry passes the moment each id was ORIGINALLY queued,
     * so a teardown that raced the first attempt still wins minutes later.
     */
    claimedAt?: number;
  } = {},
): Promise<boolean> {
  const claimedAt = options.claimedAt ?? Date.now();
  return writeHlsSessionClaims(
    sessionIds.map((id) => ({
      id,
      reopen: Boolean(options.reopen),
      claimedAt,
    })),
    options.instanceId,
  );
}

/**
 * The write itself, PER ID: its own `reopen` and its own decided-at instant.
 *
 * One timestamp for a whole batch was wrong in exactly one direction and it
 * matters: a retry queue holds claims decided at different moments, and
 * judging a newly queued id by the OLDEST one in the batch suppresses a valid
 * claim for a session that was legitimately ended before that older claim
 * existed -- and, because the write "succeeded", drops it from the queue for
 * good. `unnest` carries the three columns together so every row is judged
 * against its own intent, in one round trip.
 */
async function writeHlsSessionClaims(
  entries: readonly { id: string; reopen: boolean; claimedAt: number }[],
  instanceId?: string,
): Promise<boolean> {
  if (entries.length === 0) {
    return true;
  }
  const me = instanceId ?? hlsOwnerInstanceId();
  // The belt to the SQL's braces: an id this process tore down since its claim
  // was decided is dropped before the write is even issued. The conditional
  // below is what actually closes the race (a teardown can land between this
  // check and the write, and does not need to be remembered here to be safe);
  // this only saves the round trip in the ordinary case.
  const live = entries.filter(
    (entry) => (tornDownAt.get(entry.id) ?? 0) <= entry.claimedAt,
  );
  const liveIds = new Set(live.map((entry) => entry.id));
  for (const entry of entries) {
    if (!liveIds.has(entry.id)) {
      pendingClaims.delete(entry.id);
    }
  }
  if (live.length === 0) {
    return true;
  }
  // AND THE OWNER MUST STILL BE TAKEABLE, but only where owners mean anything.
  // Two processes booting inside one heartbeat TTL can both read the same
  // owner as expired and both adopt; without this the second stamp would
  // simply overwrite the first and the row would name the machine that lost
  // the race, so the row itself is made the arbiter: unowned, already mine, or
  // owned by an instance that is not answering.
  //
  // WITH THE REGISTRY OFF THE CLAUSE IS OMITTED ENTIRELY, not merely harmless.
  // A single-process deployment has no live instance rows to speak of and can
  // perfectly well find one naming a previous boot that nothing prunes;
  // judging a self-host's adoption against those would refuse the only
  // process there is.
  const ownerPredicate = isVoiceRegistryEnabled()
    ? `AND (s.instance_id IS NULL
            OR s.instance_id = $2
            OR NOT EXISTS (
              SELECT 1 FROM voice_instances i
               WHERE i.instance_id::text = s.instance_id
                 AND i.heartbeat_at
                     > NOW() - ($5::bigint * INTERVAL '1 millisecond')))`
    : "";
  const params: unknown[] = [
    live.map((entry) => entry.id),
    me,
    live.map((entry) => entry.claimedAt),
    live.map((entry) => entry.reopen),
  ];
  if (ownerPredicate) {
    params.push(INSTANCE_TTL_MS);
  }
  try {
    const written = await getPool().query(
      `UPDATE hls_sessions s
          SET instance_id = $2,
              ended_at = CASE WHEN c.reopen THEN NULL ELSE s.ended_at END
         FROM unnest($1::uuid[], $3::bigint[], $4::boolean[])
                AS c(id, claimed_at_ms, reopen)
        WHERE s.id = c.id
          -- Never resurrect a swept row. On a RETRY this matters: minutes may
          -- have passed, and reopening a session whose objects are gone leaves
          -- an open row retention can never collect.
          AND s.cleaned_at IS NULL
          -- AND NEVER RESURRECT A ROW TORN DOWN SINCE THIS CLAIM WAS DECIDED.
          -- Cancelling the queue entry is not enough on its own: a retry can
          -- already be in flight when the teardown clears it, and would land
          -- afterwards with ended_at cleared. Postgres serialises the two
          -- statements either way round and this predicate loses whichever way
          -- it is the older intent.
          AND (s.ended_at IS NULL
               OR s.ended_at <= to_timestamp(c.claimed_at_ms / 1000.0))
          ${ownerPredicate}`,
      params,
    );
    const refused = live.length - (written.rowCount ?? live.length);
    if (refused > 0) {
      // Not an error and not retryable: the ROW refused, because it was swept,
      // torn down after this claim was decided, or taken by a machine that is
      // answering. Said out loud, because a stamp that did not land is exactly
      // what this file is about.
      logEvent("voice.hlsSessionClaimRefused", {
        refused,
        of: live.length,
        sessionIds: live.map((entry) => entry.id),
      });
    }
    for (const entry of live) {
      pendingClaims.delete(entry.id);
    }
    return true;
  } catch (error) {
    const now = Date.now();
    for (const entry of live) {
      // The most demanding shape wins: a row that needed reopening still needs
      // it on the retry, even if a later claim for the same id did not. The
      // clock is the ORIGINAL queueing, so a retry never renews the TTL and
      // never moves the instant the write is judged against.
      const previous = pendingClaims.get(entry.id);
      pendingClaims.set(entry.id, {
        reopen: (previous?.reopen ?? false) || entry.reopen,
        queuedAt: previous?.queuedAt ?? Math.min(entry.claimedAt, now),
      });
    }
    logEvent("voice.hlsSessionClaimFailed", {
      count: live.length,
      pending: pendingClaims.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * A CLAIM IS ONLY DECISIVE IF THE CLAIMANT IS VISIBLY ALIVE.
 *
 * `claimHlsSessionRow`'s predicate lets a row be taken from an owner whose
 * heartbeat has expired, which is exactly what makes a claim work after a
 * restart — and exactly what makes TWO booting machines both succeed if
 * neither has written its own heartbeat yet: A stamps the row, B's UPDATE
 * re-evaluates against A, finds no live `voice_instances` row for it, and
 * takes it straight back. `startVoiceInstanceHeartbeat` fires its first beat
 * with `void`, so at boot that is not a hypothetical, it is the ordinary
 * ordering. Writing the row first costs one upsert per boot sweep and turns
 * "last writer wins" into "first writer wins", which is the only version of
 * this that has an answer.
 *
 * A no-op with the registry off (no heartbeats mean anything there) and a
 * swallowed failure: a beat that did not land leaves the claim no worse than
 * it was before this function existed.
 */
export async function ensureHlsOwnerHeartbeat(): Promise<void> {
  if (!isVoiceRegistryEnabled()) {
    return;
  }
  try {
    await heartbeatVoiceInstance();
  } catch (error) {
    logEvent("voice.hlsOwnerLookupFailed", {
      scope: "heartbeat",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * CLAIM ONE OPEN ROW, AND SAY WHETHER IT WAS ACTUALLY TAKEN.
 *
 * `claimHlsSessionRows` is a repair: it stamps rows this process has ALREADY
 * adopted in memory, and a refusal there is logged and otherwise survivable.
 * The LL path needs the opposite shape — a claim asked BEFORE anything is
 * started or reused, whose answer decides whether to proceed at all — because
 * on 2026-09-14 two machines booted three seconds apart against one open LL
 * row and both acted on it: B resumed the remux session, A read the same row
 * (still stamped with the dead pre-restart instance) and stopped the session B
 * had just taken over. Adopting first and stamping afterwards cannot tell
 * those two apart; a conditional UPDATE whose `rowCount` is the verdict can.
 *
 * Three answers, and the caller must treat them differently:
 *
 *  - `claimed`: the row is this process's now. Go ahead.
 *  - `refused`: swept, already ended, or owned by an instance that is
 *    answering its heartbeat. Do NOTHING to it — not start, not stop, not
 *    end. Somebody alive is driving it.
 *  - `failed`: the database could not be asked. Also do nothing, for the
 *    same reason `findOpenLlRow` fails closed: guessing is how a deploy kills
 *    a stream.
 *
 * With the registry off the owner predicate is omitted exactly as it is in
 * `writeHlsSessionClaims` — one process, no heartbeats to judge against, and
 * judging a self-host's only process against a previous boot's row would
 * refuse the only claimant there is.
 */
export async function claimHlsSessionRow(
  sessionId: string,
  options: HlsOwnershipOptions = {},
): Promise<"claimed" | "refused" | "failed"> {
  const me = options.instanceId ?? hlsOwnerInstanceId();
  const ttlMs = options.ttlMs ?? INSTANCE_TTL_MS;
  const ownerPredicate = isVoiceRegistryEnabled()
    ? `AND (s.instance_id IS NULL
            OR s.instance_id = $2
            OR NOT EXISTS (
              SELECT 1 FROM voice_instances i
               WHERE i.instance_id::text = s.instance_id
                 AND i.heartbeat_at
                     > NOW() - ($3::bigint * INTERVAL '1 millisecond')))`
    : "";
  const params: unknown[] = [sessionId, me];
  if (ownerPredicate) {
    params.push(ttlMs);
  }
  try {
    const written = await getPool().query(
      `UPDATE hls_sessions s
          SET instance_id = $2
        WHERE s.id = $1::uuid
          AND s.cleaned_at IS NULL
          -- An ENDED row is never claimable here. Unlike the batch repair
          -- above there is no reopen shape: a row somebody closed is a
          -- session that is over, and an LL start that wants one makes a new
          -- row rather than resurrecting this one.
          AND s.ended_at IS NULL
          ${ownerPredicate}`,
      params,
    );
    return (written.rowCount ?? 0) > 0 ? "claimed" : "refused";
  } catch (error) {
    logEvent("voice.hlsSessionClaimFailed", {
      count: 1,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/** Session ids whose ownership stamp did not land, and what they still want. */
const pendingClaims = new Map<string, { reopen: boolean; queuedAt: number }>();

/**
 * How long a queued stamp stays worth retrying. A claim is a repair of a write
 * about a session this process is DRIVING; once it has been waiting this long
 * the process has either been driving it all along (in which case the monitor's
 * own restart path is the authority on whether it still exists) or has long
 * since let it go, and replaying the stamp then can only resurrect a row.
 */
const CLAIM_RETRY_TTL_MS = 5 * 60_000;

/** For the dashboard and the tests: rows this process owns and cannot say so. */
export function pendingHlsSessionClaimCount(): number {
  return pendingClaims.size;
}

/**
 * THE SESSION IS OVER, SO THE STAMP IS NOT WANTED ANY MORE. A queued claim
 * carries `reopen`, and a teardown between the failure and the retry would
 * otherwise have the retry set `ended_at = NULL` on a row whose egress is
 * gone: an open row the retention sweep can never collect, which is the
 * opposite of the bug this file exists to avoid. Every teardown path that
 * knows a row id calls this.
 */
export function forgetPendingHlsSessionClaims(
  sessionIds: readonly (string | null | undefined)[],
  now = Date.now(),
): void {
  for (const [id, at] of tornDownAt) {
    if (now - at > CLAIM_RETRY_TTL_MS) {
      tornDownAt.delete(id);
    }
  }
  for (const id of sessionIds) {
    if (id) {
      pendingClaims.delete(id);
      tornDownAt.set(id, now);
    }
  }
}

/**
 * When each torn-down row was torn down, kept only as long as a claim could
 * still be queued for it. Pruned on every call above, so it is bounded by the
 * sessions one process tears down inside `CLAIM_RETRY_TTL_MS`.
 */
const tornDownAt = new Map<string, number>();

/**
 * Retry the stamps that failed, from the health monitor's tick. Two batches at
 * most (one per `reopen` shape) however many rows are waiting, and a no-op
 * with an empty queue, which is every tick on a healthy deployment. Entries
 * past `CLAIM_RETRY_TTL_MS` are dropped rather than replayed forever.
 */
export async function retryPendingHlsSessionClaims(
  now = Date.now(),
): Promise<void> {
  for (const [id, entry] of [...pendingClaims]) {
    if (now - entry.queuedAt > CLAIM_RETRY_TTL_MS) {
      pendingClaims.delete(id);
      logEvent("voice.hlsSessionClaimAbandoned", { sessionId: id });
    }
  }
  if (pendingClaims.size === 0) {
    return;
  }
  // EACH ID CARRIES ITS OWN decided-at instant, so one queue entry can never
  // suppress another: a session ended before an older claim was queued is
  // still claimable by its own newer one.
  await writeHlsSessionClaims(
    [...pendingClaims].map(([id, entry]) => ({
      id,
      reopen: entry.reopen,
      claimedAt: entry.queuedAt,
    })),
  );
}
