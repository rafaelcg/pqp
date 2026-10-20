import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server bots end to end on a real Postgres: the trigger in the send path,
 * the queue, the caps and the post. The model is a stub; everything around
 * it is the production code.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer: createPqpServer, createChannel } = await import("./servers.js");
const { listRoles, upsertChannelOverwrite } = await import("./roles.js");
const { Permission } = await import("@pqp/shared");
const {
  createServerBot,
  foldForMatch,
  resetBotTriggerCacheForTests,
  saysName,
  setBotNoticeSinkForTests,
  updateServerBot,
} = await import("./bots.js");
const { runBotRunsTick, sanitizeBotReply } = await import("./bot-runner.js");
const { setBotProviderForTests, botModelChoices, getBotProvider } = await import("./bot-llm.js");
const { postChannelMessage, resetChatRateLimits } = await import("../ws/chat.js");

const ENV_KEYS = [
  "CUSTOM_BOTS",
  "BOTS_REPLIES_PER_SERVER_DAY",
  "BOTS_MAX_USD_PER_DAY",
  "BOTS_RUNS_PER_MEMBER_HOUR",
] as const;

describe("saysName", () => {
  const julius = foldForMatch("Július");
  it("matches the name as a word, any case or accent", () => {
    expect(saysName("Julius, que horas?", julius)).toBe(true);
    expect(saysName("valeu JULIUS!", julius)).toBe(true);
    expect(saysName("oi julius", julius)).toBe(true);
  });
  it("does not match inside another word", () => {
    expect(saysName("juliusmente", julius)).toBe(false);
    expect(saysName("o mrjulius chegou", julius)).toBe(false);
  });
  it("matches a two-word name", () => {
    expect(saysName("ei seu ajudante, me ajuda", foldForMatch("Seu Ajudante"))).toBe(true);
  });
});

describe("dropMention", () => {
  it("takes the member being answered out of the text", async () => {
    const { dropMention } = await import("./bot-runner.js");
    expect(dropMention("Eae, @rafa! Tudo certo.", "rafa")).toBe("Eae! Tudo certo.");
    expect(dropMention("Não sei te dizer, @rafa.", "rafa")).toBe("Não sei te dizer.");
    expect(dropMention("@rafa, tem 5 canais.", "rafa")).toBe("Tem 5 canais.");
    expect(dropMention("Pergunta pro @bia.", "rafa")).toBe("Pergunta pro @bia.");
    expect(dropMention("Fala com @rafael", "rafa")).toBe("Fala com @rafael");
  });
});

describe("sanitizeBotReply", () => {
  it("defuses @everyone, @here and a crowd of mentions", () => {
    const out = sanitizeBotReply("@everyone oi @here @a1 @b2 @c3 @d4 @a1");
    expect(out).not.toMatch(/(^|[^＠])@everyone/);
    expect(out).toContain("＠everyone");
    expect(out).toContain("＠here");
    expect(out).toContain("@a1 @b2 @c3 ＠d4 @a1");
  });

  it("caps the length", () => {
    expect(sanitizeBotReply("x".repeat(5000)).length).toBeLessThanOrEqual(1900);
  });
});

describe("botModelChoices", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers free models in dev and never in production", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
    vi.stubEnv("BOTS_MODEL_CHOICES", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(botModelChoices().map((c) => c.id)).toContain("openrouter:google/gemma-4-31b-it:free");

    vi.stubEnv("NODE_ENV", "production");
    expect(botModelChoices().map((c) => c.id)).toEqual(["anthropic:claude-haiku-5-5"]);
    // Named explicitly by the operator: still refused.
    vi.stubEnv("BOTS_MODEL_CHOICES", "openrouter:openrouter/free=Free;anthropic:claude-haiku-5-5=Haiku");
    expect(botModelChoices().map((c) => c.id)).toEqual(["anthropic:claude-haiku-5-5"]);
    // A bot saved with a free model answers with the default instead.
    expect(getBotProvider("openrouter:openrouter/free")?.model).toBe("claude-haiku-5-5");
  });
});

