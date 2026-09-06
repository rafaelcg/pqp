#!/usr/bin/env node
/**
 * The QG support bot.
 *
 * Answers product questions in the QG do pqp, from `facts.md` and from nothing
 * else, and says it does not know the rest of the time.
 *
 *   node src/bot.js --ask "tem como aumentar a qualidade da tela?" --canned
 *   node src/bot.js --ask "..."                       one question, no network, live model
 *   node src/bot.js --ask "..." --unprompted          the same, through the no-mention path
 *   node src/bot.js --watch --canned                  connected, fixture answers
 *   node src/bot.js --watch                           the real thing
 *
 * It speaks in three situations and no others: somebody addressed it (a mention
 * or a reply, `trigger.js`), a newcomer said hello (`greetings.js`), or a
 * question was put to a watched channel and NOBODY ANSWERED IT for about three
 * minutes (`pending.js`). The third one is the only thing it does that is not a
 * direct response to somebody engaging with it, it is fenced by seven
 * conditions and a confidence gate, and its own file argues the case.
 *
 * ── WHY A SIBLING OF tools/ambient AND NOT A MODE INSIDE IT ─────────────────
 *
 * They share plumbing and share nothing else, and the thing they do not share
 * is a decision that has already been made once, in writing, in
 * `server/scripts/qg.config.mjs`: the QG has no AI cast, deliberately, and
 * keeping it out of `personas.yaml` is called out there as the safest way to
 * stop somebody adding one by editing the wrong block. Making this a mode of
 * the ambient runner would put the QG back into that file's blast radius, which
 * is the one outcome worth spending a directory to avoid.
 *
 * The rest follows from that. The ambient runner's core loop is a scheduler
 * that decides when to speak on a CADENCE, out of nothing; this bot has no
 * scheduler at all, and even the one thing it says that nobody asked it for
 * (`pending.js`) is triggered by a specific message from a specific person that
 * a specific room failed to answer. Sharing a scheduler would mean maintaining
 * the property "this cadence must never apply to that account" forever. Their
 * defaults are opposites: the cast never discloses and improvises everything,
 * this account always discloses and improvises nothing. They need separate kill
 * switches, because "stop the personas" and "stop support" are different
 * operational decisions. And `loadCommunities` refuses a community with fewer
 * than two personas, so fitting one bot into that config would mean loosening a
 * validation that protects scene generation.
 *
 * What IS reused is everything that touches the wire, unchanged and by import:
 * `pqp-client.js` (the real HTTP + `/ws` protocol client), `identity.js`
 * (character tokens or the dev bypass), `log.js` (JSONL audit trail and the
 * kill switch), `RateCap` from `schedule.js`, and the identity screens in
 * `guardrails.js`.
 *
 * What is NOT reused is the socket's failure policy, and that is the one place
 * this bot's needs diverge from the cast's rather than merely differ. A persona
 * whose socket drops should go quiet and be re-cast next scene. This account has
 * no next scene: it connects at boot and waits to be mentioned, so a dropped
 * socket makes it permanently, silently deaf while the machine still reports
 * `started`. `src/socket.js` wraps `PqpSocket` with the reconnect the cast
 * deliberately does without, and `src/heartbeat.js` publishes the resulting
 * connection state on a timer so that "deaf" can never again look like "quiet".
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

import { PqpApi, sleep } from "../../ambient/src/pqp-client.js";
import { resolveIdentity } from "../../ambient/src/identity.js";
import { createLogger, killSwitchEngaged, engageKillSwitch } from "../../ambient/src/log.js";
import { RateCap } from "../../ambient/src/schedule.js";
import { screenInbound, disclosureLabel } from "../../ambient/src/guardrails.js";

import { loadFacts } from "./facts.js";
import { screenTrigger, SKIP } from "./trigger.js";
import { screenAnswer } from "./screen.js";
import {
  FIXED,
  cannedAnswerFor,
  fallbackAnswer,
  parseAnswer,
  parseUnpromptedAnswer,
  CONFIDENT_PREFIX,
} from "./answer.js";
import { Budget } from "./budget.js";
import { generateAnswer, estimateCostUsd, DEFAULT_MODEL } from "./generate.js";
import { ResilientSocket } from "./socket.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  Roster,
  Greeter,
  greetingsEnabled,
  NEWCOMER_WINDOW_MS,
  DEFAULT_MAX_PER_WINDOW,
} from "./greetings.js";
import {
  PendingQuestions,
  looksLikeRoomQuestion,
  screenUnprompted,
  unpromptedEnabled,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_PER_CHANNEL_HOUR,
  DEFAULT_MAX_TRIES_PER_CHANNEL_HOUR,
  DEFAULT_BUDGET_RESERVE,
} from "./pending.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * The account's disclosure mode, and it is a constant rather than a setting.
 *
 * `disclosureLabel("bot")` gives `" [bot]"` and "Conta automatizada da casa."
 * There is no code path here that produces any other value, because a support
 * bot that could be configured to stop disclosing is the thing the owner ruled
 * out. Making it a constant means the ruling is enforced by the absence of a
 * knob rather than by the default value of one.
 */
const DISCLOSURE = "bot";

/**
 * The account's name, and the reason its handle is obvious for free.
 *
 * "manual" is what this thing actually is: a fact file with a mouth. It answers
 * from a written document and says it does not know for anything outside it,
 * which is exactly what a manual does, so the name sets the right expectation
 * before anybody asks the first question. Names that promise more - assistente,
 * sabetudo - promise the one thing this bot is built NOT to do.
 *
 * What makes it work as a BOT name is `deriveHandle`: the username is slugified
 * from the DISPLAY name, and the display name permanently carries
 * `disclosureLabel("bot").suffix`. So "manual [bot]" becomes `@manual_bot`, and
 * nobody can type the mention without typing the word bot.
 *
 * That is the disclosure suffix doing a second job nobody designed it for, and
 * it is worth naming: any future rename that keeps the suffix keeps the
 * disclosure in the handle, and one that drops the suffix cannot happen here,
 * because there is no code path that produces a disclosure other than "bot".
 */
