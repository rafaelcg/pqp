import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The parts of server bots the operator and the bot's own powers rest on: the
 * role it acts through, what each run cost, and the history that outlives a
 * deleted bot. Real Postgres, stub model.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { assignRole, createRole, getRole, parsePermissions } = await import("./roles.js");
const { Permission, SERVER_BOT_DEFAULT_TOOLS, SERVER_BOT_TOOLS } = await import("@pqp/shared");
const { createServerBot, deleteServerBot, resetBotTriggerCacheForTests, updateServerBot } =
  await import("./bots.js");
const { botToolPermissions } = await import("./bot-actions.js");
const { deleteBotRole, syncBotRole } = await import("./bot-role.js");
const { botDay, nextBotDayStart } = await import("./bot-stats.js");
const { runBotRunsTick } = await import("./bot-runner.js");
const { setBotProviderForTests } = await import("./bot-llm.js");
const { postChannelMessage, resetChatRateLimits } = await import("../ws/chat.js");
const { readBotFacePng } = await import("./bot-faces.js");
const { botFaceAvatarPath } = await import("@pqp/shared");

describe("the bot day", () => {
  it("is São Paulo's date, and turns at its midnight", () => {
    expect(botDay(Date.parse("2026-10-14T02:30:00Z"))).toBe("2026-10-13");
    expect(botDay(Date.parse("2026-10-14T03:00:00Z"))).toBe("2026-10-14");
    expect(nextBotDayStart(Date.parse("2026-10-13T12:00:00Z")).toISOString()).toBe(
      "2026-10-14T03:00:00.000Z",
    );
    expect(nextBotDayStart(Date.parse("2026-10-14T02:59:00Z")).toISOString()).toBe(
      "2026-10-14T03:00:00.000Z",
    );
  });
});

