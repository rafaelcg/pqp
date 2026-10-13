import { getPool } from "../db.js";
import { botDailyUsdCeiling } from "./bot-runner.js";
import { botDay, nextBotDayStart } from "./bot-stats.js";
import { botRepliesPerDay } from "./bots.js";
import { ACTIVITY_TIMEZONE } from "./user-activity.js";

/**
 * The operator's read of server bots: who has one, what they ask it, whether it
 * answers, and what it costs. The dashboard's "bots · beta" section.
 *
 * COUNTS AND MONEY ONLY. Nothing here is a persona, a knowledge block, a
 * message, a question or a person: no user id, no bot user id, no run id. Server
 * names are the one label, because the dashboard already names servers in its
 * "most active" tables. A tool is a code constant (`create_channel`), a trigger
 * is one of five words and a model is a name from `BOTS_MODEL_CHOICES`.
 *
 * WHERE EACH NUMBER COMES FROM, because they come from two kinds of table and
 * the difference decides what a deleted bot does to them:
 *
 *  - History is the FK-free rollups (`server_bot_stats_daily`,
 *    `_tools_daily`, `_people_daily`) and the deployment's spend and usage
 *    tables. A deleted bot or server keeps its past there.
 *  - "Right now" and the live samples (bots that exist, the trigger mix, cost
 *    by model) read `server_bots` and `server_bot_runs`, which cascade away
 *    with their bot. A bot deleted last week is in last week's usage and not in
 *    this week's trigger mix. The report says which is which.
 *
 * THE WINDOW is the 30 São Paulo days before today plus today, 31 days in all,
 * every one present (a day with nothing is a row of zeroes, not a gap). Every
 * "window" total below covers all 31. Distinct people and servers are counted
 * once over the window and never as a sum of daily distincts, which would count
 * a regular once per day.
 *
 * NOT HERE: the notices a member sees when a limit stops an answer. They are
 * sent to that member's sockets and stored nowhere, so there is no number to
 * show and none is invented. `limits` is what the limit tables hold: replies
 * the per-server cap refused, calls the dollar ceiling refused.
 */

export const ADMIN_BOTS_PATH = "/api/admin/bots";

/** Days before today in the window. Today is the 31st. */
export const BOT_ADMIN_WINDOW_DAYS = 30;
/** The live-table samples (trigger mix, cost by model) look back this far, today included. */
export const BOT_ADMIN_LIVE_DAYS = 7;
const TOOLS_LIMIT = 12;
const TOP_SERVERS_LIMIT = 10;

const REPORT_TTL_MS = 30_000;
const FAILURE_TTL_MS = 30_000;

export interface BotAdminUsageDay {
  day: string;
  runs: number;
  replies: number;
  skipped: number;
  failed: number;
  asks: number;
  plans: number;
  plansConfirmed: number;
  plansCancelled: number;
  actionsDone: number;
  actionsFailed: number;
  /** Distinct people who asked a bot that day, across servers. */
  people: number;
  /** Servers whose bot ran at least once that day. */
  servers: number;
}

export interface BotAdminFunnel {
  /** Runs: a mention, a reply, a name, a follow-up or a "sim". */
  called: number;
  /** Runs that posted an answer. */
  answered: number;
  /** Plans a bot staged. Not a subset of answers. */
  staged: number;
  /** Plans a member confirmed with "sim" or the button. Small plans run unasked and are not counted. */
  confirmed: number;
  /** Steps that ran and worked. A plan has several. */
  actionsDone: number;
}

