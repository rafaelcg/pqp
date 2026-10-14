import { hasPermission, Permission } from "@pqp/shared";
import { getPool, type DbUser } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { computeMemberPermissions } from "./permissions.js";

/**
 * Reminders a server bot keeps: "me lembra amanhã às 20h" from anybody, and a
 * repeating channel announcement from staff ("avisa todo sábado"). No model
 * runs when one fires: the text goes out as it was set, so a reminder costs
 * nothing then. The bot's tools set them (`create_reminder` and friends in
 * `bot-actions.ts`); `deliverDueReminders` is the job that posts them.
 */

export const REMINDERS_PER_MEMBER = 5;
export const REMINDERS_PER_SERVER = 50;
/** How far ahead a reminder may be set, and how soon. */
export const REMINDER_MAX_DAYS = 30;
export const REMINDER_MIN_LEAD_MS = 60_000;
export const REMINDER_TEXT_MAX = 300;
export const REMINDER_REPEATS = ["daily", "weekly"] as const;
export type ReminderRepeat = (typeof REMINDER_REPEATS)[number];
const REPEAT_MS: Record<ReminderRepeat, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };

/** How often the job looks for due reminders, and how long a claim holds. */
export const BOT_REMINDERS_INTERVAL_MS = 30_000;
const LEASE_SECONDS = 60;
const BATCH = 20;

export interface ReminderRow {
  id: string;
  bot_id: string;
  server_id: string;
  channel_id: string;
  requester_id: string;
  text: string;
  /** `me` mentions the member who set it; `channel` is an announcement. */
  kind: "me" | "channel";
  due_at: Date;
  repeat: ReminderRepeat | null;
  next_nonce: string;
}

/**
 * Store one, inside the caps: a member's open reminders and the server's. One
 * statement, so two requests at once cannot both take the last place.
 */
export async function createReminder(input: {
  botId: string;
  serverId: string;
  channelId: string;
  requesterId: string;
  text: string;
  kind: "me" | "channel";
  dueAt: Date;
  repeat: ReminderRepeat | null;
}): Promise<{ id: string } | { refused: "member" | "server" }> {
  const result = await getPool().query<{ id: string | null; mine: number; all: number }>(
    `WITH counts AS (
       SELECT COUNT(*) FILTER (WHERE requester_id = $4)::int AS mine, COUNT(*)::int AS all
         FROM server_bot_reminders WHERE server_id = $2 AND status = 'pending'
     ),
     made AS (
       INSERT INTO server_bot_reminders (bot_id, server_id, channel_id, requester_id, text, kind, due_at, repeat)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8 FROM counts
        WHERE counts.mine < $9 AND counts.all < $10
       RETURNING id
     )
     SELECT (SELECT id FROM made) AS id, counts.mine, counts.all FROM counts`,
    [
      input.botId,
      input.serverId,
      input.channelId,
      input.requesterId,
      input.text,
      input.kind,
      input.dueAt,
      input.repeat,
      REMINDERS_PER_MEMBER,
      REMINDERS_PER_SERVER,
    ],
  );
  const row = result.rows[0]!;
  if (row.id) {
    return { id: row.id };
  }
  return { refused: row.mine >= REMINDERS_PER_MEMBER ? "member" : "server" };
}

/** A member's open reminders here, and every announcement when they are staff. */
export async function listReminders(input: {
  serverId: string;
  requesterId: string;
  withAnnouncements: boolean;
}): Promise<Array<ReminderRow & { channel_name: string; requester_name: string }>> {
  const result = await getPool().query<ReminderRow & { channel_name: string; requester_name: string }>(
    `SELECT r.*, c.name AS channel_name, u.display_name AS requester_name
       FROM server_bot_reminders r
       JOIN channels c ON c.id = r.channel_id
       JOIN users u ON u.id = r.requester_id
      WHERE r.server_id = $1 AND r.status = 'pending'
        AND (r.requester_id = $2 OR ($3 AND r.kind = 'channel'))
      ORDER BY r.due_at
      LIMIT 50`,
    [input.serverId, input.requesterId, input.withAnnouncements],
  );
  return result.rows;
}

export async function getReminder(serverId: string, id: string): Promise<ReminderRow | null> {
  const result = await getPool().query<ReminderRow>(
    `SELECT * FROM server_bot_reminders WHERE server_id = $1 AND id = $2 AND status = 'pending'`,
    [serverId, id],
  );
  return result.rows[0] ?? null;
}

