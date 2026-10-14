import type { ServerBotActivityItem } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { ACTIVITY_TIMEZONE, activityDay } from "./user-activity.js";

/**
 * What the operator reads about server bots, kept apart from the tables that
 * run them. `server_bot_runs`, `_plans` and `_actions` cascade away with their
 * bot, which is right for them and wrong for "how much did bots cost last
 * month": these rows carry no foreign key, so a deleted bot, or a deleted
 * server, leaves its history behind. Counts only, written as things finish;
 * nothing here is read back to decide a reply.
 *
 * The day is São Paulo's, like every other per-day count on the dashboard, and
 * like the cap a member sees reset at midnight.
 */

export function botDay(at: number = Date.now()): string {
  return activityDay(at);
}

/** When the next bot day starts: São Paulo's next midnight, as an instant. */
export function nextBotDayStart(at: number = Date.now()): Date {
  const [year, month, day] = botDay(at).split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(year, month - 1, day + 1);
  return new Date(utcMidnight - offsetMinutes(utcMidnight) * 60_000);
}

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ACTIVITY_TIMEZONE,
  timeZoneName: "longOffset",
});

/** The zone's offset from UTC at an instant, read rather than assumed. */
function offsetMinutes(at: number): number {
  const name = offsetFormatter.formatToParts(new Date(at)).find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!match) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * "2026-10-15T20:00" read as a São Paulo wall clock, as an instant. Null when
 * it is not a real date and time. The offset is read for that instant, not
 * assumed, so it stays right if the zone ever changes its rules again.
 */
export function saoPauloInstant(local: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00)?$/.exec(local.trim());
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    return null;
  }
  const first = wall - offsetMinutes(wall) * 60_000;
  return new Date(wall - offsetMinutes(first) * 60_000);
}

const labelFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: ACTIVITY_TIMEZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const nowFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ACTIVITY_TIMEZONE,
  weekday: "long",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** An instant as people in São Paulo read it, for a card: "qui., 15/10, 20:00". */
export function saoPauloLabel(at: Date): string {
  return labelFormatter.format(at);
}

/** Now in São Paulo, for the model: "Wednesday, 14/10/2026, 19:30". */
export function saoPauloNow(at: number = Date.now()): string {
  return nowFormatter.format(new Date(at));
}

/** How long the per-person rows live. They only exist to count distinct people. */
export const BOT_PEOPLE_RETENTION_DAYS = 90;

export interface BotStatsDelta {
  runs?: number;
  replies?: number;
  skipped?: number;
  failed?: number;
  asks?: number;
  plans?: number;
  plansConfirmed?: number;
  plansCancelled?: number;
  actionsDone?: number;
  actionsFailed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const COLUMNS: Array<[keyof BotStatsDelta, string]> = [
  ["runs", "runs"],
  ["replies", "replies"],
  ["skipped", "skipped"],
  ["failed", "failed"],
  ["asks", "asks"],
  ["plans", "plans"],
  ["plansConfirmed", "plans_confirmed"],
  ["plansCancelled", "plans_cancelled"],
  ["actionsDone", "actions_done"],
  ["actionsFailed", "actions_failed"],
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["costMicros", "cost_micros"],
  ["cacheReadTokens", "cache_read_tokens"],
  ["cacheWriteTokens", "cache_write_tokens"],
];

const BUMP_SQL = `
  INSERT INTO server_bot_stats_daily AS s
    (day, server_id, bot_user_id, ${COLUMNS.map(([, column]) => column).join(", ")})
  SELECT $1::date, b.server_id, b.user_id, ${COLUMNS.map((_, index) => `$${index + 3}`).join(", ")}
    FROM server_bots b WHERE b.id = $2
  ON CONFLICT (day, server_id, bot_user_id) DO UPDATE SET
    ${COLUMNS.map(([, column]) => `${column} = s.${column} + EXCLUDED.${column}`).join(",\n    ")}`;

/**
 * Add to a bot's day. A bot deleted meanwhile adds nothing, which loses at most
 * the last run of a bot that no longer exists. Never throws: a count is not
 * worth a reply.
 */
export async function bumpBotStats(
  botId: string,
  delta: BotStatsDelta,
  day: string = botDay(),
): Promise<void> {
  try {
    await getPool().query(BUMP_SQL, [
      day,
      botId,
      ...COLUMNS.map(([key]) => Math.round(delta[key] ?? 0)),
    ]);
  } catch (error) {
    logEvent("bots.statsError", { botId, message: errorText(error) });
  }
}

/** One more question from this member today, for the distinct-people count. */
export async function bumpBotPerson(
  botId: string,
  userId: string,
  day: string = botDay(),
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO server_bot_people_daily AS p (day, server_id, user_id, runs)
       SELECT $1::date, b.server_id, $3, 1 FROM server_bots b WHERE b.id = $2
       ON CONFLICT (day, server_id, user_id) DO UPDATE SET runs = p.runs + 1`,
      [day, botId, userId],
    );
  } catch (error) {
    logEvent("bots.statsError", { botId, message: errorText(error) });
  }
}

/** One step of a plan finished, by tool, for "what bots are used for". */
export async function bumpBotTool(
  botId: string,
  tool: string,
  ok: boolean,
  day: string = botDay(),
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO server_bot_tools_daily AS t (day, server_id, tool, done, failed)
       SELECT $1::date, b.server_id, $3, $4, $5 FROM server_bots b WHERE b.id = $2
       ON CONFLICT (day, server_id, tool) DO UPDATE
          SET done = t.done + EXCLUDED.done, failed = t.failed + EXCLUDED.failed`,
      [day, botId, tool, ok ? 1 : 0, ok ? 0 : 1],
    );
  } catch (error) {
    logEvent("bots.statsError", { botId, message: errorText(error) });
  }
}