export interface BotsAdminReport {
  generatedAt: string;
  timezone: string;
  /** First and last day of the window, São Paulo days. */
  from: string;
  to: string;
  /** First day any bot history exists, or null before the first run. */
  trackingSince: string | null;
  adoption: {
    /** Bots that exist now. */
    bots: number;
    servers: number;
    enabled: number;
    /** Bots that ran in the window and no longer exist. A bot deleted before its first run leaves nothing to count. */
    deletedInWindow: number;
    /** Bots that exist now, by the day they were made. Deleted ones are gone. */
    days: { day: string; created: number }[];
    createdInWindow: number;
  };
  usage: {
    days: BotAdminUsageDay[];
    distinct: {
      peopleToday: number;
      peopleWindow: number;
      serversToday: number;
      serversWindow: number;
    };
  };
  funnel: { today: BotAdminFunnel; window: BotAdminFunnel };
  uses: {
    /** Plan steps by tool over the window, most used first. */
    tools: { tool: string; done: number; failed: number }[];
    /** Runs by what started them, last seven days, from the live table. A NULL trigger is "unknown". */
    triggers7d: { trigger: string; runs: number; failed: number }[];
  };
  cost: {
    ceilingUsd: number;
    /** Model spend per São Paulo day, whole deployment, settled to real usage once a call returns. */
    days: { day: string; usd: number; calls: number; refused: number }[];
    todayUsd: number;
    todayShareOfCeiling: number | null;
    windowUsd: number;
    /** Dollars per 1,000 answers. Every model call counts, answered or not. Null with no answers. */
    perThousandRepliesToday: number | null;
    perThousandRepliesWindow: number | null;
    nextResetAt: string;
    /** Last seven days, from the live table. A NULL model is a run that never reached one. */
    byModel7d: {
      model: string | null;
      runs: number;
      usd: number;
      inputTokens: number;
      outputTokens: number;
    }[];
    /** Window, from the rollup. A null name is a server that no longer exists. */
    topServers: {
      name: string | null;
      usd: number;
      runs: number;
      replies: number;
      failed: number;
    }[];
  };
  limits: {
    repliesPerServerDay: number;
    days: { day: string; refusedReplies: number; serversRefused: number; refusedCalls: number }[];
    refusedRepliesToday: number;
    serversRefusedToday: number;
    refusedCallsToday: number;
    refusedRepliesWindow: number;
    refusedCallsWindow: number;
  };
}

/** `YYYY-MM-DD` plus a number of days, by calendar arithmetic with no zone in it. */
export function addBotDays(day: string, n: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addBotDays(day, 1)) {
    out.push(day);
  }
  return out;
}

function usd(micros: number): number {
  return Math.round(micros) / 1_000_000;
}

function sumFunnel(days: BotAdminUsageDay[]): BotAdminFunnel {
  const total: BotAdminFunnel = { called: 0, answered: 0, staged: 0, confirmed: 0, actionsDone: 0 };
  for (const d of days) {
    total.called += d.runs;
    total.answered += d.replies;
    total.staged += d.plans;
    total.confirmed += d.plansConfirmed;
    total.actionsDone += d.actionsDone;
  }
  return total;
}

function perThousand(dollars: number, replies: number): number | null {
  return replies > 0 ? Math.round((dollars / replies) * 1000 * 10_000) / 10_000 : null;
}

interface StatsRow {
  day: string;
  runs: number;
  replies: number;
  skipped: number;
  failed: number;
  asks: number;
  plans: number;
  plans_confirmed: number;
  plans_cancelled: number;
  actions_done: number;
  actions_failed: number;
  servers: number;
}

