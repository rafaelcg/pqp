import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Server bot actions on a real Postgres: the tool loop, the two keys, plans
 * and the "sim". The model is a script; the routes it reaches are the real ones.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer, createChannel } = await import("./servers.js");
const { assignRole, createRole, listRoles, upsertChannelOverwrite } = await import("./roles.js");
const { Permission, SERVER_BOT_DEFAULT_TOOLS, SERVER_BOT_TOOLS } = await import("@pqp/shared");
const { createServerBot, resetBotTriggerCacheForTests, confirmationWord, updateServerBot } = await import("./bots.js");
const { answerBotAsk, runBotRunsTick } = await import("./bot-runner.js");
const { setBotProviderForTests } = await import("./bot-llm.js");
const { ActionSession, executePlan, handleToolCall, savePlan } = await import("./bot-actions.js");
const { postChannelMessage, resetChatRateLimits } = await import("../ws/chat.js");
const { setBotImageLoaderForTests } = await import("./bot-media.js");
const { maybeQueueBotReply } = await import("./bots.js");

type Completion = Awaited<ReturnType<import("./bot-llm.js").BotProvider["complete"]>>;
type Input = Parameters<import("./bot-llm.js").BotProvider["complete"]>[0];
type Step = { text?: string; calls?: Array<{ name: string; input: Record<string, unknown> }> };

function reply(step: Step, turn: number): Completion {
  const toolCalls = (step.calls ?? []).map((call, index) => ({ id: `t${turn}-${index}`, ...call }));
  const text = step.text ?? null;
  return {
    text,
    toolCalls,
    message: { role: "assistant", text, toolCalls, raw: [] },
    reportedCostMicros: 0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: "fixture",
    stopReason: toolCalls.length ? "tool_use" : "end_turn",
  };
}

describe("confirmationWord", () => {
  it("reads a bare yes or no, with a mention or punctuation", () => {
    expect(confirmationWord("sim")).toBe("yes");
    expect(confirmationWord("@caio_bot Sim!", "caio_bot")).toBe("yes");
    expect(confirmationWord("não")).toBe("no");
    expect(confirmationWord("sim, e cria outro")).toBeNull();
    expect(confirmationWord("@caio_bot sim", "caio_bot")).toBe("yes");
    expect(confirmationWord("@bia sim", "caio_bot")).toBeNull();
    expect(confirmationWord("ok")).toBeNull();
    expect(confirmationWord("pode")).toBeNull();
  });
});

