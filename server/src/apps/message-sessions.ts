import type { MessageAppSession } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";

/**
 * The session behind each timeline card, for the message read paths: one
 * statement per page, and none at all for a page with no app card on it. The
 * join is `app_sessions.timeline_message_id` (indexed). A card whose session
 * was retained away (30 days after it ended) has no entry: the caller sends
 * `null`.
 */
export async function listAppSessionsForMessages(
  rows: ReadonlyArray<{ id: string; system_kind?: string | null }>,
): Promise<Map<string, MessageAppSession>> {
  const ids = rows.filter((row) => row.system_kind === "app_session").map((row) => row.id);
  const out = new Map<string, MessageAppSession>();
  if (ids.length === 0) {
    return out;
  }
  let result;
  try {
    result = await getPool().query<{
    timeline_message_id: string;
    id: string;
    app_id: string;
    app_version: string;
    status: "live" | "ended";
    end_reason: MessageAppSession["endReason"];
    summary: MessageAppSession["summary"];
    started_by: string | null;
  }>(
    `SELECT timeline_message_id, id, app_id, app_version, status, end_reason, summary, started_by
       FROM app_sessions WHERE timeline_message_id = ANY($1::uuid[])`,
    [ids],
  );
  } catch (error) {
    // A card is decoration on a message: a failed lookup must never fail the
    // read of the whole page. The cards then read as their plain-text body,
    // and the next read has them.
    logEvent("apps.cardSessionsUnread", { error: String(error) });
    return out;
  }
  for (const row of result.rows) {
    out.set(row.timeline_message_id, {
      id: row.id,
      appId: row.app_id,
      appVersion: row.app_version,
      status: row.status,
      endReason: row.end_reason,
      summary: row.summary,
      startedBy: row.started_by,
    });
  }
  return out;
}