export async function computeBotsAdminReport(now: number = Date.now()): Promise<BotsAdminReport> {
  const pool = getPool();
  const to = botDay(now);
  const from = addBotDays(to, -BOT_ADMIN_WINDOW_DAYS);
  const liveFrom = addBotDays(to, -(BOT_ADMIN_LIVE_DAYS - 1));
  const days = dayRange(from, to);
  const cap = botRepliesPerDay();
  const ceilingUsd = botDailyUsdCeiling();

  // One query after another, not a burst on the pool: this is read by a person
  // and cached, and the tables are small.
  const adoptionRow = (
    await pool.query<{ bots: number; servers: number; enabled: number }>(
      `SELECT COUNT(*)::int AS bots, COUNT(DISTINCT server_id)::int AS servers,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled
         FROM server_bots`,
    )
  ).rows[0] ?? { bots: 0, servers: 0, enabled: 0 };

  const created = await pool.query<{ day: string; n: number }>(
    `SELECT ((created_at AT TIME ZONE $2)::date)::text AS day, COUNT(*)::int AS n
       FROM server_bots
      WHERE created_at >= ($1::date)::timestamp AT TIME ZONE $2
      GROUP BY 1`,
    [from, ACTIVITY_TIMEZONE],
  );

  const deleted = (
    await pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT s.bot_user_id)::int AS n
         FROM server_bot_stats_daily s
        WHERE s.day >= $1::date
          AND NOT EXISTS (SELECT 1 FROM server_bots b WHERE b.user_id = s.bot_user_id)`,
      [from],
    )
  ).rows[0]?.n ?? 0;

  const since = (
    await pool.query<{ day: string | null }>(
      `SELECT (MIN(day))::text AS day FROM server_bot_stats_daily`,
    )
  ).rows[0]?.day ?? null;

  const stats = await pool.query<StatsRow>(
    `SELECT day::text AS day,
            SUM(runs)::int AS runs, SUM(replies)::int AS replies, SUM(skipped)::int AS skipped,
            SUM(failed)::int AS failed, SUM(asks)::int AS asks, SUM(plans)::int AS plans,
            SUM(plans_confirmed)::int AS plans_confirmed, SUM(plans_cancelled)::int AS plans_cancelled,
            SUM(actions_done)::int AS actions_done, SUM(actions_failed)::int AS actions_failed,
            COUNT(DISTINCT server_id) FILTER (WHERE runs > 0)::int AS servers
       FROM server_bot_stats_daily
      WHERE day >= $1::date
      GROUP BY day`,
    [from],
  );

  const people = await pool.query<{ day: string; n: number }>(
    `SELECT day::text AS day, COUNT(DISTINCT user_id)::int AS n
       FROM server_bot_people_daily WHERE day >= $1::date GROUP BY day`,
    [from],
  );

  const distinct = (
    await pool.query<{ people: number; servers: number }>(
      `SELECT (SELECT COUNT(DISTINCT user_id)::int FROM server_bot_people_daily WHERE day >= $1::date) AS people,
              (SELECT COUNT(DISTINCT server_id)::int FROM server_bot_stats_daily WHERE day >= $1::date AND runs > 0) AS servers`,
      [from],
    )
  ).rows[0] ?? { people: 0, servers: 0 };

  const tools = await pool.query<{ tool: string; done: number; failed: number }>(
    `SELECT tool, SUM(done)::int AS done, SUM(failed)::int AS failed
       FROM server_bot_tools_daily
      WHERE day >= $1::date
      GROUP BY tool
      ORDER BY SUM(done + failed) DESC, tool
      LIMIT ${TOOLS_LIMIT}`,
    [from],
  );

  const triggers = await pool.query<{ trigger: string | null; runs: number; failed: number }>(
    `SELECT trigger, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM server_bot_runs
      WHERE created_at >= ($1::date)::timestamp AT TIME ZONE $2
      GROUP BY trigger
      ORDER BY COUNT(*) DESC, trigger`,
    [liveFrom, ACTIVITY_TIMEZONE],
  );

  const spend = await pool.query<{ day: string; micros: number; calls: number; refused: number }>(
    `SELECT day::text AS day, reserved_micros::float8 AS micros, calls, refused
       FROM server_bot_spend_daily WHERE day >= $1::date`,
    [from],
  );

  const models = await pool.query<{
    model: string | null;
    runs: number;
    micros: number;
    input_tokens: number;
    output_tokens: number;
  }>(
    `SELECT model, COUNT(*)::int AS runs, COALESCE(SUM(cost_micros), 0)::float8 AS micros,
            COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
       FROM server_bot_runs
      WHERE created_at >= ($1::date)::timestamp AT TIME ZONE $2
      GROUP BY model
      ORDER BY COALESCE(SUM(cost_micros), 0) DESC, COUNT(*) DESC, model`,
    [liveFrom, ACTIVITY_TIMEZONE],
  );

  const topServers = await pool.query<{
    name: string | null;
    micros: number;
    runs: number;
    replies: number;
    failed: number;
  }>(
    `SELECT sv.name, SUM(s.cost_micros)::float8 AS micros, SUM(s.runs)::int AS runs,
            SUM(s.replies)::int AS replies, SUM(s.failed)::int AS failed
       FROM server_bot_stats_daily s
       LEFT JOIN servers sv ON sv.id = s.server_id
      WHERE s.day >= $1::date
      GROUP BY s.server_id, sv.name
      ORDER BY SUM(s.cost_micros) DESC, SUM(s.runs) DESC
      LIMIT ${TOP_SERVERS_LIMIT}`,
    [from],
  );

  const usage = await pool.query<{ day: string; refused: number; servers: number }>(
    `SELECT day::text AS day, SUM(refused)::int AS refused,
            COUNT(*) FILTER (WHERE refused > 0)::int AS servers
       FROM server_bot_usage_daily WHERE day >= $1::date GROUP BY day`,
    [from],
  );

  const createdByDay = new Map(created.rows.map((row) => [row.day, row.n]));
  const statsByDay = new Map(stats.rows.map((row) => [row.day, row]));
  const peopleByDay = new Map(people.rows.map((row) => [row.day, row.n]));
  const spendByDay = new Map(spend.rows.map((row) => [row.day, row]));
  const usageByDay = new Map(usage.rows.map((row) => [row.day, row]));

  const usageDays: BotAdminUsageDay[] = days.map((day) => {
    const row = statsByDay.get(day);
    return {
      day,
      runs: row?.runs ?? 0,
      replies: row?.replies ?? 0,
      skipped: row?.skipped ?? 0,
      failed: row?.failed ?? 0,
      asks: row?.asks ?? 0,
      plans: row?.plans ?? 0,
      plansConfirmed: row?.plans_confirmed ?? 0,
      plansCancelled: row?.plans_cancelled ?? 0,
      actionsDone: row?.actions_done ?? 0,
      actionsFailed: row?.actions_failed ?? 0,
      people: peopleByDay.get(day) ?? 0,
      servers: row?.servers ?? 0,
    };
  });

  const costDays = days.map((day) => {
    const row = spendByDay.get(day);
    return { day, usd: usd(row?.micros ?? 0), calls: row?.calls ?? 0, refused: row?.refused ?? 0 };
  });
  const limitDays = days.map((day) => ({
    day,
    refusedReplies: usageByDay.get(day)?.refused ?? 0,
    serversRefused: usageByDay.get(day)?.servers ?? 0,
    refusedCalls: spendByDay.get(day)?.refused ?? 0,
  }));

  const todayUsage = usageDays[usageDays.length - 1]!;
  const todayCost = costDays[costDays.length - 1]!;
  const todayLimits = limitDays[limitDays.length - 1]!;
  const windowUsd = costDays.reduce((total, d) => total + d.usd, 0);
  const windowReplies = usageDays.reduce((total, d) => total + d.replies, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: ACTIVITY_TIMEZONE,
    from,
    to,
    trackingSince: since,
    adoption: {
      bots: adoptionRow.bots,
      servers: adoptionRow.servers,
      enabled: adoptionRow.enabled,
      deletedInWindow: deleted,
      days: days.map((day) => ({ day, created: createdByDay.get(day) ?? 0 })),
      createdInWindow: created.rows.reduce((total, row) => total + row.n, 0),
    },
    usage: {
      days: usageDays,
      distinct: {
        peopleToday: todayUsage.people,
        peopleWindow: distinct.people,
        serversToday: todayUsage.servers,
        serversWindow: distinct.servers,
      },
    },
    funnel: { today: sumFunnel([todayUsage]), window: sumFunnel(usageDays) },
    uses: {
      tools: tools.rows,
      triggers7d: triggers.rows.map((row) => ({
        trigger: row.trigger ?? "unknown",
        runs: row.runs,
        failed: row.failed,
      })),
    },
    cost: {
      ceilingUsd,
      days: costDays,
      todayUsd: todayCost.usd,
      todayShareOfCeiling: ceilingUsd > 0 ? Math.round((todayCost.usd / ceilingUsd) * 10_000) / 10_000 : null,
      windowUsd: Math.round(windowUsd * 1_000_000) / 1_000_000,
      perThousandRepliesToday: perThousand(todayCost.usd, todayUsage.replies),
      perThousandRepliesWindow: perThousand(windowUsd, windowReplies),
      nextResetAt: nextBotDayStart(now).toISOString(),
      byModel7d: models.rows.map((row) => ({
        model: row.model,
        runs: row.runs,
        usd: usd(row.micros),
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      topServers: topServers.rows.map((row) => ({
        name: row.name,
        usd: usd(row.micros),
        runs: row.runs,
        replies: row.replies,
        failed: row.failed,
      })),
    },
    limits: {
      repliesPerServerDay: cap,
      days: limitDays,
      refusedRepliesToday: todayLimits.refusedReplies,
      serversRefusedToday: todayLimits.serversRefused,
      refusedCallsToday: todayLimits.refusedCalls,
      refusedRepliesWindow: limitDays.reduce((total, d) => total + d.refusedReplies, 0),
      refusedCallsWindow: limitDays.reduce((total, d) => total + d.refusedCalls, 0),
    },
  };
}

let cached: { at: number; ttl: number; report: Promise<BotsAdminReport> } | null = null;

/**
 * The report, cached for thirty seconds with the read in flight shared. A
 * dashboard polls, and two API processes each answer their own poll; a failed
 * read is remembered as long, so a struggling database is not asked again on
 * every poll.
 */
export function botsAdminReport(): Promise<BotsAdminReport> {
  const at = Date.now();
  if (cached && at - cached.at < cached.ttl) {
    return cached.report;
  }
  const report = computeBotsAdminReport(at);
  const entry = { at, ttl: REPORT_TTL_MS, report };
  cached = entry;
  report.catch(() => {
    entry.at = Date.now();
    entry.ttl = FAILURE_TTL_MS;
  });
  return report;
}

export function resetBotsAdminReportCache(): void {
  cached = null;
}
