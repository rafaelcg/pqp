/**
 * Live HLS retention sweep: deletes a finished session's bucket objects once
 * its grace window has passed, and marks the row `cleaned_at` so it is never
 * picked up again.
 *
 * A session is due when `cleaned_at IS NULL` and `ended_at` is set, and
 * either:
 *   - `keep_replay = false` and `ended_at` is more than
 *     `LIVE_HLS_RETENTION_MINUTES` ago (the default: ephemeral, gone in
 *     ~10 minutes), or
 *   - `keep_replay = true` and `ended_at` is more than `LIVE_HLS_REPLAY_HOURS`
 *     ago (an explicit "keep this one" gets a day instead of ten minutes).
 *
 * Safety property this file exists to hold: the sweep deletes only objects
 * whose key starts with *that session's own* `object_prefix` -- the same
 * string `hls-egress.ts` used as `filenamePrefix` when it told LiveKit where
 * to write, so every object the session ever created starts with it and no
 * other session's objects do (each session's prefix embeds its own
 * `startedAt` millisecond timestamp, which is what makes it unique per
 * `hls_sessions.object_prefix UNIQUE`). `hls-cleanup.test.ts` deliberately
 * breaks the channel/prefix filter to prove a bug here would be caught.
 */
import { getPool } from "../db.js";
import { deleteObject, listObjectKeys, type StorageConfig } from "../lib/s3.js";
import { logEvent } from "../lib/log.js";
import { processRole } from "../lib/process-role.js";
import {
  hlsReplayHours,
  hlsRetentionMinutes,
  liveHlsStorageConfig,
  adoptLiveHlsSession,
  listActiveEgresses,
  stopEgressById,
} from "./hls-egress.js";

const SWEEP_BATCH = 25;

/**
 * One line per distinct misconfiguration, not one per minute. The sweep ticks
 * every 60 s and a misconfiguration is a standing condition, so an unthrottled
 * log would be 1,440 identical lines a day and the alert that matters would be
 * the one nobody reads.
 */
const warned = new Set<string>();
function warnOnce(key: string, emit: () => void): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  emit();
}

/** Test hook: forget the once-per-process warnings. */
export function resetHlsSweepWarningsForTests(): void {
  warned.clear();
}

/**
 * How many finished sessions are past their retention window and still hold
 * objects. This is the number that should sit at zero on a deployment whose
 * sweep runs, and climb forever on one whose sweep cannot. `sweepHlsSessions`
 * reads it to decide whether a missing configuration is harmless or is
 * quietly leaking a bucket, and `services/metrics.ts` reports it.
 */