describeDb("server bot actions", () => {
  let script: (input: Input, turn: number) => Step;
  let seen: Input[] = [];

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    setBotProviderForTests(null);
    await closePool();
  });

  let savedFlag: string | undefined;
  beforeEach(async () => {
    savedFlag = process.env.CUSTOM_BOTS;
    process.env.CUSTOM_BOTS = "true";
    seen = [];
    script = () => ({ text: "ok" });
    setBotProviderForTests({
      name: "fixture",
      model: "fixture",
      async complete(input) {
        seen.push(input);
        const turn = input.messages.filter((m) => m.role === "assistant").length;
        return reply(script(input, turn), turn);
      },
    });
    resetBotTriggerCacheForTests();
    resetChatRateLimits();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, message_mentions, channel_reads,
                server_bots, server_bot_runs, server_bot_usage_daily, server_bot_spend_daily,
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
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [server.id, member.id],
    );
    const channelId = channels.find((c) => c.type === "text")!.id;
    const old = await createChannel(server.id, "velho", "text");
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name: "Caio",
      persona: "",
      knowledge: "",
      channelIds: [channelId],
      tools: [...SERVER_BOT_TOOLS],
    });
    const staff = await createRole(server.id, {
      name: "bot_staff",
      permissions: Permission.MANAGE_CHANNELS | Permission.MANAGE_MESSAGES | Permission.MODERATE_MEMBERS,
    });
    await assignRole(server.id, bot.userId, staff.id);
    return { owner, member, server, channelId, oldId: old.id, bot };
  }

  const channelNamed = async (serverId: string, name: string) =>
    (await getPool().query(`SELECT id FROM channels WHERE server_id = $1 AND name = $2`, [serverId, name]))
      .rowCount;

  const botReplies = async (botUserId: string) =>
    (
      await getPool().query<{ body: string }>(
        `SELECT body FROM messages WHERE author_id = $1 ORDER BY created_at`,
        [botUserId],
      )
    ).rows.map((row) => row.body);

  it("runs a small request at once, and the audit row says who asked", async () => {
    const { owner, server, channelId, bot } = await setup();
    script = (_input, turn) =>
      turn === 0
        ? { calls: [{ name: "create_channel", input: { name: "Lobby CS2", type: "voice" } }] }
        : { text: "Vou criar a sala." };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot cria uma sala de voz Lobby CS2" });
    await runBotRunsTick();

    expect(await channelNamed(server.id, "lobby-cs2")).toBe(1);
    const [body] = await botReplies(bot.userId);
    expect(body).toContain("Vou criar a sala.");
    expect(body).toContain('✓ Criar canal de voz "lobby-cs2"');
    // The card rides the normal read path, and the body keeps a text copy.
    const { listMessages, listPinnedMessages, mapMessage } = await import("./messages.js");
    const page = await listMessages(channelId, { limit: 5 });
    const card = page.messages.map(mapMessage).find((m) => m.authorId === bot.userId)?.botCard;
    expect(card?.kind).toBe("result");
    expect(card?.lead).toBe("Vou criar a sala.");
    expect(card?.items).toEqual([
      { tool: "create_channel", label: 'Criar canal de voz "lobby-cs2"', status: "ok", detail: null },
    ]);
    const botMessageId = page.messages.find((m) => m.author_id === bot.userId)!.id;
    await getPool().query(`UPDATE messages SET pinned_at = NOW() WHERE id = $1`, [botMessageId]);
    expect(mapMessage((await listPinnedMessages(channelId))[0]!).botCard?.kind).toBe("result");
    const audit = await getPool().query<{ actor_id: string; reason: string }>(
      `SELECT actor_id, reason FROM audit_log WHERE action = 'channel.create'`,
    );
    expect(audit.rows[0]?.actor_id).toBe(bot.userId);
    expect(audit.rows[0]?.reason).toContain("pedido por");
  });

  it("will not act for a member who lacks the permission, even though the bot has it", async () => {
    const { member, server, channelId, bot } = await setup();
    script = (_input, turn) =>
      turn === 0
        ? { calls: [{ name: "create_channel", input: { name: "hack", type: "text" } }] }
        : { text: "Não posso." };
    await postChannelMessage({ author: member, channelId, body: "@caio_bot cria #hack" });
    await runBotRunsTick();

    expect(seen[0]!.tools?.map((tool) => tool.name)).not.toContain("create_channel");
    expect(seen[0]!.system).toContain("create_channel (the member asking lacks the permission)");
    const toolTurn = seen[1]!.messages.at(-1);
    expect(toolTurn?.role === "tool" && toolTurn.results[0]!.isError).toBe(true);
    expect(await channelNamed(server.id, "hack")).toBe(0);
    expect(await botReplies(bot.userId)).toEqual(["Não posso."]);
  });

  it("lists only channels the member who asked can see", async () => {
    const { member, server, channelId } = await setup();
    const secret = await createChannel(server.id, "staff", "text");
    const everyone = (await listRoles(server.id)).find((role) => role.is_everyone)!;
    await upsertChannelOverwrite(secret.id, server.id, "role", everyone.id, 0n, Permission.VIEW_CHANNEL);
    const staffRole = (await listRoles(server.id)).find((role) => role.name === "bot_staff")!;
    await upsertChannelOverwrite(secret.id, server.id, "role", staffRole.id, Permission.VIEW_CHANNEL, 0n);
    script = (_input, turn) => (turn === 0 ? { calls: [{ name: "list_channels", input: {} }] } : { text: "ok" });
    await postChannelMessage({ author: member, channelId, body: "@caio_bot quais canais?" });
    await runBotRunsTick();

    const toolTurn = seen[1]!.messages.at(-1);
    const listed = toolTurn?.role === "tool" ? toolTurn.results[0]!.content : "";
    expect(listed).toContain("velho");
    expect(listed).not.toContain(secret.id);
  });

  it("waits for the requester's sim before a delete, and runs it once", async () => {
    const { owner, member, server, channelId, oldId, bot } = await setup();
    script = (_input, turn) =>
      turn === 0
        ? { calls: [{ name: "delete_channel", input: { channelId: oldId } }] }
        : { text: "Posso apagar." };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot apaga o #velho" });
    await runBotRunsTick();
    expect(await channelNamed(server.id, "velho")).toBe(1);
    expect((await botReplies(bot.userId))[0]).toContain("Responda **sim**");
    const plan = await getPool().query<{ bot_card: { kind: string; items: Array<{ status: string }>; confirmBy: string } }>(
      `SELECT bot_card FROM messages WHERE author_id = $1`,
      [bot.userId],
    );
    expect(plan.rows[0]!.bot_card.kind).toBe("plan");
    expect(plan.rows[0]!.bot_card.items[0]!.status).toBe("pending");

    // Somebody else's "sim" is not an answer.
    await postChannelMessage({ author: member, channelId, body: "sim" });
    expect(
      (await getPool().query(`SELECT 1 FROM server_bot_runs WHERE plan_id IS NOT NULL`)).rowCount,
    ).toBe(0);

    // Two from the requester: one executes, the other (run after it) finds it taken.
    await postChannelMessage({ author: owner, channelId, body: "sim" });
    await postChannelMessage({ author: owner, channelId, body: "sim!" });
    await runBotRunsTick();
    await runBotRunsTick();
    expect(await channelNamed(server.id, "velho")).toBe(0);
    const actions = await getPool().query(`SELECT 1 FROM server_bot_actions`);
    expect(actions.rowCount).toBe(1);
    const outcomes = await getPool().query<{ outcome: string }>(
      `SELECT outcome FROM server_bot_runs WHERE plan_id IS NOT NULL ORDER BY created_at`,
    );
    expect(outcomes.rows.map((row) => row.outcome).sort()).toEqual(["plan-done", "plan-taken"]);
  });

  it("cancels on não", async () => {
    const { owner, server, channelId, oldId, bot } = await setup();
    script = (_input, turn) =>
      turn === 0 ? { calls: [{ name: "delete_channel", input: { channelId: oldId } }] } : { text: "" };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot apaga o #velho" });
    await runBotRunsTick();
    await postChannelMessage({ author: owner, channelId, body: "não" });
    await runBotRunsTick();
    expect(await channelNamed(server.id, "velho")).toBe(1);
    expect((await botReplies(bot.userId)).at(-1)).toContain("cancelei");
  });

  it("never runs a step again when a plan is taken over", async () => {
    const { owner, server, channelId, bot } = await setup();
    const ctx = {
      serverId: server.id,
      channelId,
      botId: bot.id,
      bot: (await getPool().query(`SELECT * FROM users WHERE id = $1`, [bot.userId])).rows[0],
      requesterId: owner.id,
      requesterTag: "Rafa",
      enabledTools: new Set<string>(SERVER_BOT_TOOLS),
    };
    const plan = await savePlan(
      ctx,
      "00000000-0000-4000-8000-000000000001",
      [
        { tool: "create_channel", input: { name: "um", type: "text", categoryId: null, topic: null }, label: "um", destructive: false, ref: "new:1" },
        { tool: "create_channel", input: { name: "dois", type: "text", categoryId: null, topic: null }, label: "dois", destructive: false, ref: "new:2" },
      ],
      "executing",
    );
    // The first worker ran step 0, then lost the plan before step 1.
    await getPool().query(
      `INSERT INTO server_bot_actions (plan_id, step, bot_id, tool, status, result)
       VALUES ($1, 0, $2, 'create_channel', 'done', '{"ok":true,"line":"um"}')`,
      [plan!.id, bot.id],
    );
    const { lines } = await executePlan(plan!, ctx);
    expect(lines).toEqual(["✓ um", "✓ dois"]);
    expect(await channelNamed(server.id, "um")).toBe(0);
    expect(await channelNamed(server.id, "dois")).toBe(1);
  });

  it("times a member out only after the sim, as the bot", async () => {
    const { owner, member, server, channelId, bot } = await setup();
    script = (_input, turn) =>
      turn === 0
        ? { calls: [{ name: "timeout_member", input: { userId: member.id, minutes: 10, reason: "flood" } }] }
        : { text: "Vou silenciar." };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot silencia a Bia 10 min" });
    await runBotRunsTick();
    const timeouts = () => getPool().query(`SELECT issued_by FROM member_timeouts WHERE server_id = $1`, [server.id]);
    expect((await timeouts()).rowCount).toBe(0);
    expect((await botReplies(bot.userId))[0]).toMatch(/Silenciar \S+ por 10 min \(flood\)/);

    await postChannelMessage({ author: owner, channelId, body: "sim" });
    await runBotRunsTick();
    const issued = await timeouts();
    expect(issued.rows[0]?.issued_by).toBe(bot.userId);
  });

  it("will not moderate somebody who outranks the member asking", async () => {
    const { owner, member, server, channelId } = await setup();
    const mods = await createRole(server.id, { name: "mods", permissions: Permission.MODERATE_MEMBERS });
    await assignRole(server.id, member.id, mods.id);
    script = (_input, turn) =>
      turn === 0
        ? { calls: [{ name: "timeout_member", input: { userId: owner.id, minutes: 10 } }] }
        : { text: "Não dá." };
    await postChannelMessage({ author: member, channelId, body: "@caio_bot silencia o dono" });
    await runBotRunsTick();
    const toolTurn = seen[1]!.messages.at(-1);
    expect(toolTurn?.role === "tool" && toolTurn.results[0]!.isError).toBe(true);
    expect((await getPool().query(`SELECT 1 FROM server_bot_plans`)).rowCount).toBe(0);
  });

  it("names a message by its number in the conversation", async () => {
    const { owner, channelId, bot } = await setup();
    const sent = await postChannelMessage({ author: owner, channelId, body: "regras: sem spam" });
    script = (input, turn) => {
      if (turn > 0) return { text: "Fixando." };
      const prompt = input.messages[0]!.role === "user" ? input.messages[0]!.text : "";
      const ref = Number(/\[m(\d+)\] \[Rafa[^\]]*\]: regras/.exec(prompt)![1]);
      return { calls: [{ name: "pin_message", input: { messageRef: ref } }] };
    };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot fixa as regras" });
    await runBotRunsTick();
    const pinned = await getPool().query(`SELECT pinned_at FROM messages WHERE id = $1`, [
      sent.ok ? sent.message.id : "",
    ]);
    expect(pinned.rows[0]?.pinned_at).not.toBeNull();
    expect((await botReplies(bot.userId))[0]).toContain('✓ Fixar a mensagem de Rafa ("regras: sem spam")');
  });

  it("runs every write tool through its real route", async () => {
    process.env.FORUM_CHANNELS = "true";
    process.env.COMMUNITY_HOME_ENABLED = "true";
    try {
      const { owner, member, server, channelId, oldId, bot } = await setup();
      const all = await createRole(server.id, {
        name: "bot_all",
        permissions:
          Permission.MANAGE_CHANNELS |
          Permission.MANAGE_MESSAGES |
          Permission.MODERATE_MEMBERS |
          Permission.KICK_MEMBERS |
          Permission.BAN_MEMBERS |
          Permission.MANAGE_SERVER,
      });
      await assignRole(server.id, bot.userId, all.id);
      const kickee = await upsertUser({ clerkId: "kickee", displayName: "Kiko", avatarUrl: null });
      const bannee = await upsertUser({ clerkId: "bannee", displayName: "Beto", avatarUrl: null });
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [server.id, kickee.id, bannee.id],
      );
      const category = await createChannel(server.id, "Jogos", "category");
      const forum = await createChannel(server.id, "ideias", "forum");
      const first = await postChannelMessage({ author: owner, channelId, body: "abre um tópico aqui" });
      const second = await postChannelMessage({ author: owner, channelId, body: "apaga isto" });
      const ctx = {
        serverId: server.id,
        channelId,
        botId: bot.id,
        bot: (await getPool().query(`SELECT * FROM users WHERE id = $1`, [bot.userId])).rows[0],
        requesterId: owner.id,
        requesterTag: "@rafa",
        enabledTools: new Set<string>(SERVER_BOT_TOOLS),
      };

      const found = await handleToolCall(new ActionSession(ctx), "list_members", { query: "kik" });
      expect(found.content).toContain(kickee.id);

      const steps: Array<[string, Record<string, unknown>]> = [
        ["edit_channel", { channelId: oldId, name: "velho-2", topic: "novo tópico", slowmodeSeconds: 5 }],
        ["move_channel", { channelId: oldId, categoryId: category.id, position: 0 }],
        ["post_message", { channelId, text: "aviso da staff" }],
        ["pin_message", { messageId: first.ok ? first.message.id : "", unpin: false }],
        ["create_thread", { messageId: first.ok ? first.message.id : "", name: "conversa" }],
        ["create_forum_post", { forumId: forum.id, title: "Ideia", body: "texto da ideia" }],
        ["create_bau_post", { title: "Novidade", body: "texto", publish: true }],
        ["delete_message", { messageId: second.ok ? second.message.id : "" }],
        ["timeout_member", { userId: member.id, minutes: 5, reason: null }],
        ["remove_timeout", { userId: member.id }],
        ["kick_member", { userId: kickee.id }],
        ["ban_member", { userId: bannee.id, reason: "spam" }],
        ["unban_member", { bannedUserId: bannee.id }],
        ["create_invite", { maxUses: 5, expiresInHours: null }],
      ];
      const plan = await savePlan(
        ctx,
        "00000000-0000-4000-8000-000000000002",
        steps.map(([tool, input]) => ({ tool, input, label: tool, destructive: false })),
        "executing",
      );
      const { lines, items } = await executePlan(plan!, ctx);
      expect(lines.slice(0, -1)).toEqual(steps.slice(0, -1).map(([tool]) => `✓ ${tool}`));
      expect(lines.at(-1)).toMatch(/^✓ create_invite: https?:\/\/\S+\/app\/invite\/\w+/);
      expect(items.at(-1)?.detail).toMatch(/\/app\/invite\//);
      const left = await getPool().query(
        `SELECT (SELECT COUNT(*)::int FROM member_timeouts WHERE server_id = $1 AND user_id = $2 AND expires_at > NOW()) AS timeouts,
                (SELECT COUNT(*)::int FROM server_bans WHERE server_id = $1 AND user_id = $3) AS bans`,
        [server.id, member.id, bannee.id],
      );
      expect(left.rows[0]).toEqual({ timeouts: 0, bans: 0 });
    } finally {
      delete process.env.FORUM_CHANNELS;
      delete process.env.COMMUNITY_HOME_ENABLED;
    }
  });

  it("reads another channel only when both the bot and the member can", async () => {
    const { owner, member, server, channelId, oldId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId: oldId, body: "placar: 3 a 1" });
    const botUser = (await getPool().query(`SELECT * FROM users WHERE id = $1`, [bot.userId])).rows[0];
    const ctx = (requesterId: string) => ({
      serverId: server.id,
      channelId,
      botId: bot.id,
      bot: botUser,
      requesterId,
      requesterTag: "@x",
      enabledTools: new Set<string>(SERVER_BOT_TOOLS),
    });
    const read = await handleToolCall(new ActionSession(ctx(owner.id)), "read_channel", { channelId: oldId });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain("placar: 3 a 1");
    expect(JSON.parse(read.content)).toMatchObject({ count: 1, olderMessagesExist: false });
    for (let i = 0; i < 3; i += 1) {
      await postChannelMessage({ author: owner, channelId: oldId, body: `msg ${i}` });
    }
    const page = await handleToolCall(new ActionSession(ctx(owner.id)), "read_channel", { channelId: oldId, limit: 2 });
    expect(JSON.parse(page.content)).toMatchObject({ count: 2, olderMessagesExist: true });

    const roles = await listRoles(server.id);
    const everyone = roles.find((role) => role.is_everyone)!;
    const staffRole = roles.find((role) => role.name === "bot_staff")!;
    await upsertChannelOverwrite(oldId, server.id, "role", everyone.id, 0n, Permission.VIEW_CHANNEL);
    await upsertChannelOverwrite(oldId, server.id, "role", staffRole.id, Permission.VIEW_CHANNEL, 0n);
    const hidden = await handleToolCall(new ActionSession(ctx(member.id)), "read_channel", { channelId: oldId });
    expect(hidden.isError).toBe(true);
    expect(hidden.content).not.toContain("placar");
  });

  it("does not offer forums on a server where they are off", async () => {
    delete process.env.FORUM_CHANNELS;
    const { owner, channelId } = await setup();
    script = (_input, turn) =>
      turn === 0 ? { calls: [{ name: "create_channel", input: { name: "ideias", type: "forum" } }] } : { text: "Não dá." };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot cria um fórum" });
    await runBotRunsTick();
    const offered = seen[0]!.tools!.map((tool) => tool.name);
    expect(offered).not.toContain("create_forum_post");
    const createChannel = seen[0]!.tools!.find((tool) => tool.name === "create_channel")!;
    expect(JSON.stringify(createChannel.inputSchema)).not.toContain('"forum"');
    expect(seen[0]!.system).toContain("forum channels (turned off on this server)");
    const toolTurn = seen[1]!.messages.at(-1);
    expect(toolTurn?.role === "tool" && toolTurn.results[0]!.content).toContain("Forum channels are turned off");
    expect((await getPool().query(`SELECT 1 FROM server_bot_plans`)).rowCount).toBe(0);
  });

  it("explains a step that failed, instead of the sentence written before it ran", async () => {
    const { owner, server, channelId, oldId, bot } = await setup();
    script = (input, turn) => {
      const first = input.messages[0];
      if (!input.tools && first?.role === "user" && first.text.startsWith("Results:")) {
        expect(first.text).toContain("FAILED");
        return { text: "Não consegui apagar: o canal já não existia." };
      }
      return turn === 0
        ? { calls: [{ name: "delete_channel", input: { channelId: oldId } }] }
        : { text: "Vou apagar o #velho." };
    };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot apaga o #velho" });
    await runBotRunsTick();
    await getPool().query(`DELETE FROM channels WHERE id = $1 AND server_id = $2`, [oldId, server.id]);
    await postChannelMessage({ author: owner, channelId, body: "sim" });
    await runBotRunsTick();
    const last = await getPool().query<{ body: string; bot_card: { lead: string; items: Array<{ status: string }> } }>(
      `SELECT body, bot_card FROM messages WHERE author_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [bot.userId],
    );
    expect(last.rows[0]!.bot_card.items[0]!.status).toBe("failed");
    expect(last.rows[0]!.bot_card.lead).toBe("Não consegui apagar: o canal já não existia.");
    expect(last.rows[0]!.body.startsWith("Não consegui apagar")).toBe(true);
  });

  describe("polls", () => {
    const pollOf = async (botUserId: string) =>
      (
        await getPool().query<{ message_id: string }>(
          `SELECT p.message_id FROM polls p JOIN messages m ON m.id = p.message_id WHERE m.author_id = $1`,
          [botUserId],
        )
      ).rows[0]?.message_id;

    it("creates a poll, reads its votes, and votes once however often it is asked", async () => {
      const { owner, member, channelId, bot } = await setup();
      script = (input, turn) => {
        const asked = input.messages[0]!.role === "user" ? input.messages[0]!.text : "";
        // The transcript holds every earlier request too: newest first.
        if (turn > 0) return { text: "Feito." };
        if (asked.includes("vota")) return { calls: [{ name: "vote_poll", input: { option: 2 } }] };
        if (asked.includes("quem ganhou")) return { calls: [{ name: "read_poll", input: {} }] };
        return {
          calls: [{ name: "create_poll", input: { question: "Qual jogo hoje?", options: ["CS2", "Valorant"], durationHours: 4 } }],
        };
      };
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot faz uma enquete" });
      await runBotRunsTick();
      const messageId = await pollOf(bot.userId);
      expect(messageId).toBeTruthy();
      const options = (
        await getPool().query<{ id: string; label: string }>(
          `SELECT id, label FROM poll_options WHERE message_id = $1 ORDER BY position`,
          [messageId],
        )
      ).rows;
      expect(options.map((option) => option.label)).toEqual(["CS2", "Valorant"]);

      const { votePoll } = await import("./polls.js");
      await votePoll(messageId!, member.id, options[0]!.id);
      seen = [];
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot quem ganhou a enquete?" });
      await runBotRunsTick();
      const prompt = seen[0]!.messages[0]!;
      expect(prompt.role === "user" && prompt.text).toContain('[poll: "Qual jogo hoje?"');
      const toolTurn = seen[1]!.messages.at(-1);
      const read = JSON.parse(toolTurn?.role === "tool" ? toolTurn.results[0]!.content : "{}");
      expect(read).toMatchObject({ question: "Qual jogo hoje?", totalVotes: 1, closed: false });
      expect(read.options[0]).toMatchObject({ number: 1, label: "CS2", votes: 1, voters: ["Bia"] });

      for (const body of ["@caio_bot vota no valorant", "@caio_bot vota de novo"]) {
        await postChannelMessage({ author: owner, channelId, body });
        await runBotRunsTick();
      }
      const votes = await getPool().query(`SELECT 1 FROM poll_votes WHERE user_id = $1 AND option_id = $2`, [
        bot.userId,
        options[1]!.id,
      ]);
      expect(votes.rowCount).toBe(1);
    });

    it("posts a poll in another channel only for a member who could post there", async () => {
      const { member, server, channelId, oldId } = await setup();
      const ctx = {
        serverId: server.id,
        channelId,
        botId: "x",
        bot: { id: "x" } as never,
        requesterId: member.id,
        requesterTag: "@bia",
        enabledTools: new Set<string>(SERVER_BOT_TOOLS),
      };
      const here = await handleToolCall(new ActionSession(ctx), "create_poll", { question: "Pizza?", options: ["Sim", "Não"] });
      expect(here.isError).toBeFalsy();
      const there = await handleToolCall(new ActionSession(ctx), "create_poll", {
        question: "Pizza?",
        options: ["Sim", "Não"],
        channelId: oldId,
      });
      expect(there.isError).toBe(true);
      expect(there.content).toContain("Manage Messages");
    });
  });

  describe("forum posts", () => {
    beforeEach(() => {
      process.env.FORUM_CHANNELS = "true";
    });
    afterEach(() => {
      delete process.env.FORUM_CHANNELS;
    });

    async function forumWithPost(serverId: string, authorId: string) {
      const forum = await createChannel(serverId, "ideias", "forum");
      const { invokeApiAsUser } = await import("../api/index.js");
      const author = (await getPool().query(`SELECT * FROM users WHERE id = $1`, [authorId])).rows[0];
      const created = await invokeApiAsUser(author, "POST", `/api/channels/${forum.id}/posts`, {
        title: "Mapa novo",
        body: "o que acham?",
        nonce: "post-1",
      });
      expect(created.status).toBe(201);
      const postId = (created.body as { post: { id: string } }).post.id;
      return { forumId: forum.id, postId };
    }

    it("answers a mention inside a post of a forum it is set to answer in", async () => {
      const { owner, server, channelId, bot } = await setup();
      const { forumId, postId } = await forumWithPost(server.id, owner.id);
      await updateServerBot({ serverId: server.id, botId: bot.id, channelIds: [channelId, forumId] });
      resetBotTriggerCacheForTests();
      script = () => ({ text: "Curti o mapa." });
      await postChannelMessage({ author: owner, channelId: postId, body: "@caio_bot e tu?" });
      await runBotRunsTick();
      const reply = await getPool().query<{ channel_id: string; body: string }>(
        `SELECT channel_id, body FROM messages WHERE author_id = $1`,
        [bot.userId],
      );
      expect(reply.rows).toEqual([{ channel_id: postId, body: "Curti o mapa." }]);
      const prompt = seen[0]!.messages[0]!;
      expect(prompt.role === "user" && prompt.text).toContain("o que acham?");
    });

    it("lists a forum's posts and replies in one, but not in a locked one", async () => {
      const { owner, server, channelId, bot } = await setup();
      const { forumId, postId } = await forumWithPost(server.id, owner.id);
      const ctx = {
        serverId: server.id,
        channelId,
        botId: bot.id,
        bot: (await getPool().query(`SELECT * FROM users WHERE id = $1`, [bot.userId])).rows[0],
        requesterId: owner.id,
        requesterTag: "@rafa",
        enabledTools: new Set<string>(SERVER_BOT_TOOLS),
        answerChannelIds: new Set([channelId]),
      };
      const listed = await handleToolCall(new ActionSession(ctx), "list_forum_posts", { forumChannelId: forumId });
      expect(JSON.parse(listed.content)).toEqual([
        expect.objectContaining({ id: postId, title: "Mapa novo", author: "Rafa", replies: 0 }),
      ]);
      const channels = await handleToolCall(new ActionSession(ctx), "list_channels", {});
      expect(JSON.parse(channels.content)).toContainEqual(expect.objectContaining({ id: forumId, youAnswerHere: false }));

      const session = new ActionSession(ctx);
      await handleToolCall(session, "reply_forum_post", { postId, text: "Ficou bom!" });
      const plan = await savePlan(ctx, "00000000-0000-4000-8000-000000000009", session.staged, "executing");
      const { lines } = await executePlan(plan!, ctx);
      expect(lines).toEqual(['✓ Responder no post "Mapa novo": "Ficou bom!"']);
      const posted = await getPool().query(`SELECT 1 FROM messages WHERE channel_id = $1 AND author_id = $2`, [
        postId,
        bot.userId,
      ]);
      expect(posted.rowCount).toBe(1);

      await getPool().query(`UPDATE forum_posts SET locked_at = NOW() WHERE channel_id = $1`, [postId]);
      const locked = await handleToolCall(new ActionSession(ctx), "reply_forum_post", { postId, text: "mais" });
      expect(locked.isError).toBe(true);
      expect(locked.content).toContain("locked");
    });
  });

  describe("images and voice notes", () => {
    let loaded: string[] = [];
    beforeEach(() => {
      loaded = [];
      setBotImageLoaderForTests(async (candidate) => {
        loaded.push(candidate.attachmentId);
        return { mediaType: candidate.mediaType, data: process.env.BIG_IMAGE ? "A".repeat(1_400_000) : "AAAA" };
      });
    });
    afterEach(() => {
      setBotImageLoaderForTests(null);
      delete process.env.VOICE_NOTE_TRANSCRIPTION;
      delete process.env.BIG_IMAGE;
      delete process.env.BOTS_MAX_USD_PER_DAY;
    });

    async function attach(
      messageId: string,
      channelId: string,
      uploaderId: string,
      kind: "image" | "flagged" | "voice",
      voice?: { text: string; allowed: boolean },
    ): Promise<string> {
      const row = await getPool().query<{ id: string }>(
        `INSERT INTO message_attachments
           (message_id, channel_id, uploader_id, storage_key, filename, content_type, byte_size, width, height, scan_status)
         VALUES ($1, $2, $3, gen_random_uuid()::text, $4, $5, 1000, $6, $6, $7)
         RETURNING id`,
        [
          messageId,
          channelId,
          uploaderId,
          kind === "voice" ? "nota.webm" : "foto.png",
          kind === "voice" ? "audio/webm" : "image/png",
          kind === "voice" ? null : 800,
          kind === "flagged" ? "flagged" : "unscanned",
        ],
      );
      if (voice) {
        await getPool().query(
          `INSERT INTO message_attachment_voice
             (attachment_id, duration_ms, waveform, transcribe_allowed, transcript_status, transcript_text)
           VALUES ($1, 12000, '', $2, 'done', $3)`,
          [row.rows[0]!.id, voice.allowed, voice.text],
        );
      }
      return row.rows[0]!.id;
    }

    const firstPrompt = () => {
      const first = seen[0]!.messages[0]!;
      return first.role === "user" ? first : null;
    };

    it("shows at most two images, the ones in the message that called it first, and never a flagged one", async () => {
      const { owner, channelId } = await setup();
      const older = await postChannelMessage({ author: owner, channelId, body: "olha essa" });
      const olderId = older.ok ? older.message.id : "";
      const flagged = await attach(olderId, channelId, owner.id, "flagged");
      const oldImage = await attach(olderId, channelId, owner.id, "image");
      const call = await postChannelMessage({ author: owner, channelId, body: "foto" });
      const callId = call.ok ? call.message.id : "";
      const a = await attach(callId, channelId, owner.id, "image");
      const b = await attach(callId, channelId, owner.id, "image");
      await getPool().query(`UPDATE messages SET body = '@caio_bot o que tem nessas fotos?' WHERE id = $1`, [callId]);
      await maybeQueueBotReply({
        author: owner,
        channel: (await getPool().query(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0],
        messageId: callId,
        body: "@caio_bot o que tem nessas fotos?",
        repliedToUserId: null,
      });
      await runBotRunsTick();
      expect(loaded).toEqual([a, b]);
      expect(loaded).not.toContain(flagged);
      expect(loaded).not.toContain(oldImage);
      const prompt = firstPrompt()!;
      expect(prompt.images).toHaveLength(2);
      expect(prompt.text).toContain("[image 1] [image 2]");
      expect(prompt.text).toContain("olha essa [image, not shown] [image, not shown]");
    });

    it("estimates an image's cost from its size, not from its base64", async () => {
      process.env.BIG_IMAGE = "1";
      process.env.BOTS_MAX_USD_PER_DAY = "0.5";
      const { owner, channelId, bot } = await setup();
      const sent = await postChannelMessage({ author: owner, channelId, body: "foto grande" });
      await attach(sent.ok ? sent.message.id : "", channelId, owner.id, "image");
      script = () => ({ text: "É um gato." });
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot o que é isso?" });
      await runBotRunsTick();
      expect((await botReplies(bot.userId)).at(-1)).toBe("É um gato.");
      expect(firstPrompt()!.images).toHaveLength(1);
    });

    it("reads a voice note through its transcript, only when the server and the sender allow it", async () => {
      const { owner, member, server, channelId, bot } = await setup();
      process.env.VOICE_NOTE_TRANSCRIPTION = "true";
      const one = await postChannelMessage({ author: owner, channelId, body: "ouve" });
      await attach(one.ok ? one.message.id : "", channelId, owner.id, "voice", { text: "bora jogar às nove", allowed: true });
      const two = await postChannelMessage({ author: member, channelId, body: "e essa" });
      await attach(two.ok ? two.message.id : "", channelId, member.id, "voice", { text: "segredo", allowed: false });
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot o que falaram?" });
      await runBotRunsTick();
      let text = firstPrompt()!.text;
      expect(text).toContain('[voice note, 12s, transcribed: "bora jogar às nove"]');
      expect(text).toContain("e essa [voice note, 12s, not transcribed]");
      expect(text).not.toContain("segredo");

      // The server's flag off hides even an allowed transcript.
      process.env.VOICE_NOTE_TRANSCRIPTION = "false";
      seen = [];
      await getPool().query(`UPDATE server_bots SET tools = NULL WHERE id = $1`, [bot.id]);
      resetBotTriggerCacheForTests();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot e agora?" });
      await runBotRunsTick();
      text = firstPrompt()!.text;
      expect(text).not.toContain("bora jogar");
      void server;
    });

    it("asks for a voice note's transcript, waits for it without holding the queue, then answers it", async () => {
      process.env.VOICE_NOTE_TRANSCRIPTION = "true";
      const { owner, channelId, bot } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      const botMessage = (
        await getPool().query<{ id: string }>(`SELECT id FROM messages WHERE author_id = $1`, [bot.userId])
      ).rows[0]!.id;
      const note = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body, reply_to_id) VALUES ($1, $2, '', $3) RETURNING id`,
        [channelId, owner.id, botMessage],
      );
      const attachmentId = await attach(note.rows[0]!.id, channelId, owner.id, "voice");
      await getPool().query(
        `INSERT INTO message_attachment_voice (attachment_id, duration_ms, waveform) VALUES ($1, 4000, '')`,
        [attachmentId],
      );
      await maybeQueueBotReply({
        author: owner,
        channel: (await getPool().query(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0],
        messageId: note.rows[0]!.id,
        body: "",
        repliedToUserId: bot.userId,
        hasAttachments: true,
      });
      seen = [];
      await runBotRunsTick();
      // Asked for, and handed back: no model call yet, nothing posted.
      expect(seen).toHaveLength(0);
      const status = async () =>
        (await getPool().query<{ transcript_status: string }>(
          `SELECT transcript_status FROM message_attachment_voice WHERE attachment_id = $1`,
          [attachmentId],
        )).rows[0]!.transcript_status;
      expect(await status()).toBe("pending");
      const waiting = await getPool().query<{ status: string; outcome: string; attempts: number }>(
        `SELECT status, outcome, attempts FROM server_bot_runs WHERE message_id = $1`,
        [note.rows[0]!.id],
      );
      expect(waiting.rows[0]).toEqual({ status: "running", outcome: "waiting-transcript", attempts: 0 });

      // The worker answers; the lease runs out; the next tick answers the note.
      await getPool().query(
        `UPDATE message_attachment_voice SET transcript_status = 'done', transcript_text = 'cria um canal de voz'
          WHERE attachment_id = $1`,
        [attachmentId],
      );
      await getPool().query(`UPDATE server_bot_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE message_id = $1`, [
        note.rows[0]!.id,
      ]);
      script = () => ({ text: "Qual nome?" });
      await runBotRunsTick();
      expect(firstPrompt()!.text).toContain('[voice note, 4s, transcribed: "cria um canal de voz"]');
      expect((await botReplies(bot.userId)).at(-1)).toBe("Qual nome?");
    });

    it("takes a voice note alone as a follow-up", async () => {
      const { owner, channelId, bot } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      const voiceOnly = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, '') RETURNING id`,
        [channelId, owner.id],
      );
      const queued = await maybeQueueBotReply({
        author: owner,
        channel: (await getPool().query(`SELECT * FROM channels WHERE id = $1`, [channelId])).rows[0],
        messageId: voiceOnly.rows[0]!.id,
        body: "",
        repliedToUserId: null,
        hasAttachments: true,
      });
      expect(queued).toBe(true);
      void bot;
    });
  });

  describe("asking back", () => {
    const askCard = async (botUserId: string) =>
      (
        await getPool().query<{ id: string; bot_card: Record<string, unknown> }>(
          `SELECT id, bot_card FROM messages WHERE author_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [botUserId],
        )
      ).rows[0]!;

    it("posts a question with buttons, and only the member who asked can answer it, once", async () => {
      const { owner, member, channelId, bot } = await setup();
      script = () => {
        if (seen.length === 1) {
          return {
            calls: [
              { name: "create_channel", input: { name: "x", type: "text" } },
              { name: "ask_member", input: { question: "Texto ou voz?", options: ["Texto", "Voz", "Texto"] } },
            ],
          };
        }
        return { text: "Beleza, voz então." };
      };
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot cria um canal" });
      await runBotRunsTick();
      const asked = await askCard(bot.userId);
      expect(asked.bot_card).toMatchObject({ kind: "ask", lead: "Texto ou voz?", options: ["Texto", "Voz"], state: null });
      expect((await getPool().query(`SELECT 1 FROM server_bot_plans`)).rowCount).toBe(0);

      const answer = (user: typeof owner, option: number) =>
        answerBotAsk({ messageId: asked.id, user: user as never, option });
      expect(await answer(member, 0)).toBe("not-yours");
      expect(await answer(owner, 3)).toBe("missing");
      expect(await answer(owner, 1)).toBe("answered");
      expect(await answer(owner, 0)).toBe("decided");
      expect((await askCard(bot.userId)).bot_card).toMatchObject({ state: "answered", answer: 1 });

      // Nothing is posted for the member: the card says what they picked.
      const posted = await getPool().query(`SELECT body FROM messages WHERE author_id = $1`, [owner.id]);
      expect(posted.rows).toEqual([{ body: "@caio_bot cria um canal" }]);
      const run = await getPool().query<{ trigger: string; requester_id: string }>(
        `SELECT trigger, requester_id FROM server_bot_runs WHERE message_id = $1`,
        [asked.id],
      );
      expect(run.rows).toEqual([{ trigger: "answer", requester_id: owner.id }]);
      await runBotRunsTick();
      // The model learns the answer from the card, in the transcript and the ask.
      const prompt = (seen.at(-1)!.messages[0] as { text: string }).text;
      expect(prompt).toMatch(/\[buttons: "Texto" \| "Voz"; @\S+ picked "Voz"\]/);
      expect(prompt).toContain('by pressing "Voz"');
      const reply = await getPool().query<{ body: string; reply_to_id: string }>(
        `SELECT body, reply_to_id FROM messages WHERE author_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [bot.userId],
      );
      expect(reply.rows[0]).toEqual({ body: "Beleza, voz então.", reply_to_id: asked.id });
    });

    it("refuses an answer after the question ran out", async () => {
      const { owner, channelId, bot } = await setup();
      script = (_input, turn) =>
        turn === 0 ? { calls: [{ name: "ask_member", input: { question: "Qual?", options: ["A", "B"] } }] } : { text: "ok" };
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot faz aquilo" });
      await runBotRunsTick();
      const asked = await askCard(bot.userId);
      await getPool().query(
        `UPDATE messages SET bot_card = jsonb_set(bot_card, '{expiresAt}', to_jsonb((NOW() - INTERVAL '1 minute')::text)) WHERE id = $1`,
        [asked.id],
      );
      expect(await answerBotAsk({ messageId: asked.id, user: owner as never, option: 0 })).toBe("expired");
    });
  });

  it("answers a second question after the first, and drops a third", async () => {
    const { owner, channelId, bot } = await setup();
    let calls = 0;
    script = () => ({ text: `Resposta ${++calls}` });
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot primeira" });
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot segunda" });
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot terceira" });
    expect((await getPool().query(`SELECT 1 FROM server_bot_runs`)).rowCount).toBe(2);
    await runBotRunsTick();
    expect(await botReplies(bot.userId)).toEqual(["Resposta 1"]);
    await runBotRunsTick();
    expect(await botReplies(bot.userId)).toEqual(["Resposta 1", "Resposta 2"]);
    const second = seen.at(-1)!.messages[0]!;
    expect(second.role === "user" && second.text).toContain("Resposta 1");
  });

  describe("follow-ups", () => {
    const followUps = async () =>
      (await getPool().query<{ status: string; outcome: string | null }>(
        `SELECT status, outcome FROM server_bot_runs WHERE follow_up ORDER BY created_at`,
      )).rows;

    it("answers the next message from the member it just answered, without a mention", async () => {
      const { owner, channelId, bot } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      script = () => ({ text: "Tem 3 canais." });
      await postChannelMessage({ author: owner, channelId, body: "quantos canais tem?" });
      await runBotRunsTick();
      expect(await followUps()).toEqual([{ status: "done", outcome: "posted" }]);
      expect((await botReplies(bot.userId)).at(-1)).toBe("Tem 3 canais.");
      const prompt = seen.at(-1)!.messages[0]!;
      expect(prompt.role === "user" && prompt.text).toContain("did not mention you");
    });

    it("is not a follow-up from somebody else, or aimed at somebody else", async () => {
      const { owner, member, channelId } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      await postChannelMessage({ author: member, channelId, body: "e aí gente" });
      await postChannelMessage({ author: owner, channelId, body: "@bia bora jogar?" });
      expect(await followUps()).toEqual([]);
    });

    it("stays quiet on SKIP, and that closes the window", async () => {
      const { owner, channelId, bot } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      script = () => ({ text: "SKIP" });
      await postChannelMessage({ author: owner, channelId, body: "valeu" });
      await runBotRunsTick();
      expect(await followUps()).toEqual([{ status: "skipped", outcome: "not-for-me" }]);
      expect(await botReplies(bot.userId)).toHaveLength(1);
      await postChannelMessage({ author: owner, channelId, body: "bora jogar então" });
      expect(await followUps()).toHaveLength(1);
    });

    it("closes three minutes after the answer", async () => {
      const { owner, channelId } = await setup();
      await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      await getPool().query(`UPDATE server_bot_runs SET finished_at = NOW() - INTERVAL '4 minutes'`);
      await postChannelMessage({ author: owner, channelId, body: "e agora?" });
      expect(await followUps()).toEqual([]);
    });
  });

  it("starts with moderation off, and never offers or runs a tool switched off", async () => {
    expect(SERVER_BOT_DEFAULT_TOOLS).not.toContain("ban_member");
    expect(SERVER_BOT_DEFAULT_TOOLS).toContain("create_channel");
    const { owner, server, channelId, oldId, bot } = await setup();
    const { updateServerBot } = await import("./bots.js");
    await updateServerBot({
      serverId: server.id,
      botId: bot.id,
      tools: SERVER_BOT_TOOLS.filter((tool) => tool !== "delete_channel"),
    });
    script = (_input, turn) =>
      turn === 0 ? { calls: [{ name: "delete_channel", input: { channelId: oldId } }] } : { text: "Não posso." };
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot apaga o #velho" });
    await runBotRunsTick();
    expect(seen[0]!.tools?.map((tool) => tool.name)).not.toContain("delete_channel");
    expect(seen[0]!.system).toContain("delete_channel (switched off");
    expect((await getPool().query(`SELECT 1 FROM server_bot_plans`)).rowCount).toBe(0);
    expect(await channelNamed(server.id, "velho")).toBe(1);
  });

  describe("plan card buttons", () => {
    async function stagedDelete() {
      const ctx = await setup();
      script = (_input, turn) =>
        turn === 0 ? { calls: [{ name: "delete_channel", input: { channelId: ctx.oldId } }] } : { text: "Posso apagar." };
      await postChannelMessage({ author: ctx.owner, channelId: ctx.channelId, body: "@caio_bot apaga o #velho" });
      await runBotRunsTick();
      const plan = await getPool().query<{ id: string; message_id: string }>(`SELECT id, message_id FROM server_bot_plans`);
      return { ...ctx, planId: plan.rows[0]!.id, planMessageId: plan.rows[0]!.message_id };
    }
    const cardOf = async (messageId: string) =>
      (await getPool().query<{
        bot_card: { state: string | null; planId: string | null; items: Array<{ status: string }> };
      }>(
        `SELECT bot_card FROM messages WHERE id = $1`,
        [messageId],
      )).rows[0]!.bot_card;

    it("confirms once, for the member who asked, and marks the card", async () => {
      const { queuePlanDecision } = await import("./bots.js");
      const { owner, member, server, bot, planId, planMessageId } = await stagedDelete();
      expect((await cardOf(planMessageId)).planId).toBe(planId);

      expect(await queuePlanDecision({ planId, userId: member.id, decision: "yes" })).toBe("not-yours");
      expect(await queuePlanDecision({ planId, userId: owner.id, decision: "yes" })).toBe("queued");
      expect(await queuePlanDecision({ planId, userId: owner.id, decision: "no" })).toBe("decided");
      await runBotRunsTick();

      expect(await channelNamed(server.id, "velho")).toBe(0);
      // The plan finishes on its own card: no second message from the bot.
      const card = await cardOf(planMessageId);
      expect(card.state).toBe("confirmed");
      expect(card.items.map((item) => item.status)).toEqual(["ok"]);
      const latest = await getPool().query<{ id: string; body: string }>(
        `SELECT id, body FROM messages WHERE author_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [bot.userId],
      );
      expect(latest.rows[0]!.id).toBe(planMessageId);
      expect(latest.rows[0]!.body).toContain("Resultado:");
      expect(await queuePlanDecision({ planId, userId: owner.id, decision: "yes" })).toBe("decided");
    });

    it("cancels quietly from the button: the card says it", async () => {
      const { queuePlanDecision } = await import("./bots.js");
      const { owner, server, bot, planId, planMessageId } = await stagedDelete();
      expect(await queuePlanDecision({ planId, userId: owner.id, decision: "no" })).toBe("queued");
      await runBotRunsTick();
      expect(await channelNamed(server.id, "velho")).toBe(1);
      expect((await cardOf(planMessageId)).state).toBe("cancelled");
      expect(await botReplies(bot.userId)).toHaveLength(1);
    });
  });
});

