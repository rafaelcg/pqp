#!/usr/bin/env node
/**
 * The ambient-life runner.
 *
 * Wires the pure parts together and is the only file allowed to touch the
 * network, the clock, or the filesystem. Everything it decides — when a scene
 * happens, who is in it, what survives the guardrails, how long a line takes to
 * type — is computed by a tested function in `schedule.js`, `scene.js` or
 * `guardrails.js`; this file's job is I/O and ordering.
 *
 *   node src/runner.js --once --canned          one scene, fixture dialogue
 *   node src/runner.js --once                   one scene, live Claude call
 *   node src/runner.js --watch --canned         stay up, react to real humans
 *   node src/runner.js --once --canned --dry-run   plan and print, post nothing
 *
 * Local only, today: identity comes from DEV_AUTH_BYPASS, which the server
 * refuses under NODE_ENV=production. §1 of the design doc is the production
 * identity decision.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { planScene, RateCap, personaWeight, jitter } from "./schedule.js";
import { parseTranscript, typingPlan } from "./scene.js";
import { screenLine, isTooSimilar, disclosureLabel } from "./guardrails.js";
import { loadMemory, saveMemory, rememberScene } from "./memory.js";
import { createLogger, killSwitchEngaged } from "./log.js";
import { generateScene, estimateCostUsd } from "./generate.js";
import { PqpApi, PqpSocket, typeFor, sleep } from "./pqp-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const REACTIONS = ["🔥", "😂", "👏", "😅", "🫡", "⚽"];

function parseArgs(argv) {
  const args = {
    once: argv.includes("--once"),
    watch: argv.includes("--watch"),
    canned: argv.includes("--canned"),
    dryRun: argv.includes("--dry-run"),
    // Ignore activity windows for this run. Exists so a demo at 03:00 is
    // possible without lying to the scheduler about the time.
    force: argv.includes("--force"),
    config: valueOf(argv, "--config") ?? join(ROOT, "personas.example.yaml"),
    apiUrl: process.env.AMBIENT_API_URL ?? "http://127.0.0.1:3001",
    wsUrl: process.env.AMBIENT_WS_URL ?? "ws://127.0.0.1:3001/ws",
    devToken: process.env.AMBIENT_DEV_TOKEN ?? "dev-local-token",
    log: valueOf(argv, "--log") ?? join(ROOT, "ambient.log.jsonl"),
  };
  if (!args.once && !args.watch) {
    args.once = true;
  }
  return args;
}

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** A dev-bypass token per persona. The suffix alphabet is fixed by the server. */
function tokenFor(baseToken, id) {
  const suffix = String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return `${baseToken}:${suffix}`;
}

/**
 * Bring the community into existence: a host account owns the server, every
 * persona joins it through a real invite, and each one lands in the text
 * channel the config names.
 *
 * Idempotent by name, so re-running the prototype does not leave a graveyard
 * of near-identical servers behind.
 */
async function ensureCommunity(config, args, log) {
  const host = new PqpApi({
    baseUrl: args.apiUrl,
    token: tokenFor(args.devToken, "ambienthost"),
  });
  await host.ensureAgeGate();
  await host.setProfile({ displayName: "pqp (casa)" });

  const existing = (await host.listServers()).find(
    (s) => s.name === config.community.displayName,
  );
  let serverId;
  if (existing) {
    serverId = existing.id;
    log("community.reuse", { server: config.community.displayName, serverId });
  } else {
    const created = await host.createServer(config.community.displayName);
    serverId = created.server?.id ?? created.id;
    log("community.create", { server: config.community.displayName, serverId });
  }

  let channels = await host.listChannels(serverId);
  let channel = channels.find(
    (c) => c.type === "text" && c.name === config.community.channel,
  );
  if (!channel) {
    // A brand-new server ships with a default text channel; use it rather than
    // adding a second one nobody asked for.
    channel =
      channels.find((c) => c.type === "text") ??
      (await host.createChannel(serverId, config.community.channel));
  }

  const inviteCode = await host.createInvite(serverId);

  const members = [];
  for (const persona of config.personas) {
    const api = new PqpApi({
      baseUrl: args.apiUrl,
      token: tokenFor(args.devToken, persona.id),
    });
    await api.ensureAgeGate();
    const label = disclosureLabel(persona.disclosure);
    await api.setProfile({
      displayName: `${persona.displayName}${label.suffix}`,
    });
    try {
      await api.joinInvite(inviteCode);
    } catch (error) {
      // "already a member" is the steady state after the first run.
      if (!/already/i.test(String(error.message))) {
        throw error;
      }
    }
    const me = await api.call("/api/me");
    members.push({ persona, api, userId: me.id, token: api.token });
    log("persona.ready", {
      persona: persona.id,
      displayName: `${persona.displayName}${label.suffix}`,
      disclosure: persona.disclosure,
      userId: me.id,
    });
  }

  return { serverId, channel, members };
}

