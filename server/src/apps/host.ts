import { getPool, type DbUser } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { HttpError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import { HttpErrorWithDetail } from "../lib/route-results.js";
import { announceChannelApp, announceRoster } from "../ws/apps.js";
import { canAccessChannel } from "../services/users.js";
import { loadPinnedManifest } from "./manifests.js";
import { pickNextHost } from "./next-host.js";
import { recordAppHandoff } from "./metrics.js";

/**
 * THE HOST IS A ROLE, NOT A PROCESS (PLAN D7).
 *
 * State lives on the server, so a host leaving destroys nothing (the opposite
 * of a watch party, whose stream dies with the host's machine). When the host
 * has no present seat the session stamps `host_gone_at`; two minutes later
 * (a reload or a dead wifi is shorter than that, and nothing is streaming) the
 * server gives the role to the longest seated participant who is HERE and who
 * could have started the app. No vote and no race: the server chooses.
 *
 * While the countdown runs everyone who can see the channel sees who is next
 * and when (`channel-app` carries `handoff: { toUserId, at }`), and the chosen
 * person can take the role at once (`POST /api/app-sessions/:id/take-host`,
 * "Assumir agora"). An app that declares `hostBound: true` (the truth is on the
 * host's machine) ends after the same grace instead. Who is next and the
 * countdown are in `next-host.ts`.
 */

/**
 * Move the host role from `from` to `to`, only if the session is still live,
 * still waiting on that host and still counting down. One compare-and-set, so
 * the sweep on one machine and the person's tap on another cannot both win.
 */
export async function completeHandoff(
  sessionId: string,
  from: string | null,
  to: string,
  via: "sweep" | "take",
): Promise<boolean> {
  const result = await getPool().query<{ channel_id: string }>(
    `UPDATE app_sessions SET host_user_id = $3, host_gone_at = NULL
      WHERE id = $1 AND status = 'live' AND host_gone_at IS NOT NULL
        AND host_user_id IS NOT DISTINCT FROM $2
      RETURNING channel_id`,
    [sessionId, from, to],
  );
  const row = result.rows[0];
  if (!row) {
    return false;
  }
  recordAppHandoff(via);
  logEvent("apps.session.handoff", { sessionId, via });
  // `isHost` flips in everybody's snapshot, and the strip's countdown clears.
  announceRoster(sessionId, row.channel_id);
  void announceChannelApp(row.channel_id, { immediate: true });
  return true;
}

/**
 * "Assumir agora": the person the countdown named takes the role before the
 * two minutes are up. 404 for a session the caller cannot see (or with the flag
 * off); 409 `host_present` when nothing is counting down, 409 `host_bound` for
 * an app that ends with its host; 403 `not_next_host` for anybody but the
 * chosen person.
 */
export async function takeHostAs(
  user: Pick<DbUser, "id">,
  sessionId: string,
): Promise<{ host: true }> {
  const result = await getPool().query<{
    server_id: string;
    channel_id: string;
    app_id: string;
    app_version: string;
    host_user_id: string | null;
    host_gone_at: Date | null;
  }>(
    `SELECT server_id, channel_id, app_id, app_version, host_user_id, host_gone_at
       FROM app_sessions WHERE id = $1 AND status = 'live'`,
    [sessionId],
  );
  const row = result.rows[0];
  if (
    !row ||
    !isEnabled("apps", { serverId: row.server_id }) ||
    !(await canAccessChannel(row.channel_id, user.id))
  ) {
    throw new HttpError(404, "Session not found");
  }
  const manifest = await loadPinnedManifest(row.app_id, row.app_version);
  if (!manifest) {
    throw new HttpError(404, "Session not found");
  }
  if (manifest.hostBound) {
    throw new HttpErrorWithDetail(409, "host_bound", {});
  }
  if (row.host_gone_at === null) {
    throw new HttpErrorWithDetail(409, "host_present", {});
  }
  if ((await pickNextHost(sessionId)) !== user.id) {
    throw new HttpError(403, "not_next_host");
  }
  if (!(await completeHandoff(sessionId, row.host_user_id, user.id, "take"))) {
    // Somebody else moved first (the sweep, or the old host came back).
    throw new HttpErrorWithDetail(409, "host_changed", {});
  }
  return { host: true };
}
