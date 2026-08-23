#!/usr/bin/env node
/**
 * The QG support bot.
 *
 * Answers product questions in the QG do pqp, from `facts.md` and from nothing
 * else, only when somebody explicitly addresses it, and says it does not know
 * the rest of the time.
 *
 *   node src/bot.js --ask "tem como aumentar a qualidade da tela?" --canned
 *   node src/bot.js --ask "..."                       one question, no network, live model
 *   node src/bot.js --watch --canned                  connected, fixture answers
 *   node src/bot.js --watch                           the real thing
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
 * that decides when to speak unprompted; this bot must never speak unprompted,
 * so it has no scheduler at all and sharing one would mean maintaining the
 * property "this cadence must never apply to that account" forever. Their
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
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

import { PqpApi, PqpSocket, sleep } from "../../ambient/src/pqp-client.js";
import { resolveIdentity } from "../../ambient/src/identity.js";
import { createLogger, killSwitchEngaged, engageKillSwitch } from "../../ambient/src/log.js";
import { RateCap } from "../../ambient/src/schedule.js";
import { screenInbound, disclosureLabel } from "../../ambient/src/guardrails.js";

import { loadFacts } from "./facts.js";
import { screenTrigger, SKIP } from "./trigger.js";
import { screenAnswer } from "./screen.js";
import { FIXED, cannedAnswerFor, fallbackAnswer, parseAnswer } from "./answer.js";
import { Budget } from "./budget.js";
import { generateAnswer, estimateCostUsd, DEFAULT_MODEL } from "./generate.js";

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
      transcript: runtime.transcript.slice(-args.limits.transcriptLines),
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

  log("bot.ready", {
    userId: me.id,
    username: me.username,
    displayName: me.displayName,
    identity: identity.mode,
    server: server.name,
    channels: channels.map((c) => `#${c.name}`),
  });

  return { api, bot: { userId: me.id, username: me.username }, server, channels, token };
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
    transcript: [],
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
          ? "no app do iphone dá pra assistir e transmitir a tela. no safari do iphone só dá pra assistir."
          : /tela|qualidade|resolu|som|[áa]udio|voz|desktop|c[óo]digo|aberto/i.test(question)
            ? "a captura é 1080p30 e não tem ajuste manual de qualidade. quanto menos gente assistindo, mais nítido fica."
            : "NAO_SEI",
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
    const message = {
      id: "ask",
      channelId: "ask",
      authorId: "asker",
      authorName: "você",
      body: `@manual_bot ${args.ask}`,
    };
    const result = await decideReply(message, runtime);
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

  const { bot, channels, token } = await connect(args, log);
  runtime.bot = bot;
  runtime.allowedChannelIds = new Set(channels.map((c) => c.id));

  log("bot.start", {
    model: args.canned ? "canned" : DEFAULT_MODEL,
    budget: runtime.budget.snapshot(),
    limits: args.limits,
    ownerHandle: args.ownerHandle,
  });

  // One socket per channel. `PqpSocket` pins itself to the channel it joined,
  // so this is also what makes `socket.send` land in the right room without the
  // runner having to track which channel a reply belongs to.
  const sockets = new Map();
  const queue = [];
  for (const channel of channels) {
    const socket = new PqpSocket({ wsUrl: args.wsUrl, token, label: `#${channel.name}` });
    await socket.connect();
    socket.joinChannel(channel.id);
    socket.onFrame((frame) => {
      if (frame.type !== "message-broadcast") {
        return;
      }
      const message = frame.message;
      // Every message feeds the transcript, including the bot's own: an answer
      // is context for the follow-up question. Only non-bot messages become
      // candidates to answer.
      runtime.transcript.push({
        authorName: message.authorName,
        body: String(message.body ?? "").slice(0, 300),
      });
      if (runtime.transcript.length > 40) {
        runtime.transcript.splice(0, runtime.transcript.length - 40);
      }
      if (message.authorId !== bot.userId) {
        queue.push({ message, socket });
      }
    });
    sockets.set(channel.id, socket);
  }

  for (;;) {
    if (stopped()) {
      log("bot.halted", { reason: "kill-switch" });
      break;
    }
    const next = queue.shift();
    if (!next) {
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
    socket.send(result.post);
    runtime.lastAnswerAt = Date.now();
    runtime.rateCap.record(`user:${message.authorId}`, runtime.lastAnswerAt);
    runtime.rateCap.record(`channel:${message.channelId}`, runtime.lastAnswerAt);
    log("answered", {
      reason: result.reason,
      author: message.authorName,
      question: message.body,
      answer: result.post,
    });
  }

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
