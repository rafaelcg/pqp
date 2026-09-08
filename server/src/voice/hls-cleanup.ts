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
import {
  hlsReplayHours,
  hlsRetentionMinutes,
  liveHlsStorageConfig,
} from "./hls-egress.js";

const SWEEP_BATCH = 25;

interface DueSession {
  id: string;
  channel_id: string;
  object_prefix: string;
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
    `SELECT id, channel_id, object_prefix
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
  return keys.length;
}

/**
 * The worker-safe cleanup tick, wired into `jobs.ts` the same way every
 * other cold sweep is. Returns the number of sessions cleaned, for logging
 * and tests.
 */
export async function sweepHlsSessions(): Promise<number> {
  const config = liveHlsStorageConfig();
  if (!config) {
    // Nothing to sweep: without storage configured no session ever wrote an
    // object in the first place.
    return 0;
  }
  const due = await dueSessions(hlsRetentionMinutes(), hlsReplayHours());
  let cleaned = 0;
  for (const session of due) {
    try {
      const deletedCount = await deleteSessionObjects(
        config,
        session.channel_id,
        session.object_prefix,
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
