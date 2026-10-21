import { hasPermission, Permission } from "@pqp/shared";
import { getPool } from "../db.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { loadPinnedManifest } from "./manifests.js";

/**
 * WHO WOULD HOST NEXT, and the countdown that says so (PLAN D7). Reads only:
 * the summary shows the countdown to everyone who can see the channel, the
 * sweep acts on it, and the person it names may take the role at once
 * (`apps/host.ts`).
 */

/** How long a session waits for its host before the role moves or the session ends. */
export const APP_HANDOFF_GRACE_MS = 2 * 60_000;
/** Permission reads in flight at once while looking for the next host. */
const NEXT_HOST_WIDTH = 8;

/**
 * Who would host next, right now: the longest seated participant (oldest
 * `joined_at`) whose seat is present (not held, not left), who is not the
 * current host and who holds the manifest's start permission in the channel
 * (USE_APPS always, MANAGE_CHANNELS on top where the manifest asks) and can
 * still see it. Null when nobody qualifies. Asked afresh every time: the answer
 * moves as people join, leave and lose permissions.
 */
export async function pickNextHost(sessionId: string): Promise<string | null> {
  const session = await getPool().query<{
    server_id: string;
    channel_id: string;
    app_id: string;
    app_version: string;
    host_user_id: string | null;
    channel_type: string;
  }>(
    `SELECT s.server_id, s.channel_id, s.app_id, s.app_version, s.host_user_id,
            c.type AS channel_type
       FROM app_sessions s JOIN channels c ON c.id = s.channel_id
      WHERE s.id = $1 AND s.status = 'live'`,
    [sessionId],
  );
  const row = session.rows[0];
  if (!row) {
    return null;
  }
  const manifest = await loadPinnedManifest(row.app_id, row.app_version);
  if (!manifest) {
    return null;
  }
  const candidates = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM app_session_participants
      WHERE session_id = $1 AND left_at IS NULL AND orphaned_at IS NULL
        AND user_id IS DISTINCT FROM $2
      ORDER BY joined_at, user_id`,
    [sessionId, row.host_user_id],
  );
  // In a voice channel (or for an app that asks for it) a host must be able to
  // CONNECT: the platform's join floor, so the role never goes to a seat that
  // could not take one again.
  const needsConnect = row.channel_type === "voice" || manifest.requires.join === "CONNECT";
  const qualifies = async (userId: string): Promise<boolean> => {
    const permissions = await computeMemberPermissions(row.server_id, userId, row.channel_id);
    return (
      hasPermission(permissions, Permission.VIEW_CHANNEL) &&
      hasPermission(permissions, Permission.USE_APPS) &&
      (!needsConnect || hasPermission(permissions, Permission.CONNECT)) &&
      (manifest.requires.start !== "MANAGE_CHANNELS" ||
        hasPermission(permissions, Permission.MANAGE_CHANNELS))
    );
  };
  // Longest seated first, a few permission reads at a time: the answer is the
  // first qualifying candidate in that order, never the fastest to answer.
  for (let i = 0; i < candidates.rows.length; i += NEXT_HOST_WIDTH) {
    const chunk = candidates.rows.slice(i, i + NEXT_HOST_WIDTH);
    const answers = await Promise.all(chunk.map((candidate) => qualifies(candidate.user_id)));
    const found = answers.indexOf(true);
    if (found !== -1) {
      return chunk[found]!.user_id;
    }
  }
  return null;
}

/**
 * The countdown as the summary shows it: who is next and when the role moves,
 * for a session whose host is gone. Null for an app that ends with its host
 * (nothing is handed over).
 */
export async function handoffCountdown(session: {
  id: string;
  hostGoneAt: Date;
}): Promise<{ toUserId: string | null; at: string } | null> {
  const row = await getPool().query<{ app_id: string; app_version: string }>(
    `SELECT app_id, app_version FROM app_sessions WHERE id = $1`,
    [session.id],
  );
  const pinned = row.rows[0];
  const manifest = pinned ? await loadPinnedManifest(pinned.app_id, pinned.app_version) : null;
  if (!manifest || manifest.hostBound) {
    return null;
  }
  return {
    toUserId: await pickNextHost(session.id),
    at: new Date(session.hostGoneAt.getTime() + APP_HANDOFF_GRACE_MS).toISOString(),
  };
}
