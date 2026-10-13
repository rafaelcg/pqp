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
