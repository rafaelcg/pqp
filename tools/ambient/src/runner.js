#!/usr/bin/env node
/**
 * The ambient-life runner.
 *
 * Wires the pure parts together and is the only file allowed to touch the
 * network, the clock, or the filesystem. Everything it decides — when a scene
 * happens, who is in it, what survives the guardrails, whether a real person
 * gets answered, how long a line takes to type — is computed by a tested
 * function in `schedule.js`, `scene.js`, `guardrails.js` or `identity.js`; this
 * file's job is I/O and ordering.
 *
 *   node src/runner.js --once --canned             one scene per community, fixtures
 *   node src/runner.js --once                      one scene per community, live
 *   node src/runner.js --watch                     stay up; real humans jump the queue
 *   node src/runner.js --once --canned --dry-run   plan, generate, screen, print, post nothing
 *
 * Identity is `identity.js`: character tokens from a mounted secrets file in
 * production, the dev bypass locally. Which servers exist and where the cast
 * lives is `state/servers.json`, written by `scripts/seed-servers.mjs`.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { loadCommunities } from "./config.js";
import { planScene, RateCap, personaWeight, jitter } from "./schedule.js";
import { parseTranscript, parseSceneDecision, typingPlan } from "./scene.js";
import {
  screenLine,
  screenInbound,
  isTooSimilar,
  disclosureLabel,
} from "./guardrails.js";
import { loadMemory, saveMemory, rememberScene } from "./memory.js";
import { createLogger, killSwitchEngaged, engageKillSwitch } from "./log.js";
import { generateScene, estimateCostUsd } from "./generate.js";
import { resolveIdentity } from "./identity.js";
import { PqpApi, PqpSocket, typeFor, sleep } from "./pqp-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const REACTIONS = ["🔥", "😂", "👏", "😅", "🫡", "⚽"];

/** How often the watch loop wakes up to look at every community. */
const TICK_MS = 5_000;

function parseArgs(argv) {
  const args = {
    once: argv.includes("--once"),
    watch: argv.includes("--watch"),
    canned: argv.includes("--canned"),
    dryRun: argv.includes("--dry-run"),
    // Ignore activity windows for this run. Exists so a demo at 03:00 is
    // possible without lying to the scheduler about the time.
    force: argv.includes("--force"),
    config: valueOf(argv, "--config") ?? process.env.AMBIENT_CONFIG ??
      join(ROOT, "personas.yaml"),
    /** Run only this community key. The sharding story from §06, as a flag. */
    only: valueOf(argv, "--community") ?? process.env.AMBIENT_COMMUNITY ?? null,
    apiUrl:
      process.env.PQP_API_URL ??
      process.env.AMBIENT_API_URL ??
      "http://127.0.0.1:3001",
    wsUrl: process.env.PQP_WS_URL ?? process.env.AMBIENT_WS_URL ?? null,
    devToken: process.env.AMBIENT_DEV_TOKEN ?? "dev-local-token",
    tokensFile:
      valueOf(argv, "--tokens") ?? process.env.AMBIENT_TOKENS_FILE ?? null,
    /**
     * Where the durable state lives: per-community memory, the placement file,
     * and the audit log.
     *
     * A separate directory rather than always `<repo>/state` because on a Fly
     * machine the root filesystem is rebuilt on every deploy, and memory that
     * resets on deploy is memory that does not work — the repetition screen is
     * the whole reason it exists, and it would let a community re-run its last
     * topic every time somebody shipped a config change.
     */
    stateDir:
      valueOf(argv, "--state-dir") ??
      process.env.AMBIENT_STATE_DIR ??
      join(ROOT, "state"),
    placements:
      valueOf(argv, "--servers") ?? process.env.AMBIENT_SERVERS_FILE ?? null,
    log: valueOf(argv, "--log") ?? process.env.AMBIENT_LOG ?? null,
  };
  if (!args.once && !args.watch) {
    args.once = true;
  }
  args.placements ??= join(args.stateDir, "servers.json");
  args.log ??= join(args.stateDir, "ambient.log.jsonl");
  // One URL to configure, not two. The socket lives on the same origin as the
  // API in every deployment this product has, and two independent variables is
  // two chances to point them at different environments.
  args.wsUrl ??= args.apiUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  return args;
}

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Where each community's server and channel actually are, as written by
 * `scripts/seed-servers.mjs`.
 *
 * Absent is not an error on its own: a local dev run bootstraps its own server
 * (below). It IS an error in character mode, because a character account has no
 * business creating the servers the product advertises — those are the owner's,
 * created once, with names and channel structures somebody chose.
 */