export async function countDueSessions(
  retentionMinutes = hlsRetentionMinutes(),
  replayHours = hlsReplayHours(),
): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM hls_sessions
     WHERE cleaned_at IS NULL
       AND ended_at IS NOT NULL
       AND (
         (keep_replay = FALSE AND ended_at < NOW() - ($1 || ' minutes')::interval)
         OR
         (keep_replay = TRUE AND ended_at < NOW() - ($2 || ' hours')::interval)
       )`,
    [retentionMinutes, replayHours],
  );
  return Number(result.rows[0]?.n ?? 0);
}

interface StaleSession {
  id: string;
  channel_id: string;
  object_prefix: string;
  egress_id: string | null;
  presenter_peer_id: string | null;
  video_track_id: string | null;
  rung: string | null;
  still_open: boolean;
}

/**
 * `live/<channelId>/<startedAt>-<rung>` -> startedAt, and the rung beside it.
 *
 * The rung suffix is why this cannot be a bare `Number(tail)` any more: with
 * a ladder every prefix ends `-1080p30` or similar, `Number` answers NaN, and
 * a row that cannot be parsed is treated as unadoptable and its egress
 * STOPPED. That would kill a live watch party on every deploy, which is the
 * exact failure this whole file was written to stop.
 */
function sessionFromPrefix(
  prefix: string,
): { startedAt: number; rung: string | null } | null {
  const tail = prefix.split("/").pop() ?? "";
  const dash = tail.indexOf("-");
  const startedAtPart = dash === -1 ? tail : tail.slice(0, dash);
  const rung = dash === -1 ? null : tail.slice(dash + 1);
  const parsed = Number(startedAtPart);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return { startedAt: parsed, rung: rung || null };
}

interface DueSession {
  id: string;
  channel_id: string;
  object_prefix: string;
  egress_id: string | null;
}

/**
 * The manifest LiveKit egress writes when it finishes: `<dir>/<egressId>.json`
 * beside the segments, where `<dir>` is the directory part of
 * `filenamePrefix`. It is NOT under the session's own prefix (which is a
 * file prefix, `live/<channel>/<startedAt>`), so the prefix listing never
 * sees it and a sweep that only listed would leave one JSON per session
 * behind forever. Known from the local-stack QA of 2026-09-07.
 */
export function hlsManifestKey(
  channelId: string,
  egressId: string,
): string {
  return `live/${channelId}/${egressId}.json`;
}

/**
 * Rows due for cleanup right now. A plain SQL predicate rather than "list
 * everything and filter in JS" so the two clauses (short window for a plain
 * recording, long window for a kept replay) can never drift from what is
 * actually enforced -- there is exactly one place this rule is spelled out.
 */
async function dueSessions(
  retentionMinutes: number,
  replayHours: number,
): Promise<DueSession[]> {
  const result = await getPool().query<DueSession>(
    `SELECT id, channel_id, object_prefix, egress_id
     FROM hls_sessions
     WHERE cleaned_at IS NULL
       AND ended_at IS NOT NULL
       AND (
         (keep_replay = FALSE AND ended_at < NOW() - ($1 || ' minutes')::interval)
         OR
         (keep_replay = TRUE AND ended_at < NOW() - ($2 || ' hours')::interval)
       )
     ORDER BY ended_at ASC
     LIMIT ${SWEEP_BATCH}`,
    [retentionMinutes, replayHours],
  );
  return result.rows;
}

/**
 * Deletes every object under one session's own prefix. The channel id is
 * passed in only to be asserted against the prefix it is deleting -- a
 * belt-and-braces check, since the prefix already embeds the channel id and
 * a caller who mismatches them has a bug, not a legitimate cross-channel
 * delete to perform.
 */
async function deleteSessionObjects(
  config: StorageConfig,
  channelId: string,
  objectPrefix: string,
  egressId: string | null,
): Promise<number> {
  const expectedDir = `live/${channelId}/`;
  if (!objectPrefix.startsWith(expectedDir)) {
    // This is the guard the whole file exists for: never delete under a
    // prefix that does not belong to the channel it claims to. Refusing
    // loudly here is the difference between a bug that deletes nothing and
    // a bug that deletes a stranger's watch party.
    throw new Error(
      `refusing to sweep hls_sessions row: prefix "${objectPrefix}" does not ` +
        `belong to channel ${channelId}`,
    );
  }
  const keys = await listObjectKeys(objectPrefix, config);
  // Validate every key BEFORE deleting any of them: a listing that leaks one
  // stranger key must not have already deleted this session's own objects
  // by the time it is caught. All-or-nothing, not "delete what looked safe".
  for (const key of keys) {
    if (!key.startsWith(objectPrefix)) {
      // listObjectKeys was asked for this prefix; a key outside it means the
      // bucket lied or the listing call was built wrong. Either way, do not
      // delete it -- or anything else from this batch.
      throw new Error(
        `refusing to delete "${key}": outside prefix "${objectPrefix}"`,
      );
    }
  }
  for (const key of keys) {
    await deleteObject(key, config);
  }
  if (egressId) {
    // The manifest lives beside the prefix, so it is deleted by name. The
    // key is built from the same channel id the guard above vetted, and
    // S3 DELETE on a key that was never written is a no-op, not an error.
    await deleteObject(hlsManifestKey(channelId, egressId), config);
    return keys.length + 1;
  }
  return keys.length;
}

/**
 * Boot-time reconcile. A session row is opened when an egress starts and
 * closed by the same process when the share ends; a process that died
 * mid-share (a deploy, a crash) leaves `ended_at NULL` forever, the sweep
 * never picks it up and its objects sit in the bucket for good. This
 * process owns no session at boot, so every open row is stale by
 * definition: end it now so retention runs, and stop the egress LiveKit may
 * still be running for it. Only the API process may call this; a worker
 * that ran it would end the API's live sessions.
 */
export async function reconcileStaleHlsSessions(): Promise<{
  adopted: number;
  ended: number;
  stopped: number;
}> {
  const active = await listActiveEgresses();
  if (active === null) {
    // Could not ask the media server. Ending rows now would let the sweep
    // delete segments out from under an egress that is still writing them,
    // which is the exact failure this function exists to prevent. Leave
    // everything alone; the next boot, or the health monitor, will do it.
    logEvent("voice.hlsBootReconcileSkipped", { reason: "list-egress-failed" });
    return { adopted: 0, ended: 0, stopped: 0 };
  }

  const rows = await getPool().query<StaleSession>(
    `SELECT id, channel_id, object_prefix, egress_id, presenter_peer_id,
            video_track_id, rung, ended_at IS NULL AS still_open
     FROM hls_sessions
     WHERE cleaned_at IS NULL
       AND (ended_at IS NULL OR ended_at > NOW() - INTERVAL '1 hour')`,
  );
  const byEgressId = new Map(
    rows.rows.filter((row) => row.egress_id).map((row) => [row.egress_id!, row]),
  );

  let adopted = 0;
  let stopped = 0;
  const adoptedIds = new Set<string>();

  for (const info of active) {
    const row = byEgressId.get(info.egressId);
    const session = row ? sessionFromPrefix(row.object_prefix) : null;
    if (!row || session === null || !row.presenter_peer_id) {
      // Nobody owns this transcode: no session row, or one we cannot rebuild
      // a room from. Left running it burns a core of the media box forever.
      const wasStopped = await stopEgressById(info.egressId, info.roomName);
      if (wasStopped) {
        stopped += 1;
        logEvent("voice.hlsOrphanEgressStopped", {
          channelId: info.roomName ?? null,
          egressId: info.egressId,
          reason: row ? "session-not-adoptable" : "no-session-row",
        });
      }
      continue;
    }
    // Still running and still ours: take it back rather than killing a live
    // watch party because the API happened to restart.
    adoptLiveHlsSession({
      channelId: row.channel_id,
      egressId: info.egressId,
      startedAt: session.startedAt,
      presenterPeerId: row.presenter_peer_id,
      videoTrackId: row.video_track_id ?? "",
      rung: row.rung ?? session.rung,
    });
    adoptedIds.add(row.id);
    adopted += 1;
  }

  // Reopen the rows we adopted (a previous process may have ended them) and
  // end the ones with no egress behind them any more, so retention runs.
  if (adoptedIds.size > 0) {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NULL
       WHERE id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
      [[...adoptedIds]],
    );
  }
  const toEnd = rows.rows
    .filter((row) => row.still_open && !adoptedIds.has(row.id))
    .map((row) => row.id);
  let ended = 0;
  if (toEnd.length > 0) {
    const result = await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [toEnd],
    );
    ended = result.rowCount ?? 0;
  }

  logEvent("voice.hlsBootReconciled", { adopted, ended, stopped });
  return { adopted, ended, stopped };
}

/**
 * The worker-safe cleanup tick, wired into `jobs.ts` the same way every
 * other cold sweep is. Returns the number of sessions cleaned, for logging
 * and tests.
 */
export async function sweepHlsSessions(): Promise<number> {
  const config = liveHlsStorageConfig();
  if (!config) {
    // "No storage here" used to mean "nothing ever wrote an object", and the
    // function returned 0 without asking anything. That reasoning holds for a
    // one-process deployment and is FALSE for the split one production runs:
    // `pqp-api` has `LIVE_HLS_S3_*` and `WORKER_MODE=api`, so it never runs
    // this; `pqp-worker` runs it and (until somebody sets them) has none of
    // those secrets. Every watch party's segments would then sit in the
    // bucket for good, and the only evidence would be the R2 bill. So look
    // for the rows first and say so when they exist.
    const orphaned = await countDueSessions().catch(() => 0);
    if (orphaned > 0) {
      warnOnce("no-storage", () =>
        logEvent("voice.hlsSweepMisconfigured", {
          reason: "no-live-hls-storage",
          due: orphaned,
          role: processRole(),
          hint: "this process runs the retention sweep but has no LIVE_HLS_S3_* configuration",
        }),
      );
    }
    return 0;
  }
  const due = await dueSessions(hlsRetentionMinutes(), hlsReplayHours());
  if (due.length === 0) {
    return 0;
  }
  // ASK THE MEDIA SERVER, DO NOT TRUST THE ROW. `ended_at` says when THIS
  // cluster stopped believing in a session, and the two can disagree: an API
  // that restarted mid-share leaves a row ended while the egress keeps
  // writing segments. Deleting those is not a tidy-up, it breaks a live
  // stream in a way that looks like corruption rather than a restart. So a
  // prefix whose egress is still running is skipped, and "cannot ask" is
  // treated as "still running" rather than as permission to delete.
  const active = await listActiveEgresses();
  if (active === null) {
    logEvent("voice.hlsSweepSkipped", {
      reason: "list-egress-failed",
      due: due.length,
    });
    return 0;
  }
  const activeEgressIds = new Set(active.map((info) => info.egressId));
  let cleaned = 0;
  for (const session of due) {
    if (session.egress_id && activeEgressIds.has(session.egress_id)) {
      logEvent("voice.hlsSweepSkippedLiveEgress", {
        sessionId: session.id,
        channelId: session.channel_id,
        egressId: session.egress_id,
      });
      continue;
    }
    try {
      const deletedCount = await deleteSessionObjects(
        config,
        session.channel_id,
        session.object_prefix,
        session.egress_id,
      );
      await getPool().query(
        `UPDATE hls_sessions SET cleaned_at = NOW() WHERE id = $1`,
        [session.id],
      );
      logEvent("voice.hlsSessionCleaned", {
        sessionId: session.id,
        channelId: session.channel_id,
        objectsDeleted: deletedCount,
      });
      cleaned += 1;
    } catch (error) {
      logEvent("voice.hlsSessionCleanupFailed", {
        sessionId: session.id,
        channelId: session.channel_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return cleaned;
}
