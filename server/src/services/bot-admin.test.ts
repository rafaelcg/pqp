import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The operator's read of server bots, against a real database.
 *
 * What each case guards, because each is a way this could ship looking right:
 *
 *  1. **Every day is present.** A day with no runs is a row of zeroes, so the
 *     chart on the dashboard has no gap that reads as "no data".
 *  2. **Distinct is distinct.** The same person on two days is one person in
 *     the window, not two.
 *  3. **History survives a delete.** A bot that no longer exists still shows in
 *     the days it ran, and is counted as deleted. A server that no longer
 *     exists is a null name, not a missing row.
 *  4. **Counts and money only.** No person id, no bot id, no run id and none of
 *     the bot's own words reach the payload.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { createServerBot } = await import("./bots.js");
const { botDay } = await import("./bot-stats.js");
const { addBotDays, computeBotsAdminReport, botsAdminReport, resetBotsAdminReportCache } =
  await import("./bot-admin.js");

describe("addBotDays", () => {
  it("is calendar arithmetic across months and years", () => {
    expect(addBotDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addBotDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addBotDays("2026-10-13", -30)).toBe("2026-09-13");
  });
});

describeDb("the bots report", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    for (const key of ["BOTS_MAX_USD_PER_DAY", "BOTS_REPLIES_PER_SERVER_DAY"]) {
      saved[key] = process.env[key];
    }
    process.env.BOTS_MAX_USD_PER_DAY = "2";
    delete process.env.BOTS_REPLIES_PER_SERVER_DAY;
    resetBotsAdminReportCache();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, channel_members,
                server_bots, server_bot_runs, server_bot_usage_daily, server_bot_spend_daily,
                server_bot_stats_daily, server_bot_people_daily, server_bot_tools_daily
       RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function makeBot(owner: { id: string }, name: string) {
    const { server, channels } = await createPqpServer(`Hall ${name}`, owner.id);
    const channelId = channels.find((c) => c.type === "text")!.id;
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name,
      persona: "SEGREDO-DA-PERSONA",
      knowledge: "SEGREDO-DO-CONHECIMENTO",
      channelIds: [channelId],
    });
    return { server, channelId, bot };
  }

  async function stats(
    day: string,
    serverId: string,
    botUserId: string,
    values: Record<string, number>,
  ) {
    const columns = Object.keys(values);
    await getPool().query(
      `INSERT INTO server_bot_stats_daily (day, server_id, bot_user_id, ${columns.join(", ")})
       VALUES ($1::date, $2, $3, ${columns.map((_, i) => `$${i + 4}`).join(", ")})`,
      [day, serverId, botUserId, ...columns.map((c) => values[c])],
    );
  }

  it("is a quiet, complete window before anything has run", async () => {
    const report = await computeBotsAdminReport();
    expect(report.usage.days).toHaveLength(31);
    expect(report.usage.days[30]!.day).toBe(botDay());
    expect(report.usage.days.every((d) => d.runs === 0 && d.people === 0)).toBe(true);
    expect(report.trackingSince).toBeNull();
    expect(report.adoption).toMatchObject({ bots: 0, servers: 0, enabled: 0, deletedInWindow: 0 });
    expect(report.cost.todayShareOfCeiling).toBe(0);
    expect(report.cost.perThousandRepliesWindow).toBeNull();
    expect(report.cost.ceilingUsd).toBe(2);
    expect(report.limits.repliesPerServerDay).toBe(200);
    expect(new Date(report.cost.nextResetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("counts adoption, usage, people, the funnel, tools and cost", async () => {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa", avatarUrl: null });
    const a = await makeBot(owner, "Alfa");
    const b = await makeBot(owner, "Beta");
    await getPool().query(`UPDATE server_bots SET enabled = FALSE WHERE id = $1`, [b.bot.id]);

    const today = botDay();
    const yesterday = addBotDays(today, -1);
    const old = addBotDays(today, -40);
    await stats(today, a.server.id, a.bot.userId, {
      runs: 10, replies: 8, skipped: 1, failed: 1, asks: 1, plans: 3, plans_confirmed: 2,
      plans_cancelled: 1, actions_done: 5, actions_failed: 1, cost_micros: 400_000,
    });
    await stats(today, b.server.id, b.bot.userId, { runs: 4, replies: 4, cost_micros: 100_000 });
    await stats(yesterday, a.server.id, a.bot.userId, {
      runs: 6, replies: 5, failed: 1, plans: 1, plans_confirmed: 1, actions_done: 2, cost_micros: 250_000,
    });
    // Outside the window: never counted anywhere.
    await stats(old, a.server.id, a.bot.userId, { runs: 99, replies: 99, cost_micros: 9_000_000 });

    // Ana asked on two days and Bruno on one: three asks, two people.
    const ana = await upsertUser({ clerkId: "ana", displayName: "Ana", avatarUrl: null });
    const bruno = await upsertUser({ clerkId: "bruno", displayName: "Bruno", avatarUrl: null });
    for (const [day, serverId, userId] of [
      [today, a.server.id, ana.id],
      [yesterday, a.server.id, ana.id],
      [today, a.server.id, bruno.id],
      [today, b.server.id, ana.id],
    ] as const) {
      await getPool().query(
        `INSERT INTO server_bot_people_daily (day, server_id, user_id, runs) VALUES ($1::date, $2, $3, 1)`,
        [day, serverId, userId],
      );
    }

    await getPool().query(
      `INSERT INTO server_bot_tools_daily (day, server_id, tool, done, failed) VALUES
         ($1::date, $2, 'create_channel', 3, 1), ($3::date, $2, 'create_channel', 1, 0),
         ($1::date, $2, 'pin_message', 2, 0)`,
      [today, a.server.id, yesterday],
    );
    await getPool().query(
      `INSERT INTO server_bot_spend_daily (day, reserved_micros, calls, refused) VALUES
         ($1::date, 1500000, 20, 3), ($2::date, 250000, 6, 0)`,
      [today, yesterday],
    );
    await getPool().query(
      `INSERT INTO server_bot_usage_daily (day, server_id, replies, refused) VALUES
         ($1::date, $2, 200, 7), ($1::date, $3, 4, 0)`,
      [today, a.server.id, b.server.id],
    );

    // Live runs: two mentions, one with no trigger, one old enough to be left out.
    const runs: [string | null, string | null, number, string][] = [
      ["mention", "anthropic:claude-haiku-5-5", 300_000, "done"],
      ["mention", "anthropic:claude-haiku-5-5", 100_000, "failed"],
      [null, null, 0, "skipped"],
    ];
    for (const [trigger, model, cost, status] of runs) {
      await getPool().query(
        `INSERT INTO server_bot_runs (bot_id, channel_id, requester_id, status, trigger, model, cost_micros)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [a.bot.id, a.channelId, ana.id, status, trigger, model, cost],
      );
    }
    await getPool().query(
      `INSERT INTO server_bot_runs (bot_id, channel_id, requester_id, status, trigger, model, cost_micros, created_at)
       VALUES ($1, $2, $3, 'done', 'reply', 'anthropic:old', 5000000, NOW() - interval '10 days')`,
      [a.bot.id, a.channelId, ana.id],
    );

    const report = await computeBotsAdminReport();

    expect(report.adoption).toMatchObject({ bots: 2, servers: 2, enabled: 1, deletedInWindow: 0, createdInWindow: 2 });
    expect(report.adoption.days).toHaveLength(31);
    expect(report.adoption.days[30]).toEqual({ day: today, created: 2 });
    expect(report.trackingSince).toBe(old);

    const t = report.usage.days[30]!;
    expect(t).toMatchObject({
      day: today, runs: 14, replies: 12, skipped: 1, failed: 1, asks: 1, plans: 3,
      plansConfirmed: 2, plansCancelled: 1, actionsDone: 5, actionsFailed: 1, people: 2, servers: 2,
    });
    expect(report.usage.days[29]).toMatchObject({ day: yesterday, runs: 6, people: 1, servers: 1 });
    expect(report.usage.days[0]!.runs).toBe(0);
    // Ana is on two days and in two servers: still one person.
    expect(report.usage.distinct).toEqual({
      peopleToday: 2,
      peopleWindow: 2,
      serversToday: 2,
      serversWindow: 2,
    });

    expect(report.funnel.today).toEqual({ called: 14, answered: 12, staged: 3, confirmed: 2, actionsDone: 5 });
    expect(report.funnel.window).toEqual({ called: 20, answered: 17, staged: 4, confirmed: 3, actionsDone: 7 });

    expect(report.uses.tools).toEqual([
      { tool: "create_channel", done: 4, failed: 1 },
      { tool: "pin_message", done: 2, failed: 0 },
    ]);
    expect(report.uses.triggers7d).toEqual([
      { trigger: "mention", runs: 2, failed: 1 },
      { trigger: "unknown", runs: 1, failed: 0 },
    ]);

    expect(report.cost.todayUsd).toBe(1.5);
    expect(report.cost.todayShareOfCeiling).toBe(0.75);
    expect(report.cost.windowUsd).toBe(1.75);
    expect(report.cost.perThousandRepliesToday).toBe(125);
    expect(report.cost.perThousandRepliesWindow).toBe(102.9412);
    expect(report.cost.days[30]).toEqual({ day: today, usd: 1.5, calls: 20, refused: 3 });
    expect(report.cost.byModel7d).toEqual([
      {
        model: "anthropic:claude-haiku-5-5",
        runs: 2,
        usd: 0.4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      { model: null, runs: 1, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(report.cost.topServers.map((s) => [s.name, s.usd])).toEqual([
      ["Hall Alfa", 0.65],
      ["Hall Beta", 0.1],
    ]);

    expect(report.limits).toMatchObject({
      repliesPerServerDay: 200,
      refusedRepliesToday: 7,
      serversRefusedToday: 1,
      refusedCallsToday: 3,
      refusedRepliesWindow: 7,
      refusedCallsWindow: 3,
    });
  });

  it("keeps the past of a bot and a server that are gone", async () => {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa", avatarUrl: null });
    const a = await makeBot(owner, "Alfa");
    const gone = await makeBot(owner, "Sumiu");
    const today = botDay();
    await stats(today, a.server.id, a.bot.userId, { runs: 1, replies: 1, cost_micros: 1_000 });
    await stats(today, gone.server.id, gone.bot.userId, { runs: 5, replies: 5, cost_micros: 90_000 });

    await getPool().query(`DELETE FROM servers WHERE id = $1`, [gone.server.id]);
    const report = await computeBotsAdminReport();

    expect(report.adoption).toMatchObject({ bots: 1, servers: 1, deletedInWindow: 1 });
    expect(report.usage.days[30]!.runs).toBe(6);
    expect(report.cost.topServers[0]).toMatchObject({ name: null, usd: 0.09, runs: 5 });
    expect(report.cost.topServers[1]).toMatchObject({ name: "Hall Alfa" });
  });

  it("carries counts and money, never a person, a bot or what the bot was told", async () => {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa Dono", avatarUrl: null });
    const ana = await upsertUser({ clerkId: "ana", displayName: "Ana Secreta", avatarUrl: null });
    const a = await makeBot(owner, "Alfa");
    await stats(botDay(), a.server.id, a.bot.userId, { runs: 2, replies: 2 });
    await getPool().query(
      `INSERT INTO server_bot_people_daily (day, server_id, user_id, runs) VALUES ($1::date, $2, $3, 1)`,
      [botDay(), a.server.id, ana.id],
    );
    await getPool().query(
      `INSERT INTO server_bot_runs (bot_id, channel_id, requester_id, status, trigger, model)
       VALUES ($1, $2, $3, 'done', 'mention', 'anthropic:claude-haiku-5-5')`,
      [a.bot.id, a.channelId, ana.id],
    );

    const text = JSON.stringify(await computeBotsAdminReport());
    for (const secret of [
      ana.id,
      owner.id,
      a.bot.userId,
      a.bot.id,
      a.server.id,
      a.channelId,
      "SEGREDO-DA-PERSONA",
      "SEGREDO-DO-CONHECIMENTO",
      "Ana Secreta",
      "Rafa Dono",
    ]) {
      expect(text).not.toContain(secret);
    }
    // The one label that is allowed.
    expect(text).toContain("Hall Alfa");
  });

  it("serves one read to callers inside the cache window", async () => {
    const first = botsAdminReport();
    const second = botsAdminReport();
    expect(second).toBe(first);
    await first;
    resetBotsAdminReportCache();
    expect(botsAdminReport()).not.toBe(first);
  });
});