describeDb("server bots", () => {
  let calls = 0;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    setBotProviderForTests(null);
    await closePool();
  });

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.CUSTOM_BOTS = "true";
    delete process.env.BOTS_REPLIES_PER_SERVER_DAY;
    delete process.env.BOTS_MAX_USD_PER_DAY;
    delete process.env.BOTS_RUNS_PER_MEMBER_HOUR;
    calls = 0;
    setBotProviderForTests({
      name: "fixture",
      model: "claude-haiku-5-5",
      async complete() {
        calls += 1;
        const text = "Oi! Sou um bot. @everyone";
        return {
          text,
          toolCalls: [],
          message: { role: "assistant", text, toolCalls: [], raw: [] },
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
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, message_mentions, channel_reads,
                server_bots, server_bot_runs, server_bot_usage_daily, server_bot_spend_daily
       RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function setup() {
    const owner = await upsertUser({ clerkId: "owner", displayName: "Rafa", avatarUrl: null });
    const { server, channels } = await createPqpServer("QG", owner.id);
    const channelId = channels.find((c) => c.type === "text")!.id;
    const other = await createChannel(server.id, "outro", "text");
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name: "Caio",
      persona: "",
      knowledge: "O servidor abre às 20h.",
      channelIds: [channelId],
    });
    return { owner, server, channelId, otherChannelId: other.id, bot };
  }

  const runs = async () =>
    (
      await getPool().query<{ status: string; outcome: string | null }>(
        `SELECT status, outcome FROM server_bot_runs ORDER BY created_at`,
      )
    ).rows;

  const botMessages = async (botUserId: string) =>
    (
      await getPool().query<{ body: string; reply_to_id: string | null }>(
        `SELECT body, reply_to_id FROM messages WHERE author_id = $1`,
        [botUserId],
      )
    ).rows;

  it("gives the bot a handle with a _bot suffix and a membership", async () => {
    const { bot, server } = await setup();
    expect(bot.username).toBe("caio_bot");
    const member = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [server.id, bot.userId],
    );
    expect(member.rowCount).toBe(1);
  });

  it("answers a mention once, as a reply, with @everyone defused", async () => {
    const { owner, channelId, bot } = await setup();
    const sent = await postChannelMessage({ author: owner, channelId, body: "@caio_bot que horas abre?" });
    expect(sent.ok).toBe(true);
    expect(await runs()).toEqual([{ status: "queued", outcome: null }]);

    await runBotRunsTick();
    expect(calls).toBe(1);
    const posted = await botMessages(bot.userId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("＠everyone");
    expect(posted[0]!.reply_to_id).toBe(sent.ok ? sent.message.id : null);
    expect(await runs()).toEqual([{ status: "done", outcome: "posted" }]);
  });

  it("shows the model the message that called it, last", async () => {
    const prompts: string[] = [];
    setBotProviderForTests({
      name: "fixture",
      model: "claude-haiku-5-5",
      async complete(input) {
        const first = input.messages[0];
        prompts.push(first?.role === "user" ? first.text : "");
        return {
          text: "ok",
          toolCalls: [],
          message: { role: "assistant", text: "ok", toolCalls: [], raw: [] },
          reportedCostMicros: null,
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-haiku-5-5",
          stopReason: "end_turn",
        };
      },
    });
    const { owner, channelId } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "antes" });
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot a pergunta" });
    await runBotRunsTick();
    const lines = prompts[0]!.split("\n");
    expect(lines[lines.indexOf("</conversation>") - 1]).toContain("@caio_bot a pergunta");
    expect(prompts[0]).toContain("antes");
  });

  it("answers a reply to its own message", async () => {
    const { owner, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    await runBotRunsTick();
    const [first] = await getPool().query<{ id: string }>(
      `SELECT id FROM messages WHERE author_id = $1`,
      [bot.userId],
    ).then((r) => r.rows);
    await postChannelMessage({ author: owner, channelId, body: "e amanhã?", replyToId: first!.id });
    await runBotRunsTick();
    expect(await botMessages(bot.userId)).toHaveLength(2);
  });

  it("ignores messages that do not call it, other channels, and the flag off", async () => {
    const { owner, channelId, otherChannelId } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "ninguém chamou o bot" });
    await postChannelMessage({ author: owner, channelId: otherChannelId, body: "@caio_bot oi" });
    process.env.CUSTOM_BOTS = "false";
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi de novo" });
    expect(await runs()).toEqual([]);
  });

  it("stays quiet when switched off after the run was queued", async () => {
    const { owner, server, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    await updateServerBot({ serverId: server.id, botId: bot.id, enabled: false });
    await runBotRunsTick();
    expect(calls).toBe(0);
    expect(await runs()).toEqual([{ status: "skipped", outcome: "off" }]);
  });

  it("posts once when a run is claimed again after its lease ran out", async () => {
    const { owner, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    await runBotRunsTick();
    // Pretend the first worker's lease expired mid-call and another took it.
    await getPool().query(
      `UPDATE server_bot_runs
          SET status = 'running', leased_by = 'someone-else', lease_expires_at = NOW() - INTERVAL '1 second'`,
    );
    await runBotRunsTick();
    // The second claim finds the first copy by its nonce and pays nothing.
    expect(calls).toBe(1);
    expect(await botMessages(bot.userId)).toHaveLength(1);
    expect(await runs()).toEqual([{ status: "done", outcome: "posted-earlier" }]);
  });

  it("refuses past the server's daily replies", async () => {
    process.env.BOTS_REPLIES_PER_SERVER_DAY = "1";
    const { owner, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot um" });
    await runBotRunsTick();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot dois" });
    await runBotRunsTick();
    expect(calls).toBe(1);
    expect(await botMessages(bot.userId)).toHaveLength(1);
    expect((await runs()).map((r) => r.outcome).sort()).toEqual(["posted", "server-cap"]);
  });

  it("refuses past the deployment's daily dollar ceiling and gives the reply back", async () => {
    process.env.BOTS_MAX_USD_PER_DAY = "0";
    const { owner, server, channelId } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    await runBotRunsTick();
    expect(calls).toBe(0);
    expect(await runs()).toEqual([{ status: "skipped", outcome: "global-cap" }]);
    const usage = await getPool().query<{ replies: number }>(
      `SELECT replies FROM server_bot_usage_daily WHERE server_id = $1`,
      [server.id],
    );
    expect(usage.rows[0]?.replies ?? 0).toBe(0);
  });

  it("never sends a channel it cannot read to the model", async () => {
    const { owner, server, channelId, bot } = await setup();
    const everyone = (await listRoles(server.id)).find((role) => role.is_everyone)!;
    await upsertChannelOverwrite(channelId, server.id, "role", everyone.id, 0n, Permission.VIEW_CHANNEL);
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot segredo" });
    await runBotRunsTick();
    expect(calls).toBe(0);
    expect(await botMessages(bot.userId)).toHaveLength(0);
    expect(await runs()).toEqual([{ status: "skipped", outcome: "no-access" }]);
  });

  async function joinMember(serverId: string) {
    const member = await upsertUser({ clerkId: "member", displayName: "Bia", avatarUrl: null });
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    return member;
  }

  describe("limits", () => {
    let notices: Array<{ reason: string; userId: string; limit: number | null; retryAt: string | null }> = [];
    beforeEach(() => {
      notices = [];
      setBotNoticeSinkForTests((frame, userId) =>
        notices.push({ reason: frame.reason, userId, limit: frame.limit, retryAt: frame.retryAt }),
      );
    });
    afterEach(() => setBotNoticeSinkForTests(null));

    it("queues two open questions per member, a few per hour, and says why it stopped", async () => {
      process.env.BOTS_RUNS_PER_MEMBER_HOUR = "3";
      const { server, channelId } = await setup();
      const member = await joinMember(server.id);
      await postChannelMessage({ author: member, channelId, body: "@caio_bot um" });
      await postChannelMessage({ author: member, channelId, body: "@caio_bot dois" });
      await postChannelMessage({ author: member, channelId, body: "@caio_bot spam" });
      expect(await runs()).toHaveLength(2);
      expect(notices).toEqual([{ reason: "busy", userId: member.id, limit: null, retryAt: null }]);
      await runBotRunsTick();
      await runBotRunsTick();
      await postChannelMessage({ author: member, channelId, body: "@caio_bot três" });
      await runBotRunsTick();
      await postChannelMessage({ author: member, channelId, body: "@caio_bot quatro" });
      expect(await runs()).toHaveLength(3);
      expect(calls).toBe(3);
      const last = notices.at(-1)!;
      expect(last).toMatchObject({ reason: "member-hour", userId: member.id, limit: 3 });
      const waitMs = new Date(last.retryAt!).getTime() - Date.now();
      expect(waitMs).toBeGreaterThan(55 * 60_000);
      expect(waitMs).toBeLessThanOrEqual(60 * 60_000);
    });

    it("has no hourly limit for the owner", async () => {
      process.env.BOTS_RUNS_PER_MEMBER_HOUR = "1";
      const { owner, channelId } = await setup();
      for (const body of ["@caio_bot um", "@caio_bot dois", "@caio_bot três"]) {
        await postChannelMessage({ author: owner, channelId, body });
        await runBotRunsTick();
      }
      expect(calls).toBe(3);
      expect(notices).toEqual([]);
    });

    it("says nothing about a follow-up outside its window", async () => {
      process.env.BOTS_RUNS_PER_MEMBER_HOUR = "1";
      const { server, channelId } = await setup();
      const member = await joinMember(server.id);
      await postChannelMessage({ author: member, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      await getPool().query(`UPDATE server_bot_runs SET finished_at = NOW() - INTERVAL '10 minutes'`);
      await postChannelMessage({ author: member, channelId, body: "bora jogar" });
      expect(notices).toEqual([]);
    });

    it("tells the member when the server used its answers for the day", async () => {
      process.env.BOTS_REPLIES_PER_SERVER_DAY = "1";
      const { server, channelId } = await setup();
      const member = await joinMember(server.id);
      await postChannelMessage({ author: member, channelId, body: "@caio_bot oi" });
      await runBotRunsTick();
      await postChannelMessage({ author: member, channelId, body: "@caio_bot de novo" });
      await runBotRunsTick();
      expect(notices).toEqual([
        expect.objectContaining({ reason: "server-day", userId: member.id, limit: 1 }),
      ]);
    });
  });

  it("moves the handle with a rename, and answers to the new one", async () => {
    const { owner, server, channelId, bot } = await setup();
    const updated = await updateServerBot({ serverId: server.id, botId: bot.id, name: "Julius" });
    expect(updated?.renamed).toBe(true);
    expect(updated?.bot.username).toBe("julius_bot");
    await postChannelMessage({ author: owner, channelId, body: "@caio_bot oi" });
    expect(await runs()).toHaveLength(0);
    await postChannelMessage({ author: owner, channelId, body: "@julius_bot oi" });
    expect(await runs()).toHaveLength(1);
  });

  it("keeps the _bot suffix on a long name", async () => {
    const owner = await upsertUser({ clerkId: "o2", displayName: "Ana", avatarUrl: null });
    const { server } = await createPqpServer("Outro", owner.id);
    const bot = await createServerBot({
      serverId: server.id,
      createdBy: owner.id,
      name: "Assistente Oficial do Servidor Grande",
      persona: "",
      knowledge: "",
      channelIds: [],
    });
    expect(bot.username.endsWith("_bot")).toBe(true);
    expect(bot.username.length).toBeLessThanOrEqual(32);
  });

  it("answers its plain name only when the option is on", async () => {
    const { owner, server, channelId, bot } = await setup();
    await postChannelMessage({ author: owner, channelId, body: "Caio, que horas abre?" });
    expect(await runs()).toHaveLength(0);
    await updateServerBot({ serverId: server.id, botId: bot.id, answerToName: true });
    await postChannelMessage({ author: owner, channelId, body: "Caio, que horas abre?" });
    expect(await runs()).toHaveLength(1);
  });
});