/** Open one socket per persona and put them all in the channel. */
async function connectCast(members, args) {
  const sockets = new Map();
  for (const member of members) {
    const socket = new PqpSocket({
      wsUrl: args.wsUrl,
      token: member.token,
      label: member.persona.id,
    });
    await socket.connect();
    socket.joinChannel(member.channelId);
    sockets.set(member.persona.id, socket);
  }
  return sockets;
}

/**
 * Run one scene end to end: generate, screen, deliver with human timing, react.
 *
 * Returns the messages that actually landed — which is not the same as the
 * messages the model produced, and the gap between the two is the whole reason
 * `guardrails.js` exists.
 */
async function playScene({
  config,
  plan,
  memory,
  replyTo,
  sockets,
  members,
  rateCap,
  args,
  log,
}) {
  const generated = await generateScene({
    config,
    plan,
    memory,
    replyTo,
    canned: args.canned,
  });
  const cost = estimateCostUsd(generated.usage);
  log("scene.generated", {
    topic: plan.topic,
    cast: plan.cast.map((p) => p.id),
    model: generated.model,
    inputTokens: generated.usage?.input_tokens,
    outputTokens: generated.usage?.output_tokens,
    costUsd: Number(cost.toFixed(5)),
    replyTo: replyTo?.authorName,
  });

  const parsed = parseTranscript(generated.text, plan.cast, {
    maxMessageChars: config.limits.maxMessageChars,
  });

  const approved = [];
  for (const message of parsed) {
    const verdict = screenLine(message.body, {
      banned: config.community.banned,
      maxLength: config.limits.maxMessageChars,
    });
    if (!verdict.ok) {
      log("line.dropped", {
        persona: message.personaId,
        reason: verdict.reason,
        body: message.body,
      });
      continue;
    }
    if (isTooSimilar(message.body, memory.recentLines)) {
      log("line.dropped", {
        persona: message.personaId,
        reason: "repetition",
        body: message.body,
      });
      continue;
    }
    approved.push(message);
  }

  if (approved.length === 0) {
    log("scene.empty", { topic: plan.topic });
    return [];
  }

  const timed = typingPlan(approved);

  if (args.dryRun) {
    for (const message of timed) {
      log("line.dryrun", {
        persona: message.personaId,
        pauseMs: message.pauseMs,
        typingMs: message.typingMs,
        body: message.body,
      });
    }
    return timed;
  }

  const posted = [];
  for (const message of timed) {
    const socket = sockets.get(message.personaId);
    const member = members.find((m) => m.persona.id === message.personaId);
    if (!socket || !member) {
      continue;
    }
    // Read the previous line, then type this one. Both jittered upstream.
    await sleep(message.pauseMs);
    await typeFor(socket, message.typingMs);
    socket.send(message.body);
    rateCap.record(`server:${config.community.key}`, Date.now());
    rateCap.record(`persona:${message.personaId}`, Date.now());
    posted.push(message);
    log("line.posted", {
      persona: message.personaId,
      body: message.body,
      typingMs: message.typingMs,
    });
  }

  return posted;
}

/**
 * Somebody reacts to one line of the scene.
 *
 * Small on purpose and load-bearing anyway: reactions are the cheapest signal
 * that a channel has more than one person in it, they cost no tokens, and a
 * server whose messages have zero reactions reads as a log file. Never the
 * author's own message — self-reactions are a tell.
 */
async function reactToScene({ posted, sockets, broadcasts, log }) {
  const candidates = posted
    .map((message) => ({
      message,
      broadcast: broadcasts.find((b) => b.body === message.body),
    }))
    .filter((c) => c.broadcast);
  if (candidates.length === 0) {
    log("reaction.skipped", { reason: "no-broadcast-matched" });
    return;
  }

  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const reactorId = [...sockets.keys()].find(
    (id) => id !== target.message.personaId,
  );
  if (!reactorId) {
    return;
  }
  const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
  // A person reads for a beat before tapping an emoji.
  await sleep(jitter(3500, 0.5));
  sockets.get(reactorId).react(target.broadcast.id, emoji);
  log("reaction.posted", {
    persona: reactorId,
    emoji,
    messageId: target.broadcast.id,
    body: target.message.body,
  });
}

