import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Reminders a server bot keeps: set through its tools, delivered by a job with
 * no model call. Real Postgres.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer, createChannel } = await import("./servers.js");
const { assignRole, createRole } = await import("./roles.js");
const { Permission, SERVER_BOT_TOOLS } = await import("@pqp/shared");
const { createServerBot, resetBotTriggerCacheForTests } = await import("./bots.js");
const { ActionSession, handleToolCall } = await import("./bot-actions.js");
const { resetChatRateLimits } = await import("../ws/chat.js");
const { deliverDueReminders, nextOccurrence, REMINDERS_PER_MEMBER } = await import("./bot-reminders.js");
const { saoPauloInstant } = await import("./bot-stats.js");

describe("São Paulo times", () => {
  it("reads a wall clock in São Paulo as an instant, and refuses what is not a time", () => {
    expect(saoPauloInstant("2026-10-15T20:00")?.toISOString()).toBe("2026-10-15T23:00:00.000Z");
    expect(saoPauloInstant("2026-02-30T20:00")).toBeNull();
    expect(saoPauloInstant("amanhã às 20h")).toBeNull();
    expect(saoPauloInstant("2026-10-15T24:00")).toBeNull();
  });

  it("puts a repeating reminder on its next slot, without the ones it missed", () => {
    const due = new Date("2026-10-10T22:00:00Z");
    expect(nextOccurrence(due, "weekly", Date.parse("2026-10-10T22:00:30Z")).toISOString()).toBe("2026-10-17T22:00:00.000Z");
    // Down for three weeks: one post on the next slot, not three.
    expect(nextOccurrence(due, "weekly", Date.parse("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-07T22:00:00.000Z");
    expect(nextOccurrence(due, "daily", Date.parse("2026-10-11T21:00:00Z")).toISOString()).toBe("2026-10-11T22:00:00.000Z");
  });
});

describeDb("server bot reminders", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  let savedFlag: string | undefined;
  beforeEach(async () => {
    savedFlag = process.env.CUSTOM_BOTS;
    process.env.CUSTOM_BOTS = "true";
    resetBotTriggerCacheForTests();
    resetChatRateLimits();
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, server_bots, server_bot_reminders,
                server_bot_plans, server_bot_actions, audit_log
       RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CUSTOM_BOTS;
    else process.env.CUSTOM_BOTS = savedFlag;
  });

  async function setup() {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa", avatarUrl: null });
    const member = await upsertUser({ clerkId: "member", displayName: "Bia", avatarUrl: null });
    const { server, channels } = await createPqpServer("QG", owner.id);
    await getPool().query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [
      server.id,
      member.id,
    ]);
    const channelId = channels.find((c) => c.type === "text")!.id;
    const other = await createChannel(server.id, "avisos", "text");
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name: "Caio",
      persona: "",
      knowledge: "",
      channelIds: [channelId],
      tools: [...SERVER_BOT_TOOLS],
    });
    const staff = await createRole(server.id, { name: "bot_staff", permissions: Permission.MANAGE_MESSAGES });
    await assignRole(server.id, bot.userId, staff.id);
    const botUser = (await getPool().query(`SELECT * FROM users WHERE id = $1`, [bot.userId])).rows[0];
    const tool = async (requesterId: string, name: string, input: Record<string, unknown>) => {
      const session = new ActionSession({
        serverId: server.id,
        channelId,
        botId: bot.id,
        bot: botUser,
        requesterId,
        requesterTag: "@x",
        enabledTools: new Set<string>(SERVER_BOT_TOOLS),
      });
      const result = await handleToolCall(session, name, input);
      // A write is staged; run it the way a request of three or fewer does.
      if (!result.isError && session.staged.length > 0) {
        const { executePlan, savePlan } = await import("./bot-actions.js");
        const plan = await savePlan(session.ctx, crypto.randomUUID(), session.staged, "executing");
        return { ...result, run: await executePlan(plan!, session.ctx) };
      }
      return result;
    };
    return { owner, member, server, channelId, otherId: other.id, bot, tool };
  }

  /** A São Paulo wall clock `minutes` from now, as the model would write it. */
  const inMinutes = (minutes: number) => {
    const local = new Date(Date.now() + minutes * 60_000 - 3 * 3_600_000);
    return local.toISOString().slice(0, 16);
  };

  const posts = async (channelId: string, botUserId: string) =>
    (
      await getPool().query<{ body: string }>(
        `SELECT body FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at`,
        [channelId, botUserId],
      )
    ).rows.map((row) => row.body);

  const makeDue = (id?: string) =>
    getPool().query(
      `UPDATE server_bot_reminders SET due_at = NOW() - INTERVAL '1 second' WHERE status = 'pending'${id ? " AND id = $1" : ""}`,
      id ? [id] : [],
    );

  it("reminds a member when it is due, once, mentioning them", async () => {
    const { member, channelId, bot, tool } = await setup();
    const set = await tool(member.id, "create_reminder", { at: inMinutes(60), text: "jogar CS @everyone" });
    expect(set.isError).toBeFalsy();
    const listed = JSON.parse((await tool(member.id, "list_reminders", {})).content);
    expect(listed.count).toBe(1);

    await deliverDueReminders();
    expect(await posts(channelId, bot.userId)).toEqual([]);
    await makeDue();
    expect(await deliverDueReminders()).toBe(1);
    expect(await deliverDueReminders()).toBe(0);
    const [body] = await posts(channelId, bot.userId);
    expect(body).toMatch(/^⏰ @\S+, lembrete: jogar CS ＠everyone$/);
  });

  it("does not post twice when a claim ran out after posting", async () => {
    const { member, channelId, bot, tool } = await setup();
    await tool(member.id, "create_reminder", { at: inMinutes(30), text: "água" });
    await makeDue();
    await deliverDueReminders();
    // As if the process died after the post and before the row moved on.
    await getPool().query(`UPDATE server_bot_reminders SET status = 'pending', lease_until = NULL, due_at = NOW() - INTERVAL '1 second'`);
    await deliverDueReminders();
    expect(await posts(channelId, bot.userId)).toHaveLength(1);
  });

  it("keeps repeating and announcements for staff, and repeats on schedule", async () => {
    const { owner, member, otherId, bot, tool } = await setup();
    const refused = await tool(member.id, "create_reminder", { at: inMinutes(60), text: "jogatina", repeat: "weekly" });
    expect(refused.isError).toBe(true);
    expect((await tool(member.id, "create_reminder", { at: inMinutes(60), text: "x", channelId: otherId })).isError).toBe(true);

    const set = await tool(owner.id, "create_reminder", {
      at: inMinutes(60),
      text: "Jogatina hoje às 21h",
      repeat: "weekly",
      channelId: otherId,
    });
    expect(set.isError).toBeFalsy();
    const before = (await getPool().query<{ due_at: Date }>(`SELECT due_at FROM server_bot_reminders`)).rows[0]!.due_at;
    await makeDue();
    await deliverDueReminders();
    expect(await posts(otherId, bot.userId)).toEqual(["⏰ Jogatina hoje às 21h"]);
    const after = await getPool().query<{ status: string; due_at: Date; sent_count: number }>(
      `SELECT status, due_at, sent_count FROM server_bot_reminders`,
    );
    expect(after.rows[0]).toMatchObject({ status: "pending", sent_count: 1 });
    // A week after the time it was set for, not after "now".
    expect(after.rows[0]!.due_at.getTime() - before.getTime()).toBeGreaterThan(6 * 86_400_000);
  });

  it("drops a reminder whose member left, and refuses times in the past and too many", async () => {
    const { server, member, channelId, bot, tool } = await setup();
    expect((await tool(member.id, "create_reminder", { at: inMinutes(-5), text: "ontem" })).isError).toBe(true);
    expect((await tool(member.id, "create_reminder", { at: "amanhã", text: "x" })).isError).toBe(true);

    for (let i = 0; i < REMINDERS_PER_MEMBER; i += 1) {
      await tool(member.id, "create_reminder", { at: inMinutes(60 + i), text: `r${i}` });
    }
    const over = await tool(member.id, "create_reminder", { at: inMinutes(90), text: "mais um" });
    expect((over as { run?: { items: Array<{ status: string }> } }).run?.items[0]?.status).toBe("failed");

    await getPool().query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [server.id, member.id]);
    await makeDue();
    await deliverDueReminders();
    expect(await posts(channelId, bot.userId)).toEqual([]);
    const left = await getPool().query(`SELECT 1 FROM server_bot_reminders WHERE status = 'pending'`);
    expect(left.rowCount).toBe(0);
  });

  it("lets a member cancel their own, and not somebody else's", async () => {
    const { owner, member, tool } = await setup();
    await tool(member.id, "create_reminder", { at: inMinutes(60), text: "meu" });
    const id = JSON.parse((await tool(member.id, "list_reminders", {})).content).reminders[0].id;
    expect((await tool(owner.id, "cancel_reminder", { reminderId: id })).isError).toBe(true);
    expect((await tool(member.id, "cancel_reminder", { reminderId: id })).isError).toBeFalsy();
    expect(JSON.parse((await tool(member.id, "list_reminders", {})).content).count).toBe(0);
  });

  it("waits while the flag is off for its server, and goes out once it is back", async () => {
    const { owner, member, server, otherId, channelId, bot, tool } = await setup();
    await tool(member.id, "create_reminder", { at: inMinutes(30), text: "água" });
    await tool(owner.id, "create_reminder", { at: inMinutes(60), text: "Jogatina", repeat: "weekly", channelId: otherId });
    const weekly = `SELECT due_at, status, sent_count FROM server_bot_reminders WHERE repeat IS NOT NULL`;
    const before = (await getPool().query<{ due_at: Date }>(weekly)).rows[0]!.due_at;
    await makeDue();

    // Off everywhere: the job does not even look.
    process.env.CUSTOM_BOTS = "false";
    expect(await deliverDueReminders()).toBe(0);

    // Off for this server only: claimed and held, never cancelled.
    process.env.CUSTOM_BOTS = "true";
    const { resetFeatureFlagsForTests, setServerFlagOverride } = await import("../lib/flags.js");
    await setServerFlagOverride("custom_bots", server.id, false, { kind: "dashboard" });
    try {
      expect(await deliverDueReminders()).toBe(2);
      const held = await getPool().query<{ status: string }>(`SELECT status FROM server_bot_reminders`);
      expect(held.rows.map((row) => row.status)).toEqual(["pending", "pending"]);
      // The weekly one skipped this slot without posting; the one-off waits.
      const after = (await getPool().query<{ due_at: Date; sent_count: number }>(weekly)).rows[0]!;
      expect(after.due_at.getTime() - before.getTime()).toBeGreaterThan(6 * 86_400_000);
      expect(after.sent_count).toBe(0);
      expect(await posts(channelId, bot.userId)).toEqual([]);
    } finally {
      await setServerFlagOverride("custom_bots", server.id, null, { kind: "dashboard" });
      resetFeatureFlagsForTests();
    }
    await getPool().query(`UPDATE server_bot_reminders SET lease_until = NULL`);
    await deliverDueReminders();
    expect(await posts(channelId, bot.userId)).toHaveLength(1);
  });

  it("moves a repeating reminder that is hours late to its next slot without posting", async () => {
    const { owner, otherId, bot, tool } = await setup();
    await tool(owner.id, "create_reminder", { at: inMinutes(60), text: "Jogatina", repeat: "weekly", channelId: otherId });
    await getPool().query(`UPDATE server_bot_reminders SET due_at = NOW() - INTERVAL '7 hours'`);
    await deliverDueReminders();
    expect(await posts(otherId, bot.userId)).toEqual([]);
    const row = await getPool().query<{ status: string; due_at: Date; sent_count: number }>(
      `SELECT status, due_at, sent_count FROM server_bot_reminders`,
    );
    expect(row.rows[0]).toMatchObject({ status: "pending", sent_count: 0 });
    expect(row.rows[0]!.due_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("drops a one-off reminder that is hours late instead of posting it", async () => {
    const { member, channelId, bot, tool } = await setup();
    await tool(member.id, "create_reminder", { at: inMinutes(30), text: "ontem à noite" });
    await getPool().query(`UPDATE server_bot_reminders SET due_at = NOW() - INTERVAL '7 hours'`);
    await deliverDueReminders();
    expect(await posts(channelId, bot.userId)).toEqual([]);
    const row = await getPool().query<{ status: string }>(`SELECT status FROM server_bot_reminders`);
    expect(row.rows[0]!.status).toBe("cancelled");
  });
});