function loadPlacements(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Bring one community's cast online.
 *
 * In production every server already exists (seeded) and this only joins each
 * persona to it through a real invite. In local dev with no placement file, a
 * host account creates the server first so the whole thing runs from nothing.
 * Idempotent either way: re-running does not leave a graveyard of near-identical
 * servers or a duplicate of every persona.
 */
async function ensureCommunity(config, args, identity, placement, log) {
  let serverId = placement?.serverId ?? null;
  let inviteCode = placement?.inviteCode ?? null;
  let channel = placement?.channelId
    ? { id: placement.channelId, name: placement.channelName ?? config.community.channel }
    : null;

  if (!serverId) {
    if (identity.mode === "character") {
      throw new Error(
        `No placement for community "${config.community.key}" in ${args.placements}. ` +
          `Character accounts do not create the servers the product advertises — ` +
          `run: node scripts/seed-servers.mjs --config ${args.config}`,
      );
    }
    // Local dev only: a host dev-bypass account owns the server so a fresh
    // checkout can run this with nothing but Postgres.
    const host = new PqpApi({
      baseUrl: args.apiUrl,
      token: identity.tokenFor("ambienthost"),
    });
    await host.ensureAgeGate();
    await host.setProfile({ displayName: "pqp (casa)" });

    const existing = (await host.listServers()).find(
      (s) => s.name === config.community.displayName,
    );
    if (existing) {
      serverId = existing.id;
      log("community.reuse", { serverId });
    } else {
      const created = await host.createServer(config.community.displayName);
      serverId = created.server?.id ?? created.id;
      log("community.create", { serverId });
    }

    const channels = await host.listChannels(serverId);
    channel =
      channels.find(
        (c) => c.type === "text" && c.name === config.community.channel,
      ) ??
      channels.find((c) => c.type === "text") ??
      (await host.createChannel(serverId, config.community.channel));
    inviteCode = await host.createInvite(serverId);
  }

  const members = [];
  for (const persona of config.personas) {
    const api = new PqpApi({
      baseUrl: args.apiUrl,
      token: identity.tokenFor(persona.id),
    });
    // A character account cleared the gate when it was minted; a dev-bypass
    // account has not, and cannot open a socket until it does.
    if (identity.mode !== "character") {
      await api.ensureAgeGate();
      const label = disclosureLabel(persona.disclosure);
      await api.setProfile({
        displayName: `${persona.displayName}${label.suffix}`,
      });
    }
    if (inviteCode) {
      try {
        await api.joinInvite(inviteCode);
      } catch (error) {
        // "already a member" is the steady state after the first run.
        if (!/already/i.test(String(error.message))) {
          throw error;
        }
      }
    }
    const me = await api.call("/api/me");
    members.push({ persona, api, userId: me.id, token: api.token });
    log("persona.ready", {
      persona: persona.id,
      disclosure: persona.disclosure,
      userId: me.id,
    });
  }

  if (!channel) {
    throw new Error(
      `Community "${config.community.key}" has a server but no channel to post in.`,
    );
  }

  return { serverId, channel, members };
}

/** Open one socket per persona and put them all in the channel. */
async function connectCast(members, args, channelId) {
  const sockets = new Map();
  for (const member of members) {
    const socket = new PqpSocket({
      wsUrl: args.wsUrl,
      token: member.token,
      label: member.persona.id,
    });
    await socket.connect();
    socket.joinChannel(channelId);
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
async function playScene({ runtime, plan, replyTo, args, log }) {
  const { config, memory, sockets, members, rateCap } = runtime;

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
  runtime.costUsd += cost;

  // The model's own screening verdict, carried back in the same call that
  // would have written the dialogue. A decline is the system working, so it is
  // logged as its own event rather than surfacing as an empty scene.
  const decision = parseSceneDecision(generated.text);
  if (decision.skip) {
    log("reply.declined", {
      by: "model",
      reason: decision.reason,
      replyTo: replyTo?.authorName,
    });
    return [];
  }

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
    // A dry run is read by a person, so print the scene as a scene. The JSONL
    // record is still written for the audit trail; this is the human half.
    console.log(
      `\n--- ${config.community.displayName} · ${plan.topic} ---` +
        (replyTo ? `\n(respondendo ${replyTo.authorName}: "${replyTo.body}")` : ""),
    );
    for (const message of timed) {
      const name =
        members.find((m) => m.persona.id === message.personaId)?.persona
          .displayName ?? message.personaId;
      console.log(
        `  [+${(message.pauseMs / 1000).toFixed(1)}s, digita ${(
          message.typingMs / 1000
        ).toFixed(1)}s] ${name}: ${message.body}`,
      );
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
    // MID-SCENE KILL SWITCH. Checked before every single line, not once before
    // the scene: a five-line scene takes the better part of a minute to
    // deliver, and an operator who flips the switch during one means "stop
    // now", not "stop after the rest of this conversation".
    if (killSwitchEngaged()) {
      log("scene.halted", {
        reason: "AMBIENT_KILL_SWITCH",
        posted: posted.length,
        remaining: timed.length - posted.length,
      });
      break;
    }
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

/**
 * One attempt at a scene in one community. `replyTo` makes it a reply to a real
 * human, which outranks the schedule but not the rate caps.
 */
async function attempt(runtime, args, replyTo) {
  const { config, rateCap, log } = runtime;

  let plan = planScene({
    config,
    now: new Date(),
    rateCap,
    recentTopics: runtime.memory.recentTopics,
  });
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

  const posted = await playScene({ runtime, plan, replyTo, args, log });
  if (posted.length === 0) {
    return;
  }

  if (args.dryRun) {
    // A dry run must not poison the repetition memory. Nothing was published,
    // so nothing was said — writing these lines into `recentLines` would make
    // the real scene that follows drop them as repeats of a scene nobody saw.
    return;
  }

  runtime.memory = rememberScene(runtime.memory, {
    topic: plan.topic,
    messages: posted,
    cast: plan.cast,
  });
  saveMemory(runtime.memoryPath, runtime.memory);

  // The reaction is a write to pqp like any other, so the switch stops it too.
  // Without this an operator who halts mid-scene still sees one more thing
  // appear in the channel a few seconds later, which is exactly the confusion
  // a kill switch exists to prevent.
  if (killSwitchEngaged()) {
    return;
  }
  // Give the broadcasts a moment to land before matching them by body.
  await sleep(700);
  await reactToScene({
    posted,
    sockets: runtime.sockets,
    broadcasts: runtime.broadcasts,
    log,
  });
}

/**
 * Decide whether a real person's message earns a reply right now.
 *
 * Four independent gates, and every one of them has to say yes. The order is
 * cheapest-first, but the reason they are all here is that they fail for
 * different reasons: content, budget-per-person, budget-per-persona, and the
 * kill switch. Returns the persona pool that may answer, or null with a reason
 * for the log.
 */
function screenHumanReply(runtime, message, now) {
  const { config, rateCap } = runtime;

  const verdict = screenInbound(message.body, {
    banned: config.community.banned,
  });
  if (!verdict.reply) {
    return { ok: false, reason: verdict.reason };
  }

  // THE PER-HUMAN CAP. Without it one chatty visitor is the entire budget: they
  // post twenty times in an hour, the cast answers twenty times, and the money
  // and the message ceiling that were meant to make the room feel inhabited go
  // to one conversation nobody else can get a word into. Keyed on the author's
  // user id, not their name, so renaming does not reset it.
  const humanKey = `human:${message.authorId ?? message.authorName}`;
  if (!rateCap.allow(humanKey, config.limits.maxRepliesPerHumanPerHour, now)) {
    return { ok: false, reason: "human-cap" };
  }

  const eligible = config.personas.filter(
    (p) =>
      p.replyToHumans?.enabled &&
      rateCap.allow(`reply:${p.id}`, p.replyToHumans.maxPerHour, now),
  );
  if (eligible.length === 0) {
    return { ok: false, reason: "persona-cap" };
  }

  return { ok: true, eligible, humanKey };
}

async function bootCommunity(config, args, identity, placements, log) {
  const communityLog = (event, fields = {}) =>
    log(event, { community: config.community.key, ...fields });

  const runtime = {
    config,
    log: communityLog,
    memoryPath: join(args.stateDir, `${config.community.key}.json`),
    memory: null,
    // One ledger per community: `planScene` keys persona caps by bare id, and
    // two communities sharing a persona id would otherwise share a budget.
    rateCap: new RateCap(),
    members: [],
    sockets: new Map(),
    broadcasts: [],
    pendingHumans: [],
    personaUserIds: new Set(),
    nextSceneAt: Date.now() + jitter(10 * 60_000, 0.5),
    costUsd: 0,
    scenes: 0,
  };
  runtime.memory = loadMemory(runtime.memoryPath);

  if (args.dryRun) {
    runtime.members = config.personas.map((persona) => ({ persona }));
    communityLog("community.dryrun", { personas: config.personas.length });
    return runtime;
  }

  const { serverId, channel, members } = await ensureCommunity(
    config,
    args,
    identity,
    placements[config.community.key],
    communityLog,
  );
  runtime.members = members;
  runtime.personaUserIds = new Set(members.map((m) => m.userId));
  runtime.sockets = await connectCast(members, args, channel.id);

  for (const socket of runtime.sockets.values()) {
    socket.onFrame((frame) => {
      if (frame.type !== "message-broadcast") {
        return;
      }
      runtime.broadcasts.push(frame.message);
      // Bound it. A long-running watch process would otherwise hold every
      // message the channel has ever seen, and the only thing this list is for
      // is matching a reaction to a line posted seconds ago.
      if (runtime.broadcasts.length > 200) {
        runtime.broadcasts.splice(0, runtime.broadcasts.length - 200);
      }
      if (!runtime.personaUserIds.has(frame.message.authorId)) {
        runtime.pendingHumans.push(frame.message);
      }
    });
  }

  communityLog("cast.connected", {
    serverId,
    channel: channel.name,
    sockets: runtime.sockets.size,
  });
  return runtime;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger(args.log);

  const all = loadCommunities(args.config);
  const communities = args.only
    ? all.filter((c) => c.community.key === args.only)
    : all;
  if (communities.length === 0) {
    throw new Error(
      `No community matched --community ${args.only}. Known: ` +
        all.map((c) => c.community.key).join(", "),
    );
  }

  const identity = resolveIdentity({
    tokensFile: args.tokensFile,
    devToken: args.devToken,
    personaIds: [
      ...communities.flatMap((c) => c.personas.map((p) => p.id)),
      // The dev-only host account. Named here so a character-mode secrets file
      // that happens to be missing it is not treated as an error.
      ...(args.tokensFile ? [] : ["ambienthost"]),
    ],
  });

  // A restart is how the kill switch is actually flipped on every platform this
  // runs on (`fly secrets set` restarts the machine; systemd reloads by
  // restarting), so the signal has to reach the per-line check rather than
  // killing the process where it stands with half a conversation published.
  let signalled = 0;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      signalled += 1;
      if (signalled > 1) {
        // Handling a signal at all means overriding the default, which is
        // "die". A second one has to mean it, or an operator who wants this
        // process gone right now has no way to say so.
        log("runner.signal", { signal, action: "exit" });
        process.exit(1);
      }
      log("runner.signal", { signal, action: "kill-switch" });
      engageKillSwitch();
    });
  }

  log("runner.start", {
    communities: communities.map((c) => c.community.key),
    personas: communities.reduce((n, c) => n + c.personas.length, 0),
    identity: identity.mode,
    api: args.apiUrl,
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

  const placements = loadPlacements(args.placements);
  const runtimes = [];
  for (const config of communities) {
    runtimes.push(await bootCommunity(config, args, identity, placements, log));
  }

  const shutdown = () => {
    for (const runtime of runtimes) {
      for (const socket of runtime.sockets.values()) {
        socket.close();
      }
    }
    log("runner.done", {
      scenes: runtimes.reduce((n, r) => n + r.memory.scenes, 0),
      costUsd: Number(
        runtimes.reduce((n, r) => n + r.costUsd, 0).toFixed(5),
      ),
    });
  };

  if (args.once) {
    for (const runtime of runtimes) {
      await attempt(runtime, args);
    }
    await sleep(500);
    shutdown();
    return;
  }

  // --watch: stay up. Real human messages jump the queue; otherwise each
  // community's own cadence decides. One tick, every community, two reasons to
  // act. Sharding is a config change (`--community`), not a rewrite.
  for (;;) {
    await sleep(TICK_MS);
    if (killSwitchEngaged()) {
      log("runner.halted", { reason: "AMBIENT_KILL_SWITCH" });
      break;
    }

    for (const runtime of runtimes) {
      const now = Date.now();
      const human = runtime.pendingHumans.shift();
      if (human) {
        // Dedupe: only the most recent human message matters, and answering a
        // backlog one at a time is how a channel turns into a pile-on.
        runtime.pendingHumans.length = 0;
        const screen = screenHumanReply(runtime, human, now);
        if (!screen.ok) {
          runtime.log("reply.declined", {
            by: "screen",
            reason: screen.reason,
            author: human.authorName,
          });
          continue;
        }
        const [minWait, maxWait] = screen.eligible[0].replyToHumans
          .latencySeconds ?? [20, 120];
        // A human does not answer in 400ms.
        await sleep((minWait + Math.random() * (maxWait - minWait)) * 1000);
        await attempt(runtime, args, {
          body: human.body,
          authorName: human.authorName,
        });
        runtime.rateCap.record(screen.humanKey, Date.now());
        for (const persona of screen.eligible) {
          runtime.rateCap.record(`reply:${persona.id}`, Date.now());
        }
        runtime.nextSceneAt = Date.now() + jitter(15 * 60_000, 0.4);
        continue;
      }

      if (now >= runtime.nextSceneAt) {
        await attempt(runtime, args);
        runtime.nextSceneAt = Date.now() + jitter(20 * 60_000, 0.5);
      }
    }
  }

  shutdown();
}

main().catch((error) => {
  console.error(`[ambient] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
