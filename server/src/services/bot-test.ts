import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { botCostMicros, getBotProvider } from "./bot-llm.js";
import { buildSystemPrompt, reserveSpend, sanitizeBotReply, settleSpend } from "./bot-runner.js";
import { botDay } from "./bot-stats.js";

/**
 * The wizard's practice chat: a few messages with a bot that does not exist
 * yet, so staff hear its voice before they create it. The same system prompt
 * as a real reply, no tools, no channel. Each turn is a paid model call, so
 * a person gets a few a day and the deployment's dollar ceiling still holds.
 */

export function botTestTurnsPerDay(): number {
  const raw = Number(process.env.BOTS_TEST_TURNS_PER_MEMBER_DAY);
  return Number.isInteger(raw) && raw >= 0 ? raw : 20;
}

const MAX_OUTPUT_TOKENS = 400;

export type BotTestResult =
  | { ok: true; reply: string; turnsLeft: number }
  | { ok: false; reason: "limit" | "budget" | "no-provider" | "model-error" };

export async function runBotTestTurn(input: {
  userId: string;
  serverName: string;
  name: string;
  persona: string;
  knowledge: string;
  model: string | null;
  messages: Array<{ from: "member" | "bot"; text: string }>;
}): Promise<BotTestResult> {
  const provider = getBotProvider(input.model);
  if (!provider) {
    return { ok: false, reason: "no-provider" };
  }
  const day = botDay();
  const limit = botTestTurnsPerDay();
  const reserved = await getPool().query<{ turns: number }>(
    `INSERT INTO server_bot_test_usage AS u (day, user_id, turns)
     SELECT $1::date, $2, 1 WHERE $3::int > 0
     ON CONFLICT (day, user_id) DO UPDATE SET turns = u.turns + 1 WHERE u.turns < $3::int
     RETURNING turns`,
    [day, input.userId, limit],
  );
  const used = reserved.rows[0]?.turns;
  if (used === undefined) {
    return { ok: false, reason: "limit" };
  }
  const giveBack = () =>
    getPool().query(
      `UPDATE server_bot_test_usage SET turns = GREATEST(turns - 1, 0) WHERE day = $1::date AND user_id = $2`,
      [day, input.userId],
    );

  const system = buildSystemPrompt({
    botName: input.name,
    botUsername: null,
    serverName: input.serverName,
    persona: input.persona,
    knowledge: input.knowledge,
    unavailable: ["every tool (this is a practice chat in the setup wizard; nothing can be done on the server)"],
  });
  const transcript = input.messages
    .map((message) => `${message.from === "member" ? "Member" : input.name}: ${message.text}`)
    .join("\n");
  const prompt = [
    "<conversation channel=\"#teste\">",
    transcript,
    "</conversation>",
    "",
    "This is the staff trying you out before you join the server. Reply to the last member message.",
  ].join("\n");
  const estimate = botCostMicros({
    model: provider.model,
    inputTokens: Math.ceil((system.length + prompt.length) / 3),
    outputTokens: MAX_OUTPUT_TOKENS,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  if (!(await reserveSpend(day, estimate))) {
    await giveBack();
    return { ok: false, reason: "budget" };
  }
  try {
    const completion = await provider.complete({
      system,
      messages: [{ role: "user", text: prompt }],
      maxTokens: MAX_OUTPUT_TOKENS,
    });
    await settleSpend(day, estimate, botCostMicros(completion));
    const reply = sanitizeBotReply(completion.text ?? "").trim();
    return { ok: true, reply, turnsLeft: Math.max(0, limit - used) };
  } catch (error) {
    await settleSpend(day, estimate, 0);
    await giveBack();
    logEvent("bots.testError", { message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return { ok: false, reason: "model-error" };
  }
}