describeDb("server bot foundations", () => {
  let savedFlag: string | undefined;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    setBotProviderForTests(null);
    await closePool();
  });

  beforeEach(async () => {
    savedFlag = process.env.CUSTOM_BOTS;
    process.env.CUSTOM_BOTS = "true";
    setBotProviderForTests({
      name: "fixture",
      model: "claude-haiku-5-5",
      async complete() {
        return {
          text: "Oi!",
          toolCalls: [],
          message: { role: "assistant", text: "Oi!", toolCalls: [], raw: [] },
          reportedCostMicros: null,
          inputTokens: 1000,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-haiku-5-5",
          stopReason: "end_turn",
        };
      },
    });
    resetBotTriggerCacheForTests();
    resetChatRateLimits();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages, server_members,
                server_bots, server_bot_runs, server_bot_usage_daily, server_bot_spend_daily,
                server_bot_stats_daily, server_bot_people_daily, server_bot_tools_daily, audit_log
       RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CUSTOM_BOTS;
    else process.env.CUSTOM_BOTS = savedFlag;
  });

  async function setup() {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa", avatarUrl: null });
    const { server, channels } = await createPqpServer("QG", owner.id);
    const channelId = channels.find((c) => c.type === "text")!.id;
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name: "Caio",
      persona: "",
      knowledge: "",
      channelIds: [channelId],
    });
    return { owner, server, channelId, bot };
  }

  /** A member whose only power is a role with these bits. */
  async function memberWith(serverId: string, clerkId: string, permissions: bigint) {
    const user = await upsertUser({ clerkId, displayName: clerkId, avatarUrl: null });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, user.id],
    );
    const role = await createRole(serverId, { name: `${clerkId}_role`, permissions });
    await assignRole(serverId, user.id, role.id);
    return user;
  }

  const roleBits = async (roleId: string) => parsePermissions((await getRole(roleId))!.permissions);

  it("gives a new bot its own role with exactly what its tools need", async () => {
    const { owner, server, bot } = await setup();
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    expect(synced?.roleId).toBeTruthy();
    expect(synced?.missing).toBe(0n);
    const role = (await getRole(synced!.roleId!))!;
    expect(role.name).toBe("caio_bot");
    expect(parsePermissions(role.permissions)).toBe(botToolPermissions(SERVER_BOT_DEFAULT_TOOLS));
    expect(role.position).toBe(1);
    const held = await getPool().query(
      `SELECT 1 FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3`,
      [server.id, bot.userId, role.id],
    );
    expect(held.rowCount).toBe(1);
    const stored = await getPool().query<{ role_id: string }>(
      `SELECT role_id FROM server_bots WHERE id = $1`,
      [bot.id],
    );
    expect(stored.rows[0]!.role_id).toBe(role.id);
    const audit = await getPool().query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE server_id = $1 ORDER BY created_at`,
      [server.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["role.create", "member.roles_update"]);
    expect(audit.rows.every((row) => row.actor_id === owner.id)).toBe(true);
  });

  it("never grants a bit the person saving does not hold", async () => {
    const { server, bot } = await setup();
    const staff = await memberWith(
      server.id,
      "staff",
      Permission.MANAGE_ROLES | Permission.MANAGE_CHANNELS,
    );
    await updateServerBot({ serverId: server.id, botId: bot.id, tools: [...SERVER_BOT_TOOLS] });
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: staff.id });
    const needed = botToolPermissions(SERVER_BOT_TOOLS);
    // Theirs: the role's bits and @everyone's (Create Invite among them).
    const held = Permission.MANAGE_CHANNELS | Permission.CREATE_INVITE;
    expect(await roleBits(synced!.roleId!)).toBe(needed & held);
    expect(synced!.missing).toBe(needed & ~held);
    expect(synced!.missing & Permission.BAN_MEMBERS).toBe(Permission.BAN_MEMBERS);
  });

  it("makes no role for somebody who may not manage roles", async () => {
    const { server, bot } = await setup();
    const staff = await memberWith(server.id, "manager", Permission.MANAGE_SERVER);
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: staff.id });
    expect(synced).toEqual({
      roleId: null,
      changed: false,
      missing: botToolPermissions(SERVER_BOT_DEFAULT_TOOLS),
    });
    const roles = await getPool().query(`SELECT 1 FROM roles WHERE name = 'caio_bot'`);
    expect(roles.rowCount).toBe(0);
  });

  it("follows the tool switches: off removes the bit, on adds it back", async () => {
    const { owner, server, bot } = await setup();
    const first = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    const withoutChannels = SERVER_BOT_DEFAULT_TOOLS.filter(
      (tool) => !["create_channel", "edit_channel", "move_channel", "delete_channel"].includes(tool),
    );
    await updateServerBot({ serverId: server.id, botId: bot.id, tools: withoutChannels });
    const second = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    expect(second!.roleId).toBe(first!.roleId);
    expect(second!.changed).toBe(true);
    expect((await roleBits(second!.roleId!)) & Permission.MANAGE_CHANNELS).toBe(0n);

    await updateServerBot({ serverId: server.id, botId: bot.id, tools: [...SERVER_BOT_DEFAULT_TOOLS] });
    await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    expect((await roleBits(first!.roleId!)) & Permission.MANAGE_CHANNELS).toBe(
      Permission.MANAGE_CHANNELS,
    );
  });

  it("keeps a bit a more powerful staff member granted while its tool stays on", async () => {
    const { owner, server, bot } = await setup();
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    const staff = await memberWith(server.id, "helper", Permission.MANAGE_ROLES);
    // Nothing changed in the tools: a weaker staff member's save removes nothing.
    const again = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: staff.id });
    expect(again!.changed).toBe(false);
    expect(await roleBits(synced!.roleId!)).toBe(botToolPermissions(SERVER_BOT_DEFAULT_TOOLS));
  });

  it("makes a new role when somebody deleted the old one", async () => {
    const { owner, server, bot } = await setup();
    const first = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    await getPool().query(`DELETE FROM roles WHERE id = $1`, [first!.roleId]);
    const second = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    expect(second!.roleId).not.toBe(first!.roleId);
    expect(second!.changed).toBe(true);
  });

  it("ends with one role when two saves race", async () => {
    const { owner, server, bot } = await setup();
    const [a, b] = await Promise.all([
      syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id }),
      syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id }),
    ]);
    expect(a!.roleId).toBe(b!.roleId);
    const roles = await getPool().query(
      `SELECT id FROM roles WHERE server_id = $1 AND name LIKE 'caio_bot%'`,
      [server.id],
    );
    expect(roles.rows.map((row) => row.id)).toEqual([a!.roleId]);
  });

  it("names the role around a taken name", async () => {
    const { owner, server, bot } = await setup();
    await createRole(server.id, { name: "caio_bot", permissions: 0n });
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    expect((await getRole(synced!.roleId!))!.name).toBe("caio_bot_2");
  });

  it("takes the role away with the bot", async () => {
    const { owner, server, bot } = await setup();
    const synced = await syncBotRole({ serverId: server.id, botId: bot.id, actorId: owner.id });
    const removed = await deleteServerBot(server.id, bot.id);
    expect(removed!.roleId).toBe(synced!.roleId);
    expect(
      await deleteBotRole({ serverId: server.id, roleId: synced!.roleId!, actorId: owner.id }),
    ).toBe(true);
    expect(await getRole(synced!.roleId!)).toBeNull();
  });

  it("draws the bot as its Breu: colour, face and the line under its name", async () => {
    const { server, bot } = await setup();
    expect(bot.color).toBe("lime");
    expect(bot.face).toBe("oi");
    expect(bot.avatarUrl).toBe(botFaceAvatarPath("lime", "oi"));

    const updated = await updateServerBot({
      serverId: server.id,
      botId: bot.id,
      color: "grape",
      face: "kkkk",
      tagline: "Pergunte qualquer coisa",
    });
    expect(updated!.restyled).toBe(true);
    expect(updated!.bot).toMatchObject({
      color: "grape",
      face: "kkkk",
      tagline: "Pergunte qualquer coisa",
      avatarUrl: botFaceAvatarPath("grape", "kkkk"),
    });
    const account = await getPool().query<{ avatar_url: string; custom_status: string }>(
      `SELECT avatar_url, custom_status FROM users WHERE id = $1`,
      [bot.userId],
    );
    expect(account.rows[0]).toEqual({
      avatar_url: botFaceAvatarPath("grape", "kkkk"),
      custom_status: "Pergunte qualquer coisa",
    });

    const untouched = await updateServerBot({ serverId: server.id, botId: bot.id, persona: "Zoeiro" });
    expect(untouched!.restyled).toBe(false);
    expect(untouched!.bot.tagline).toBe("Pergunte qualquer coisa");
  });

  it("serves the face PNGs and nothing else", async () => {
    const png = await readBotFacePng("lime", "oi");
    expect(png?.subarray(1, 4).toString()).toBe("PNG");
    expect(await readBotFacePng("lime", "dormindo")).toBeNull();
    expect(await readBotFacePng("..", "oi")).toBeNull();
  });

  it("records what started a run and what it cost, and keeps the history after the bot goes", async () => {
    const { owner, server, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    await runBotRunsTick();

    const run = await getPool().query<{
      trigger: string;
      model: string;
      turns: number;
      input_tokens: string;
      output_tokens: string;
      cost_micros: string;
    }>(`SELECT trigger, model, turns, input_tokens, output_tokens, cost_micros FROM server_bot_runs`);
    expect(run.rows[0]).toMatchObject({
      trigger: "mention",
      model: "claude-haiku-5-5",
      turns: 1,
      input_tokens: "1000",
      output_tokens: "20",
    });
    expect(Number(run.rows[0]!.cost_micros)).toBeGreaterThan(0);

    await deleteServerBot(server.id, bot.id);
    const stats = await getPool().query<{
      day: string;
      bot_user_id: string;
      runs: number;
      replies: number;
      cost_micros: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, bot_user_id, runs, replies, cost_micros
         FROM server_bot_stats_daily WHERE server_id = $1`,
      [server.id],
    );
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({
      day: botDay(),
      bot_user_id: bot.userId,
      runs: 1,
      replies: 1,
      cost_micros: run.rows[0]!.cost_micros,
    });
    const people = await getPool().query<{ user_id: string; runs: number }>(
      `SELECT user_id, runs FROM server_bot_people_daily WHERE server_id = $1`,
      [server.id],
    );
    expect(people.rows).toEqual([{ user_id: owner.id, runs: 1 }]);
    const usage = await getPool().query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM server_bot_usage_daily WHERE server_id = $1`,
      [server.id],
    );
    expect(usage.rows[0]!.day).toBe(botDay());
  });
});