/** Build a plan by hand when `--force` overrides the schedule's "not now". */
function forcedPlan(config) {
  const [minLines, maxLines] = config.limits.sceneLines;
  return {
    cast: config.personas.slice(0, 3),
    topic:
      config.community.topics[
        Math.floor(Math.random() * config.community.topics.length)
      ],
    lines: Math.min(maxLines, Math.max(minLines, 4)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger(args.log);
  const config = loadConfig(args.config);
  const memoryPath = join(ROOT, "state", `${config.community.key}.json`);
  let memory = loadMemory(memoryPath);
  const rateCap = new RateCap();

  log("runner.start", {
    community: config.community.key,
    personas: config.personas.length,
    mode: args.canned ? "canned" : "live",
    dryRun: args.dryRun || undefined,
    killSwitch: killSwitchEngaged() || undefined,
  });

  if (killSwitchEngaged()) {
    // Refuse before touching pqp at all. The switch has to be the first gate,
    // not a check somewhere in the middle of a scene.
    log("runner.halted", { reason: "AMBIENT_KILL_SWITCH" });
    return;
  }

  const { serverId, channel, members } = args.dryRun
    ? { serverId: null, channel: null, members: config.personas.map((p) => ({ persona: p })) }
    : await ensureCommunity(config, args, log);

  let sockets = new Map();
  const broadcasts = [];
  const personaUserIds = new Set(members.map((m) => m.userId));

  if (!args.dryRun) {
    for (const member of members) {
      member.channelId = channel.id;
    }
    sockets = await connectCast(members, args);
    for (const socket of sockets.values()) {
      socket.onFrame((frame) => {
        if (frame.type === "message-broadcast") {
          broadcasts.push(frame.message);
        }
      });
    }
    log("cast.connected", {
      serverId,
      channel: channel.name,
      sockets: sockets.size,
    });
  }

  /** One attempt at a scene. `replyTo` makes it a reply to a real human. */
  const attempt = async (replyTo) => {
    let plan = planScene({ config, now: new Date(), rateCap, recentTopics: memory.recentTopics });
    if (!plan && args.force) {
      log("scene.forced", { reason: "outside-activity-windows" });
      plan = forcedPlan(config);
    }
    if (!plan) {
      log("scene.skipped", {
        reason: "no-eligible-cast",
        weights: Object.fromEntries(
          config.personas.map((p) => [
            p.id,
            Number(personaWeight(p, new Date(), config.timezone).toFixed(3)),
          ]),
        ),
      });
      return;
    }
    if (replyTo) {
      // A human in the room outranks whatever the scheduler had in mind, but
      // does not get to bypass the rate caps — that is how a visitor ends up
      // swarmed by six strangers.
      plan = { ...plan, lines: Math.min(plan.lines, 3) };
    }
    const posted = await playScene({
      config, plan, memory, replyTo, sockets, members, rateCap, args, log,
    });
    if (posted.length > 0) {
      memory = rememberScene(memory, {
        topic: plan.topic,
        messages: posted,
        cast: plan.cast,
      });
      saveMemory(memoryPath, memory);
      if (!args.dryRun) {
        // Give the broadcasts a moment to land before matching them by body.
        await sleep(700);
        await reactToScene({ posted, sockets, broadcasts, log });
      }
    }
  };

  if (args.once) {
    await attempt();
    await sleep(500);
    for (const socket of sockets.values()) {
      socket.close();
    }
    log("runner.done", { scenes: memory.scenes });
    return;
  }

  // --watch: stay up. Real human messages jump the queue; otherwise the
  // scheduler's own cadence decides. One tick, two reasons to act.
  const pendingHumans = [];
  for (const socket of sockets.values()) {
    socket.onFrame((frame) => {
      if (
        frame.type === "message-broadcast" &&
        !personaUserIds.has(frame.message.authorId)
      ) {
        pendingHumans.push(frame.message);
      }
    });
  }

  let nextSceneAt = Date.now() + jitter(10 * 60_000, 0.5);
  for (;;) {
    await sleep(5_000);
    if (killSwitchEngaged()) {
      log("runner.halted", { reason: "AMBIENT_KILL_SWITCH" });
      break;
    }
    const human = pendingHumans.shift();
    if (human) {
      // Dedupe: only the most recent human message matters, and answering a
      // backlog one at a time is how a channel turns into a pile-on.
      pendingHumans.length = 0;
      const eligible = config.personas.some(
        (p) =>
          p.replyToHumans?.enabled &&
          rateCap.allow(`reply:${p.id}`, p.replyToHumans.maxPerHour, Date.now()),
      );
      if (eligible) {
        const [minWait, maxWait] = config.personas[0].replyToHumans
          .latencySeconds ?? [20, 120];
        await sleep((minWait + Math.random() * (maxWait - minWait)) * 1000);
        await attempt({ body: human.body, authorName: human.authorName });
        for (const p of config.personas) {
          rateCap.record(`reply:${p.id}`, Date.now());
        }
        nextSceneAt = Date.now() + jitter(15 * 60_000, 0.4);
      }
      continue;
    }
    if (Date.now() >= nextSceneAt) {
      await attempt();
      nextSceneAt = Date.now() + jitter(20 * 60_000, 0.5);
    }
  }
}

main().catch((error) => {
  console.error(`[ambient] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