const BOT_NAME = "manual";

/** How long the bot waits before answering. See `HUMAN_LATENCY` below. */
const MIN_LATENCY_MS = 1200;

function parseArgs(argv) {
  const args = {
    watch: argv.includes("--watch"),
    canned: argv.includes("--canned"),
    dryRun: argv.includes("--dry-run"),
    /** `--ask --unprompted`: run the question through the no-mention path. */
    askUnprompted: argv.includes("--unprompted"),
    ask: valueOf(argv, "--ask") ?? null,
    facts: valueOf(argv, "--facts") ?? process.env.SUPPORT_FACTS ?? join(ROOT, "facts.md"),
    apiUrl: process.env.PQP_API_URL ?? "http://127.0.0.1:3001",
    wsUrl: process.env.PQP_WS_URL ?? null,
    devToken: process.env.SUPPORT_DEV_TOKEN ?? "dev-local-token",
    tokensFile: valueOf(argv, "--tokens") ?? process.env.SUPPORT_TOKENS_FILE ?? null,
    /** The persona id the token file is keyed by, and the dev-bypass suffix. */
    botId: process.env.SUPPORT_BOT_ID ?? "manual_bot",
    serverName: valueOf(argv, "--server") ?? process.env.SUPPORT_SERVER ?? "QG do pqp",
    channels: (valueOf(argv, "--channels") ?? process.env.SUPPORT_CHANNELS ?? "ajuda")
      .split(",")
      .map((c) => c.trim().replace(/^#/, ""))
      .filter(Boolean),
    ownerHandle: process.env.SUPPORT_OWNER_HANDLE ?? "rafa",
    stateDir: valueOf(argv, "--state-dir") ?? process.env.SUPPORT_STATE_DIR ?? join(ROOT, "state"),
    /**
     * Answering a newcomer's hello. See `greetings.js` for the whole design;
     * the knobs are here so an operator can find every one of them in one
     * place. The channel is a NAME, resolved against the same server as the
     * answer channels, never an id in code. A missing channel disables the
     * feature with a logged line rather than refusing to boot: the hellos are
     * secondary, and their misconfiguration must not take support down.
     */
    greetings: {
      enabled: greetingsEnabled(process.env),
      channel: (valueOf(argv, "--greeting-channel") ?? process.env.SUPPORT_GREETING_CHANNEL ?? "geral")
        .trim()
        .replace(/^#/, ""),
      newcomerWindowMs: num(process.env.SUPPORT_NEWCOMER_WINDOW_MS, NEWCOMER_WINDOW_MS),
      maxPerTenMinutes: num(process.env.SUPPORT_GREETING_MAX_PER_10MIN, DEFAULT_MAX_PER_WINDOW),
      /**
       * How often the member roster is re-read. This is the resolution of "how
       * long ago did they join", so it stays well under the fifteen-minute
       * window. One GET a minute against an endpoint the app calls every time
       * a member list opens.
       */
      memberPollMs: num(process.env.SUPPORT_MEMBER_POLL_MS, 60_000),
    },
    /**
     * Answering a question the room dropped. See `pending.js` for the whole
     * design and for why each of these numbers is what it is. They are here so
     * an operator can find every knob for this behaviour in one place, and
     * every one of them is an environment variable rather than a constant so
     * that turning it down, or off, is a `fly secrets set` and not a deploy.
     */
    unprompted: {
      enabled: unpromptedEnabled(process.env),
      delayMs: num(process.env.SUPPORT_UNPROMPTED_DELAY_MS, DEFAULT_DELAY_MS),
      maxAgeMs: num(process.env.SUPPORT_UNPROMPTED_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
      maxPerChannelPerHour: num(
        process.env.SUPPORT_UNPROMPTED_MAX_PER_CHANNEL_HOUR,
        DEFAULT_MAX_PER_CHANNEL_HOUR,
      ),
      maxTriesPerChannelPerHour: num(
        process.env.SUPPORT_UNPROMPTED_MAX_TRIES_PER_CHANNEL_HOUR,
        DEFAULT_MAX_TRIES_PER_CHANNEL_HOUR,
      ),
      budgetReserve: num(
        process.env.SUPPORT_UNPROMPTED_BUDGET_RESERVE,
        DEFAULT_BUDGET_RESERVE,
      ),
    },
    limits: {
      maxPerUserPerHour: num(process.env.SUPPORT_MAX_PER_USER_HOUR, 6),
      maxPerChannelPerHour: num(process.env.SUPPORT_MAX_PER_CHANNEL_HOUR, 12),
      maxEscalationsPerHour: num(process.env.SUPPORT_MAX_ESCALATIONS_HOUR, 4),
      cooldownMs: num(process.env.SUPPORT_COOLDOWN_MS, 8000),
      maxAnswerChars: num(process.env.SUPPORT_MAX_ANSWER_CHARS, 420),
      transcriptLines: num(process.env.SUPPORT_TRANSCRIPT_LINES, 6),
    },
    budget: {
      maxCallsPerDay: num(process.env.SUPPORT_MAX_CALLS_PER_DAY, 150),
      maxUsdPerDay: Number(process.env.SUPPORT_MAX_USD_PER_DAY ?? 1.0),
    },
    log: valueOf(argv, "--log") ?? process.env.SUPPORT_LOG ?? null,
  };
  args.wsUrl ??= args.apiUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  args.log ??= join(args.stateDir, "support.log.jsonl");
  args.escalations = join(args.stateDir, "escalations.jsonl");
  args.budgetPath = join(args.stateDir, "budget.json");
  args.rosterPath = join(args.stateDir, "greetings.json");
  return args;
}

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The kill switch, widened by one variable.
 *
 * `AMBIENT_KILL_SWITCH` is honoured unchanged, so the existing big red button
 * still means "stop every automated account in the product" - an operator
 * dealing with an incident should not have to remember that a second thing
 * exists. `SUPPORT_BOT_KILL_SWITCH` stops only this one, because "the support
 * answers are wrong, take it down" and "the personas are misbehaving" are
 * different problems that arrive on different days.
 */
function stopped() {
  const own = process.env.SUPPORT_BOT_KILL_SWITCH;
  return killSwitchEngaged() || own === "1" || own === "true";
}

/**
 * The last few lines of the channel this message is in.
 *
 * Per channel, not per process. It used to be one list, which was correct while
 * the bot watched exactly one room; watching `#ajuda` and `#geral` at once
 * makes a single list feed the answer to a question in one room with the
 * conversation from the other. That is wrong twice over: the context is
 * misleading, and it widens the injection surface to every room the bot can
 * see rather than the one the question was asked in.
 */
function recentTranscript(runtime, channelId) {
  const lines = runtime.transcripts?.get(channelId) ?? [];
  return lines.slice(-runtime.args.limits.transcriptLines);
}

/** Append to a channel's transcript, keeping it bounded. */
function rememberLine(runtime, message) {
  const lines = runtime.transcripts.get(message.channelId) ?? [];
  lines.push({
    authorName: message.authorName,
    body: String(message.body ?? "").slice(0, 300),
  });
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
  runtime.transcripts.set(message.channelId, lines);
}

/**
 * Everything between receiving a message and having a sentence to post.
 *
 * Extracted from the socket handling so the whole decision path is testable
 * with no network: `test/bot.test.js` drives this directly. The only I/O it
 * does is the model call, and `canned` removes even that.
 *
 * Returns `{ post }` with the text to send, or `{ post: null, reason }`.
 */
export async function decideReply(message, runtime) {
  const { facts, args, rateCap, budget, log, bot, seen, escalate } = runtime;
  const now = Date.now();

  const trigger = screenTrigger(message, {
    botUserId: bot.userId,
    botUsername: bot.username,
    allowedChannelIds: runtime.allowedChannelIds,
    ignoreUserIds: runtime.ignoreUserIds,
    rateCap,
    seen,
    now,
    limits: args.limits,
    dailyCallsRemaining: budget.remaining(),
    lastAnswerAt: runtime.lastAnswerAt,
  });

  if (!trigger.answer) {
    // NOT_ADDRESSED is the overwhelmingly common case in a busy channel and
    // logging it would bury every other reason in noise. Everything else is
    // rare enough to be worth a line.
    if (trigger.reason !== SKIP.NOT_ADDRESSED && trigger.reason !== SKIP.SELF) {
      log("skip", { reason: trigger.reason, author: message.authorName });
    }
    return { post: null, reason: trigger.reason };
  }

  seen.add(message.id);

  // ── THE IDENTITY PROBE, and the reason this account exists as a bot.
  //
  // `screenInbound` is the ambient personas' screen, called with the one
  // argument they never pass. For them an identity probe is silence, because
  // their only speech is generated and there is no sentence they can improvise
  // that is neither a lie nor an unplanned product announcement. This account
  // has a fixed sentence a person wrote, so it gets `disclose: true` and posts
  // that. No model call, no chance of hedging, the same words every time.
  const inbound = screenInbound(trigger.question, { disclosure: DISCLOSURE });
  if (inbound.disclose) {
    log("answer.disclosure", { author: message.authorName });
    return { post: FIXED.DISCLOSURE, reason: "disclosure" };
  }
  if (!inbound.reply) {
    // Hostility, advice-seeking, off-platform. Silence, exactly as for the
    // personas: this bot has no more business answering "o que eu tomo pra
    // dor" than a persona does.
    log("skip", { reason: `inbound:${inbound.reason}`, author: message.authorName });
    return { post: null, reason: inbound.reason };
  }

  const canned = cannedAnswerFor(trigger.question);
  if (canned) {
    log("answer.canned", { author: message.authorName });
    return { post: canned, reason: "canned" };
  }

  let generated;
  try {
    generated = await generateAnswer({
      facts,
      question: trigger.question,
      transcript: recentTranscript(runtime, message.channelId),
      authorName: message.authorName,
      maxChars: args.limits.maxAnswerChars,
      canned: args.canned ? runtime.cannedAnswer : null,
    });
  } catch (error) {
    // A model outage must not look like an unanswerable question: escalating
    // would tell Rafael the fact file has a hole when it does not.
    log("generate.failed", { error: String(error.message) });
    return { post: null, reason: "generate-failed" };
  }

  const cost = estimateCostUsd(generated.usage, generated.model);
  if (generated.usage) {
    budget.record(cost);
  }
  log("generate", {
    model: generated.model,
    inputTokens: generated.usage?.input_tokens,
    outputTokens: generated.usage?.output_tokens,
    costUsd: Number(cost.toFixed(5)),
    budget: budget.snapshot(),
  });

  const parsed = parseAnswer(generated.text);
  if (!parsed.known) {
    return { post: escalate(message, trigger.question, parsed.reason), reason: "unknown" };
  }

  const verdict = screenAnswer(parsed.body, {
    facts,
    ownerHandle: args.ownerHandle,
    maxLength: args.limits.maxAnswerChars,
  });
  if (!verdict.ok) {
    // A screened-out answer is treated as not knowing, which is the honest
    // description of the situation: the model produced something, and the only
    // thing anybody can say about it is that it could not be published.
    log("answer.rejected", {
      reason: verdict.reason,
      detail: verdict.detail,
      body: parsed.body,
    });
    return {
      post: escalate(message, trigger.question, `screen:${verdict.reason}`),
      reason: `rejected:${verdict.reason}`,
    };
  }

  return { post: parsed.body, reason: "answered" };
}

/**
 * Everything between "the room dropped this question" and a sentence, or
 * silence.
 *
 * The counterpart of `decideReply`, and the differences between the two are the
 * whole feature. `pending.js` has already decided that this question was put to
 * the room, that nobody answered it, and that the delay has elapsed; this
 * decides whether there is anything worth saying about it.
 *
 * ── EVERY FAILURE IS SILENCE ────────────────────────────────────────────────
 *
 * There is no fallback sentence anywhere below, and that is the single most
 * important line in this function. `fallbackAnswer` exists because somebody who
 * typed `@manual_bot` is owed an answer, and "essa eu não sei responder,
 * @rafa consegue te dizer" is one. Nobody typed anything here. A bot that walks
 * into a quiet channel to announce that it cannot help has added a message and
 * no information, which is precisely the noise this feature is one bad decision
 * away from becoming. It also means no escalation ping: the questions that
 * reach Rafael are still the ones somebody asked the bot.
 *
 * Returns `{ post }` with the text to send, or `{ post: null, reason }`.
 */
export async function decideUnprompted(candidate, runtime) {
  const { facts, args, rateCap, budget, log, seen } = runtime;
  const now = Date.now();

  // Redelivery across a reconnect. Cheapest check, and it runs first for the
  // same reason it does on the mention path: answering one message twice reads
  // as a bug in the product rather than in the bot. The ledger is shared with
  // `decideReply`, so a question cannot be picked up by both paths either.
  if (seen?.has(candidate.id)) {
    return { post: null, reason: SKIP.DUPLICATE };
  }

  const gate = screenUnprompted(candidate, {
    enabled: args.unprompted.enabled,
    allowedChannelIds: runtime.allowedChannelIds,
    rateCap,
    now,
    limits: args.limits,
    unprompted: args.unprompted,
    dailyCallsRemaining: budget.remaining(),
    lastAnswerAt: runtime.lastAnswerAt,
  });
  if (!gate.answer) {
    log("unprompted.skip", {
      reason: gate.reason,
      channelId: candidate.channelId,
      question: candidate.body,
    });
    return { post: null, reason: gate.reason };
  }

  seen.add(candidate.id);

  const inbound = screenInbound(candidate.body, { disclosure: DISCLOSURE });
  if (!inbound.reply || inbound.disclose) {
    // Hostility, advice-seeking and off-platform are refused exactly as they
    // are on the mention path. The identity probe is the one that differs: a
    // `disclose` verdict means the bot HAS a fixed sentence for it, and posting
    // that sentence into a room where nobody was talking to the bot is the bot
    // introducing itself, which is the one thing this account must never do.
    // "é um bot?" typed at it still gets the plain answer, every time.
    const reason = inbound.disclose ? "identity-probe" : inbound.reason;
    log("unprompted.silent", { reason, author: candidate.authorName });
    return { post: null, reason };
  }

  // The fixed E2E sentence. Zero tokens, zero chance of a wrong word, written
  // by a person: the one answer that is as safe to volunteer as it is to give
  // when asked. It does not spend a model attempt because it does not make one.
  const canned = cannedAnswerFor(candidate.body);
  if (canned) {
    log("unprompted.answered", { reason: "canned", author: candidate.authorName });
    return { post: canned, reason: "canned" };
  }

  // An attempt is an attempt whether or not it produces a sentence, and the
  // silent outcome is the common one by design. Recorded BEFORE the call so a
  // failing upstream cannot be retried once per loop tick.
  rateCap.record(`unprompted-try:${candidate.channelId}`, now);

  let generated;
  try {
    generated = await generateAnswer({
      facts,
      question: candidate.body,
      transcript: recentTranscript(runtime, candidate.channelId),
      authorName: candidate.authorName,
      maxChars: args.limits.maxAnswerChars,
      unprompted: true,
      canned: args.canned ? runtime.cannedUnpromptedAnswer : null,
    });
  } catch (error) {
    log("generate.failed", { error: String(error.message), path: "unprompted" });
    return { post: null, reason: "generate-failed" };
  }

  const cost = estimateCostUsd(generated.usage, generated.model);
  if (generated.usage) {
    budget.record(cost);
  }

  // THE CONFIDENCE GATE. `parseUnpromptedAnswer` publishes nothing that did not
  // come back asserting the answer is in the fact file. Every other shape,
  // including the ordinary `NAO_SEI`, an unmarked answer and a hedge, is
  // silence and is logged with the shape that produced it, because "what did it
  // nearly say" is the only way to tell a heuristic that is too loose from one
  // that is too tight.
  const parsed = parseUnpromptedAnswer(generated.text);
  if (!parsed.known) {
    log("unprompted.silent", {
      reason: parsed.reason,
      author: candidate.authorName,
      question: candidate.body,
      costUsd: Number(cost.toFixed(5)),
    });
    return { post: null, reason: `unconfident:${parsed.reason}` };
  }

  const verdict = screenAnswer(parsed.body, {
    facts,
    ownerHandle: args.ownerHandle,
    maxLength: args.limits.maxAnswerChars,
  });
  if (!verdict.ok) {
    log("unprompted.silent", {
      reason: `screen:${verdict.reason}`,
      detail: verdict.detail,
      body: parsed.body,
    });
    return { post: null, reason: `rejected:${verdict.reason}` };
  }

  log("generate", {
    model: generated.model,
    path: "unprompted",
    inputTokens: generated.usage?.input_tokens,
    outputTokens: generated.usage?.output_tokens,
    costUsd: Number(cost.toFixed(5)),
    budget: budget.snapshot(),
  });

  return { post: parsed.body, reason: "unprompted", replyToId: candidate.id };
}

/**
 * Build the escalation sentence and record the question.
 *
 * Both halves always happen. The JSONL line is the maintenance signal - the
 * list of what people asked that facts.md could not answer, which is the input
 * to the next edit of facts.md. The @mention is the escalation proper, and it
 * is the half that is rate-capped, because the file can absorb a hundred lines
 * in an evening and Rafael's notifications cannot.
 */
export function makeEscalator(runtime) {
  const { args, rateCap, log } = runtime;
  return (message, question, why) => {
    const now = Date.now();
    const canEscalate = rateCap.allow(
      "escalation",
      args.limits.maxEscalationsPerHour,
      now,
    );
    if (canEscalate) {
      rateCap.record("escalation", now);
    }

    mkdirSync(args.stateDir, { recursive: true });
    appendFileSync(
      args.escalations,
      `${JSON.stringify({
        at: new Date().toISOString(),
        why,
        question,
        author: message.authorName,
        channelId: message.channelId,
        messageId: message.id,
        pinged: canEscalate,
      })}\n`,
    );
    log("escalation", { why, pinged: canEscalate, author: message.authorName });

    return fallbackAnswer(args.ownerHandle, { canEscalate });
  };
}

/**
 * One message in the greeting channel: reply to it, or say why not.
 *
 * Extracted from the loop for the same reason `decideReply` was: the decision
 * is `greeter.decide`, which is pure and tested on its own; this is the I/O
 * around it, and the two things it does that the decision cannot are worth
 * spelling out.
 *
 *   1. If the author is somebody the roster has never seen, the roster is
 *      re-read FIRST. A person who joins and types "oi" within the same minute
 *      would otherwise fall between two timer ticks and be refused as
 *      NOT_NEW, which is the common case for exactly the people this is for.
 *   2. The kill switch is re-checked right before the write, like every other
 *      post this bot makes, and `--dry-run` prints instead of sending.
 *
 * Exported so `test/greetings.test.js` can drive it with a fake socket.
 */
export async function answerHello({ message, socket }, { greeter, runtime, args, log, stopped }) {
  if (!greeter) {
    return { post: null, reason: "greetings-disabled" };
  }
  if (runtime.roster && !runtime.roster.member(message.authorId) && runtime.pollRoster) {
    await runtime.pollRoster();
  }
  const result = greeter.decide(message, Date.now());
  if (!result.post) {
    // NOT_GREETING and NOT_NEW are what almost every message in a busy channel
    // is. Logging them would bury the rare reasons that matter.
    if (result.reason !== "not-a-greeting" && result.reason !== "not-new") {
      log("hello.skip", { reason: result.reason, author: message.authorName });
    }
    return result;
  }
  if (stopped()) {
    log("bot.halted", { reason: "kill-switch", dropped: "hello" });
    return { post: null, reason: "kill-switch" };
  }
  if (args.dryRun) {
    console.log(`\n[hello] ${message.authorName}: ${message.body}`);
    console.log(`  -> ${result.post}`);
    greeter.recordSent(message, Date.now());
    return result;
  }
  await sleep(MIN_LATENCY_MS);
  try {
    socket.reply(result.post, result.replyToId);
  } catch (error) {
    // Not recorded as greeted: the reply never left. If they say oi again
    // inside the window they get it then; the reconnect loop is already
    // working on the socket.
    log("hello.dropped", { error: String(error.message), author: message.authorName });
    return { post: null, reason: "dropped" };
  }
  greeter.recordSent(message, Date.now());
  // A hello is a message the room sees from the bot, so it counts for the "no
  // two bot messages in a row" rule exactly like an answer does.
  runtime.pending?.recordPost(message.channelId);
  log("hello", { author: message.authorName, body: message.body, reply: result.post });
  return result;
}

/**
 * One pass over the questions the room did not answer.
 *
 * Called from the idle branch of the main loop, so it is what the bot does with
 * a moment in which nobody has asked it anything. Everything interesting is in
 * `pending.due` (is there a question, is it old enough, is it too old, did the
 * bot just speak) and `decideUnprompted` (is there anything to say); this is
 * the I/O between them, and the two things it does that neither of those can:
 *
 *   1. it posts as a REPLY to the original message, always. An unprompted line
 *      that lands loose in the channel three minutes after the question reads
 *      as an announcement. Threaded under the question it reads as an answer,
 *      and anybody scrolling past can see what it is answering.
 *   2. it tells the pending store that the bot has now spoken in that channel,
 *      which is what stops a second unprompted line following the first.
 *
 * Exported so `test/pending.test.js` can drive it with a fake socket.
 */
export async function sweepUnanswered({ runtime, sockets, args, log, stopped }) {
  const pending = runtime.pending;
  if (!pending || !args.unprompted.enabled) {
    return { post: null, reason: "unprompted-disabled" };
  }

  const candidate = pending.due(Date.now(), (dropped) => {
    // Stale and awaiting-human drops are the two ways this feature declines to
    // speak for a structural reason rather than a content one, and both are
    // rare enough to be worth a line each.
    log("unprompted.dropped", {
      reason: dropped.reason,
      ageS: Math.round(dropped.ageMs / 1000),
      author: dropped.authorName,
      question: dropped.body,
    });
  });
  if (!candidate) {
    return { post: null, reason: "none-due" };
  }

  const socket = sockets.get(candidate.channelId);
  if (!socket) {
    return { post: null, reason: "no-socket" };
  }

  // NO TYPING INDICATOR HERE, and it is deliberate rather than an omission.
  // `typingWhile` is right on the mention path: somebody is waiting for an
  // answer and an honest progress indicator is what they want. On this path
  // silence is the designed common outcome, so a typing indicator would mostly
  // be "manual [bot] está digitando" in a quiet room followed by nothing, which
  // is a message with no content. It is also itself an unprompted signal from
  // an account nobody called. The answer just arrives, threaded under the
  // question, after the same latency floor everything else waits out.
  let result;
  try {
    result = await decideUnprompted(candidate, runtime);
  } catch (error) {
    log("handler.failed", {
      path: "unprompted",
      error: String(error.stack ?? error.message),
    });
    return { post: null, reason: "handler-failed" };
  }

  if (!result.post) {
    return result;
  }

  if (stopped()) {
    log("bot.halted", { reason: "kill-switch", dropped: result.reason });
    return { post: null, reason: "kill-switch" };
  }

  if (args.dryRun) {
    console.log(`\n[unprompted] ${candidate.authorName}: ${candidate.body}`);
    console.log(`  -> ${result.post}`);
    return result;
  }

  await sleep(MIN_LATENCY_MS);
  try {
    socket.reply(result.post, candidate.id);
  } catch (error) {
    // The socket dropped between deciding and posting. Nothing is retried: by
    // the time it is back the question is older still, and the whole point of
    // the staleness rule is that a late answer is worse than none.
    log("unprompted.dropped", {
      reason: "socket-down",
      error: String(error.message),
      author: candidate.authorName,
    });
    return { post: null, reason: "dropped" };
  }

  const now = Date.now();
  runtime.lastAnswerAt = now;
  // The shared ledger. An unprompted answer spends the same per-user and
  // per-channel hourly budget as one somebody asked for, so this feature cannot
  // raise the total number of messages the account posts in an hour.
  runtime.rateCap.record(`user:${candidate.authorId}`, now);
  runtime.rateCap.record(`channel:${candidate.channelId}`, now);
  runtime.rateCap.record(`unprompted:${candidate.channelId}`, now);
  pending.recordPost(candidate.channelId);
  log("unprompted.answered", {
    author: candidate.authorName,
    question: candidate.body,
    answer: result.post,
    waitedS: Math.round((now - candidate.askedAt) / 1000),
  });
  return result;
}

/**
 * Hold the typing indicator until `work` settles.
 *
 * NOT the ambient runner's `typeFor`, and the difference is the point. That
 * one holds the indicator for a computed duration to imitate how long a person
 * would have taken to type the line. This one holds it for exactly as long as
 * the bot is actually busy, because it IS busy, and stops the moment it is not.
 * An honest progress indicator, not a performance of composing.
 */
async function typingWhile(socket, work) {
  let done = false;
  const beat = (async () => {
    while (!done) {
      try {
        socket.typing();
      } catch {
        return; // socket closed under us; the awaited work will report it
      }
      await sleep(2500);
    }
  })();
  try {
    return await work;
  } finally {
    done = true;
    await beat;
  }
}

async function connect(args, log) {
  const identity = resolveIdentity({
    tokensFile: args.tokensFile,
    devToken: args.devToken,
    personaIds: [args.botId],
  });
  const token = identity.tokenFor(args.botId);
  const api = new PqpApi({ baseUrl: args.apiUrl, token });

  /**
   * A fresh credential for every socket attempt, not the one captured at boot.
   *
   * `realtime.ts` needs this because a Clerk JWT expires in a minute; here the
   * character token is long-lived, so the thing it buys is different and still
   * worth having: the secrets file is re-read, so a rotated token is picked up
   * by the next reconnect instead of requiring a restart nobody will think to
   * do while the bot appears to be running. A failed re-read falls back to the
   * token that is currently working rather than turning a rotation typo into an
   * outage.
   */
  const tokenProvider = () => {
    try {
      return resolveIdentity({
        tokensFile: args.tokensFile,
        devToken: args.devToken,
        personaIds: [args.botId],
      }).tokenFor(args.botId);
    } catch (error) {
      log("identity.reread.failed", { error: String(error.message) });
      return token;
    }
  };

  if (identity.mode !== "character") {
    // Dev bypass only. A character account is minted with its gates cleared and
    // its display name already set (see scripts/provision.mjs), and this branch
    // is how a local checkout gets an account that looks the same without one.
    await api.ensureAgeGate();
    const label = disclosureLabel(DISCLOSURE);
    await api.setProfile({ displayName: `${BOT_NAME}${label.suffix}` });
  }

  const me = await api.call("/api/me");
  if (!me.username) {
    throw new Error(
      "This account has no username, so nobody can @mention it and the bot " +
        "would never trigger.",
    );
  }

  const servers = await api.listServers();
  const server = servers.find((s) => s.name === args.serverName);
  if (!server) {
    throw new Error(
      `The bot account is not a member of a server called "${args.serverName}". ` +
        `Known: ${servers.map((s) => s.name).join(", ") || "(none)"}. ` +
        `Invite it first; this bot does not create servers.`,
    );
  }

  const all = await api.listChannels(server.id);
  const channels = args.channels.map((name) => {
    const found = all.find((c) => c.type === "text" && c.name === name);
    if (!found) {
      throw new Error(
        `No text channel "#${name}" in ${args.serverName}. ` +
          `Known: ${all.filter((c) => c.type === "text").map((c) => `#${c.name}`).join(", ")}`,
      );
    }
    return found;
  });

  // The channel where hellos are answered. Resolved the same way as the answer
  // channels but NOT fatal when missing: a renamed #geral should cost the QG
  // its hellos, not its support answers. The line below is the only trace.
  let greetingChannel = null;
  if (args.greetings.enabled) {
    greetingChannel =
      all.find((c) => c.type === "text" && c.name === args.greetings.channel) ?? null;
    if (!greetingChannel) {
      log("greetings.disabled", {
        reason: "channel-missing",
        channel: `#${args.greetings.channel}`,
        known: all.filter((c) => c.type === "text").map((c) => `#${c.name}`),
      });
    }
  } else {
    log("greetings.disabled", { reason: "SUPPORT_BOT_GREETINGS" });
  }

  log("bot.ready", {
    userId: me.id,
    username: me.username,
    displayName: me.displayName,
    identity: identity.mode,
    server: server.name,
    channels: channels.map((c) => `#${c.name}`),
    greetingChannel: greetingChannel ? `#${greetingChannel.name}` : null,
  });

  return {
    api,
    bot: { userId: me.id, username: me.username },
    server,
    channels,
    greetingChannel,
    tokenProvider,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger(args.log);
  const facts = loadFacts(args.facts);

  const runtime = {
    facts,
    args,
    log,
    rateCap: new RateCap(),
    budget: new Budget({
      path: args.dryRun ? null : args.budgetPath,
      ...args.budget,
    }),
    seen: new Set(),
    /** channelId -> the last 40 lines of that channel. See `recentTranscript`. */
    transcripts: new Map(),
    ignoreUserIds: new Set(
      (process.env.SUPPORT_IGNORE_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    lastAnswerAt: 0,
    allowedChannelIds: null,
    bot: { userId: null, username: null },
    /**
     * Fixture answers for `--canned`.
     *
     * The UNKNOWN list is checked first and mirrors the `## não sei` section of
     * facts.md, which matters more than it looks: `--canned` is the demo path,
     * and the first version matched "tela" before anything else, so "dá pra
     * transmitir a tela do iphone?" confidently returned the screen-share
     * answer. That is precisely the question the fact file marks as unresolved,
     * so the demo was showing the exact failure the design exists to prevent.
     * A fixture that lies about the shape of the behaviour is worse than no
     * fixture.
     */
    cannedAnswer: (question) =>
      /quando|quantas pessoas|pre[çc]o|plano pago|banid|denunc|minha conta/i.test(
        question,
      )
        ? "NAO_SEI"
        : /iphone|celular/i.test(question)
          ? "no app do iphone dá pra assistir. transmitir a tela do iphone existe no código, mas ainda não foi testado num aparelho de verdade. no safari do iphone só dá pra assistir."
          : /tela|qualidade|resolu|som|[áa]udio|voz|desktop|c[óo]digo|aberto/i.test(question)
            ? "a captura é 1080p30 e não tem ajuste manual de qualidade. quanto menos gente assistindo, mais nítido fica."
            : "NAO_SEI",
  };
  /**
   * The same fixture, in the shape the unprompted parser expects.
   *
   * Wrapping rather than a second table, so `--canned` cannot drift into
   * demonstrating different knowledge on the two paths. It DOES have to carry
   * the confidence prefix: a fixture that skipped it would make every canned
   * unprompted run silent, which would hide the whole feature behind the one
   * flag people develop with.
   */
  runtime.cannedUnpromptedAnswer = (question) => {
    const text = runtime.cannedAnswer(question);
    return text === "NAO_SEI" ? text : `${CONFIDENT_PREFIX}: ${text}`;
  };
  runtime.escalate = makeEscalator(runtime);

  // ── `--ask`: the whole answering path, with no socket and no channel.
  //
  // This is how the bot is developed and demonstrated. It exercises the facts,
  // the prompt, the sentinel, the screen, the budget and the escalation copy
  // without connecting to anything, which means a change can be checked against
  // fifty real questions in a second and without a running server.
  if (args.ask) {
    runtime.bot = { userId: "bot", username: "manual_bot" };
    runtime.allowedChannelIds = new Set(["ask"]);
    runtime.pending = new PendingQuestions({ botUserId: "bot" });
    const message = {
      id: "ask",
      channelId: "ask",
      authorId: "asker",
      authorName: "você",
      // `--unprompted` asks the question the way the room would: no mention,
      // nobody having answered it. It is how the confidence gate and the
      // room-question heuristic are developed, and like `--ask` it needs no
      // socket, no channel and no server.
      body: args.askUnprompted ? args.ask : `@manual_bot ${args.ask}`,
    };
    const heuristic = looksLikeRoomQuestion(message);
    const result = args.askUnprompted
      ? heuristic.ok
        ? await decideUnprompted(
            { ...message, askedAt: Date.now(), body: message.body },
            runtime,
          )
        : { post: null, reason: `not-a-room-question:${heuristic.reason}` }
      : await decideReply(message, runtime);
    console.log(`\n> ${args.ask}\n`);
    console.log(result.post ? result.post : `(silêncio: ${result.reason})`);
    console.log(`\n[${result.reason}] ${JSON.stringify(runtime.budget.snapshot())}`);
    return;
  }

  if (stopped()) {
    log("bot.halted", { reason: "kill-switch" });
    return;
  }

  let signalled = 0;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      signalled += 1;
      if (signalled > 1) {
        log("bot.signal", { signal, action: "exit" });
        process.exit(1);
      }
      log("bot.signal", { signal, action: "kill-switch" });
      engageKillSwitch();
    });
  }

  const { api, bot, server, channels, greetingChannel, tokenProvider } = await connect(args, log);
  runtime.bot = bot;
  runtime.allowedChannelIds = new Set(channels.map((c) => c.id));

  // The questions the room has not answered. In memory, so a redeploy starts
  // with none and the bot never turns up under an hour-old message. See the
  // header of `pending.js`.
  runtime.pending = new PendingQuestions({
    enabled: args.unprompted.enabled,
    botUserId: bot.userId,
    ignoreUserIds: runtime.ignoreUserIds,
    delayMs: args.unprompted.delayMs,
    maxAgeMs: args.unprompted.maxAgeMs,
  });

  log("bot.start", {
    model: args.canned ? "canned" : DEFAULT_MODEL,
    budget: runtime.budget.snapshot(),
    limits: args.limits,
    ownerHandle: args.ownerHandle,
    unprompted: args.unprompted,
  });

  // One socket per channel. `ResilientSocket` pins itself to the channel it
  // joined, so this is also what makes `socket.send` land in the right room
  // without the runner having to track which channel a reply belongs to — and
  // it re-joins that same channel after every reconnect, so the pin survives a
  // dropped connection.
  const sockets = new Map();
  const queue = [];
  for (const channel of channels) {
    const socket = new ResilientSocket({
      wsUrl: args.wsUrl,
      label: `#${channel.name}`,
      channelId: channel.id,
      tokenProvider,
      log,
    });
    await socket.start();
    socket.onFrame((frame) => {
      if (frame.type !== "message-broadcast") {
        return;
      }
      const message = frame.message;
      // Every message feeds the transcript, including the bot's own: an answer
      // is context for the follow-up question. Only non-bot messages become
      // candidates to answer.
      rememberLine(runtime, message);
      // And every message, including the bot's own, is offered to the pending
      // store, which is how it learns both "somebody asked something nobody
      // answered" and "the newest thing in this room is me". It decides what
      // each message means; this only has to show it all of them.
      const noted = runtime.pending.observe(message, Date.now());
      if (noted.tracked) {
        log("unprompted.tracked", {
          channel: `#${channel.name}`,
          author: message.authorName,
          question: message.body,
        });
      }
      if (message.authorId !== bot.userId) {
        queue.push({ message, socket });
      }
    });
    sockets.set(channel.id, socket);
  }

  // ── Newcomer hellos. Everything below is inert when `greetingChannel` is
  // null (feature off, or channel missing), and `greetings.js` explains the
  // whole design. What lives HERE is the I/O it needs: the roster fetch, the
  // timer that repeats it, the socket for the greeting channel, and the queue
  // of candidate messages the main loop drains.
  const hellos = [];
  let greeter = null;
  let stopRosterPoll = () => {};
  if (greetingChannel) {
    const roster = new Roster({
      path: args.dryRun ? null : args.rosterPath,
      windowMs: args.greetings.newcomerWindowMs,
    });
    greeter = new Greeter({
      roster,
      rateCap: runtime.rateCap,
      channelId: greetingChannel.id,
      botUserId: bot.userId,
      enabled: args.greetings.enabled,
      maxPerWindow: args.greetings.maxPerTenMinutes,
    });
    /**
     * Re-read who is in the server. Called at boot, on the timer, and once more
     * when somebody the roster has never seen posts in the greeting channel,
     * so a hello typed five seconds after joining is not lost to the timer's
     * resolution. A failed fetch is a logged line and a stale roster, which
     * `Roster.observe` already treats as "trust nothing new".
     */
    const pollRoster = async () => {
      try {
        const { members } = await api.call(`/api/servers/${server.id}/members`);
        const appeared = roster.observe(members, Date.now());
        if (appeared.length > 0) {
          log("roster.appeared", { count: appeared.length });
        }
      } catch (error) {
        log("roster.failed", { error: String(error.message) });
      }
    };
    await pollRoster();
    const pollTimer = setInterval(() => void pollRoster(), args.greetings.memberPollMs);
    pollTimer.unref?.();
    stopRosterPoll = () => clearInterval(pollTimer);
    runtime.pollRoster = pollRoster;
    runtime.roster = roster;

    // Reuse the answer socket when #ajuda and the greeting channel are the same
    // room; otherwise open one more, with the same reconnect policy. Frames
    // from this socket that are not hellos still go through `screenTrigger`,
    // which refuses them as CHANNEL unless the room is also an answer channel,
    // so watching #geral does not make the bot answer questions there.
    let greetSocket = sockets.get(greetingChannel.id);
    if (!greetSocket) {
      greetSocket = new ResilientSocket({
        wsUrl: args.wsUrl,
        label: `#${greetingChannel.name}`,
        channelId: greetingChannel.id,
        tokenProvider,
        log,
      });
      await greetSocket.start();
      sockets.set(greetingChannel.id, greetSocket);
    }
    greetSocket.onFrame((frame) => {
      if (frame.type !== "message-broadcast") {
        return;
      }
      const message = frame.message;
      if (message.channelId === greetingChannel.id && message.authorId !== bot.userId) {
        hellos.push({ message, socket: greetSocket });
      }
    });
    log("greetings.ready", {
      channel: `#${greetingChannel.name}`,
      newcomerWindowMs: args.greetings.newcomerWindowMs,
      maxPerTenMinutes: args.greetings.maxPerTenMinutes,
      memberPollMs: args.greetings.memberPollMs,
    });
  }

  // The only line this process emits on a quiet day. Started after the sockets
  // exist so the first beat reports a real connected count rather than zero.
  const stopHeartbeat = startHeartbeat({ sockets: [...sockets.values()], log });

  for (;;) {
    if (stopped()) {
      log("bot.halted", { reason: "kill-switch" });
      break;
    }
    // Hellos first. They are cheap (no model call), they are time-sensitive
    // (a reply to "oi" that arrives after the answer to somebody else's
    // question reads as a non sequitur), and there is at most a handful a day.
    const hello = hellos.shift();
    if (hello) {
      await answerHello(hello, { greeter, runtime, args, log, stopped });
      continue;
    }

    const next = queue.shift();
    if (!next) {
      // The unprompted sweep runs LAST, only when there is nothing anybody
      // asked for waiting. That ordering is the priority statement: a question
      // somebody typed the bot's name into always goes first, and the answer to
      // a question the room dropped is what the bot does with an idle moment.
      await sweepUnanswered({ runtime, sockets, args, log, stopped });
      await sleep(400);
      continue;
    }

    const { message, socket } = next;
    let result;
    try {
      result = await typingWhile(socket, decideReply(message, runtime));
    } catch (error) {
      // One bad message must not take the process down. The ambient runner
      // learned this the hard way (pitfall #9 in CLAUDE.md): a thrown handler
      // used to crash the whole server.
      log("handler.failed", { error: String(error.stack ?? error.message) });
      continue;
    }

    if (!result.post) {
      continue;
    }

    // A last check before the write. The switch has to stop an answer that was
    // already being composed when it was flipped, not just the next one.
    if (stopped()) {
      log("bot.halted", { reason: "kill-switch", dropped: result.reason });
      break;
    }

    if (args.dryRun) {
      console.log(`\n[${result.reason}] ${message.authorName}: ${message.body}`);
      console.log(`  -> ${result.post}`);
      continue;
    }

    // HUMAN_LATENCY: a floor, not an imitation. Answering in 200ms reads as a
    // machine barging in and makes the room feel automated; the ambient runner
    // pads to a plausible typing speed, this one just refuses to be instant.
    await sleep(MIN_LATENCY_MS);
    try {
      socket.send(result.post);
    } catch (error) {
      // The socket dropped between composing the answer and posting it. Before
      // reconnect existed this threw out of `main()` and took the process down;
      // now it is a logged dropped answer and the reconnect loop is already
      // working on the socket. The question survives in the escalation ledger
      // when it was one, and the asker can ask again.
      log("answer.dropped", {
        reason: result.reason,
        error: String(error.message),
        author: message.authorName,
        question: message.body,
      });
      continue;
    }
    runtime.lastAnswerAt = Date.now();
    runtime.rateCap.record(`user:${message.authorId}`, runtime.lastAnswerAt);
    runtime.rateCap.record(`channel:${message.channelId}`, runtime.lastAnswerAt);
    runtime.pending.recordPost(message.channelId);
    log("answered", {
      reason: result.reason,
      author: message.authorName,
      question: message.body,
      answer: result.post,
    });
  }

  stopHeartbeat();
  stopRosterPoll();
  for (const socket of sockets.values()) {
    socket.close();
  }
  log("bot.done", { budget: runtime.budget.snapshot() });
}

// Only run when invoked directly, so `test/bot.test.js` can import
// `decideReply` without the process trying to connect to anything.
if (process.argv[1] && process.argv[1].endsWith("bot.js")) {
  main().catch((error) => {
    console.error(`[support-bot] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