/** Who asked a bot is kept only long enough to count people per day and month. */
export async function pruneBotPeopleDaily(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM server_bot_people_daily
      WHERE day < $1::date - make_interval(days => $2)`,
    [botDay(), BOT_PEOPLE_RETENTION_DAYS],
  );
  return result.rowCount ?? 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/**
 * Today's numbers and the latest things a bot did, for its settings page.
 * Actions come from the live tables (they cascade with the bot, which is fine:
 * the page is about this bot); the day's totals from the rollup.
 */
export async function readBotOverview(botId: string): Promise<{
  creatorName: string | null;
  actionsToday: number;
  confirmedToday: number;
  recent: ServerBotActivityItem[];
} | null> {
  const bot = await getPool().query<{ creator: string | null; server_id: string; user_id: string }>(
    `SELECT u.display_name AS creator, b.server_id, b.user_id
       FROM server_bots b LEFT JOIN users u ON u.id = b.created_by
      WHERE b.id = $1`,
    [botId],
  );
  const row = bot.rows[0];
  if (!row) return null;
  const today = await getPool().query<{ actions: number; confirmed: number }>(
    `SELECT COALESCE(SUM(actions_done + actions_failed), 0)::int AS actions,
            COALESCE(SUM(plans_confirmed), 0)::int AS confirmed
       FROM server_bot_stats_daily
      WHERE day = $1::date AND server_id = $2 AND bot_user_id = $3`,
    [botDay(), row.server_id, row.user_id],
  );
  const recent = await getPool().query<{
    kind: "action" | "cancelled";
    tool: string | null;
    label: string | null;
    status: string;
    requester: string | null;
    confirmed: boolean;
    at: Date;
  }>(
    `(SELECT 'action' AS kind, a.tool, p.actions -> a.step ->> 'label' AS label, a.status,
             u.display_name AS requester, p.message_id IS NOT NULL AND p.status <> 'executing' AS confirmed,
             a.created_at AS at
        FROM server_bot_actions a
        JOIN server_bot_plans p ON p.id = a.plan_id
        LEFT JOIN users u ON u.id = p.requester_id
       WHERE a.bot_id = $1
       ORDER BY a.created_at DESC LIMIT 8)
     UNION ALL
     (SELECT 'cancelled' AS kind, NULL AS tool, jsonb_array_length(p.actions)::text AS label, 'cancelled' AS status,
             u.display_name AS requester, FALSE AS confirmed, COALESCE(p.finished_at, p.created_at) AS at
        FROM server_bot_plans p
        LEFT JOIN users u ON u.id = p.requester_id
       WHERE p.bot_id = $1 AND p.status = 'cancelled'
       ORDER BY p.created_at DESC LIMIT 4)
     ORDER BY at DESC LIMIT 8`,
    [botId],
  );
  return {
    creatorName: row.creator,
    actionsToday: today.rows[0]?.actions ?? 0,
    confirmedToday: today.rows[0]?.confirmed ?? 0,
    recent: recent.rows.map((item) => ({
      kind: item.kind,
      tool: item.tool,
      label: item.label ?? "",
      status: (["running", "done", "failed", "cancelled"].includes(item.status) ? item.status : "done") as ServerBotActivityItem["status"],
      requesterName: item.requester,
      confirmed: item.confirmed,
      at: item.at.toISOString(),
    })),
  };
}