export async function cancelReminder(serverId: string, id: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE server_bot_reminders SET status = 'cancelled', finished_at = NOW()
      WHERE server_id = $1 AND id = $2 AND status = 'pending'`,
    [serverId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The next time a repeating reminder fires after `now`, counted from its own
 * schedule: a reminder that missed a few while the API was down fires once,
 * on its next slot, and does not post the backlog.
 */
export function nextOccurrence(dueAt: Date, repeat: ReminderRepeat, now: number = Date.now()): Date {
  const step = REPEAT_MS[repeat];
  const missed = Math.max(0, Math.floor((now - dueAt.getTime()) / step) + 1);
  return new Date(dueAt.getTime() + missed * step);
}

/**
 * Post every reminder that is due. Claimed with a lease and `SKIP LOCKED`, so
 * two processes running jobs never take the same one; and posted with a nonce
 * that is checked first, so a claim that ran out after posting does not post
 * twice. Each is checked again before it goes out: the member is still here
 * and may still post there, the bot is still on, and for an announcement the
 * member is still staff. One that fails that is cancelled, not retried.
 */
export async function deliverDueReminders(): Promise<number> {
  const claimed = await getPool().query<ReminderRow>(
    `UPDATE server_bot_reminders r
        SET lease_until = NOW() + make_interval(secs => $1)
      WHERE r.id IN (
              SELECT id FROM server_bot_reminders
               WHERE status = 'pending' AND due_at <= NOW()
                 AND (lease_until IS NULL OR lease_until < NOW())
               ORDER BY due_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED)
      RETURNING r.*`,
    [LEASE_SECONDS, BATCH],
  );
  for (const reminder of claimed.rows) {
    try {
      await deliverOne(reminder);
    } catch (error) {
      logEvent("bots.reminderError", {
        reminderId: reminder.id,
        message: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }
  return claimed.rows.length;
}

async function deliverOne(reminder: ReminderRow): Promise<void> {
  const context = await getPool().query<{
    bot_user_id: string;
    enabled: boolean;
    member: boolean;
    username: string | null;
    display_name: string;
  }>(
    `SELECT b.user_id AS bot_user_id, b.enabled,
            EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = $1 AND m.user_id = $3) AS member,
            u.username, u.display_name
       FROM server_bots b, users u
      WHERE b.id = $2 AND u.id = $3`,
    [reminder.server_id, reminder.bot_id, reminder.requester_id],
  );
  const row = context.rows[0];
  const { findTimeoutForChannel } = await import("./sanctions.js");
  const timedOut = row ? (await findTimeoutForChannel(reminder.requester_id, reminder.channel_id)) !== null : false;
  const perms = row
    ? await computeMemberPermissions(reminder.server_id, reminder.requester_id, reminder.channel_id, { timedOut })
    : 0n;
  const allowed =
    !!row &&
    row.enabled &&
    row.member &&
    !timedOut &&
    isEnabled("custom_bots", { serverId: reminder.server_id }) &&
    hasPermission(perms, Permission.VIEW_CHANNEL) &&
    hasPermission(perms, Permission.SEND_MESSAGES) &&
    (reminder.kind === "me" || hasPermission(perms, Permission.MANAGE_MESSAGES));
  if (!allowed) {
    await cancelReminder(reminder.server_id, reminder.id);
    logEvent("bots.reminderDropped", { reminderId: reminder.id });
    return;
  }

  const { findMessageByNonce } = await import("./messages.js");
  const bot = await getPool().query<DbUser>(`SELECT * FROM users WHERE id = $1`, [row.bot_user_id]);
  const botUser = bot.rows[0]!;
  const already = await findMessageByNonce(reminder.channel_id, botUser.id, reminder.next_nonce);
  if (!already) {
    const { sanitizeBotReply } = await import("./bot-runner.js");
    const { postChannelMessage } = await import("../ws/chat.js");
    const text = sanitizeBotReply(reminder.text);
    const who = row.username ? `@${row.username}` : row.display_name;
    const posted = await postChannelMessage({
      author: botUser,
      channelId: reminder.channel_id,
      body: reminder.kind === "me" ? `⏰ ${who}, lembrete: ${text}` : `⏰ ${text}`,
      nonce: reminder.next_nonce,
    });
    logEvent("bots.reminder", { reminderId: reminder.id, ok: posted.ok, ...(posted.ok ? {} : { reason: posted.reason }) });
  }
  await getPool().query(
    reminder.repeat
      ? `UPDATE server_bot_reminders
            SET due_at = $2, next_nonce = gen_random_uuid(), sent_count = sent_count + 1, lease_until = NULL
          WHERE id = $1`
      : `UPDATE server_bot_reminders
            SET status = 'sent', sent_count = sent_count + 1, finished_at = NOW(), lease_until = NULL
          WHERE id = $1`,
    reminder.repeat ? [reminder.id, nextOccurrence(reminder.due_at, reminder.repeat)] : [reminder.id],
  );
}
