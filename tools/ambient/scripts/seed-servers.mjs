#!/usr/bin/env node
/**
 * Create the launch communities: servers, channel structures, topics, and the
 * pinned welcome post that tells somebody arriving what the room is for.
 *
 *   AMBIENT_HOST_TOKEN=… node scripts/seed-servers.mjs --config personas.yaml
 *
 * WHO OWNS THESE SERVERS. The token you pass. In production that is the
 * OWNER'S OWN ACCOUNT — a Clerk session token, pasted for the ten seconds this
 * script runs — and deliberately not a character. The five servers are the
 * product's shopfront: they should belong to a person who can be held to them,
 * who receives the reports, and who can hand one over. A character account is a
 * member of a community, never its landlord, and `provision.mjs` does not mint
 * one that could be.
 *
 * IT GOES THROUGH THE REAL API, including the WebSocket. The welcome post has
 * to be a real message — there is no route that inserts one, `createMessage` is
 * reached only from `ws/chat.ts`, and a row written straight into Postgres
 * would exist in the database and not in any open client. So the script signs
 * in, opens a socket, says the thing, and pins it, exactly as a person would.
 *
 * IDEMPOTENT. Re-running finds each server by name, each channel by name, and
 * each pin by body, and changes only what is missing. That matters more than it
 * sounds: this will be re-run every time somebody edits a channel topic, and
 * the alternative is five duplicate servers with the same name.
 *
 * Its output is `state/servers.json`, which is how the runner learns where each
 * community lives and which invite to join its cast through.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { loadCommunities } from "../src/config.js";
import { PqpApi, PqpSocket, sleep } from "../src/pqp-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const args = {
  config: valueOf(argv, "--config") ?? join(ROOT, "personas.yaml"),
  out:
    valueOf(argv, "--out") ??
    process.env.AMBIENT_SERVERS_FILE ??
    join(ROOT, "state", "servers.json"),
  apiUrl:
    process.env.PQP_API_URL ??
    process.env.AMBIENT_API_URL ??
    "http://127.0.0.1:3001",
  wsUrl: process.env.PQP_WS_URL ?? process.env.AMBIENT_WS_URL ?? null,
  token:
    valueOf(argv, "--token") ??
    process.env.AMBIENT_HOST_TOKEN ??
    process.env.AMBIENT_DEV_TOKEN ??
    "dev-local-token",
  only: valueOf(argv, "--community") ?? null,
  dryRun: argv.includes("--dry-run"),
};
args.wsUrl ??= args.apiUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

const api = new PqpApi({ baseUrl: args.apiUrl, token: args.token });

const all = loadCommunities(args.config);
const communities = args.only
  ? all.filter((c) => c.community.key === args.only)
  : all;
if (communities.length === 0) {
  console.error(`No community matched --community ${args.only}`);
  process.exit(1);
}

console.log(`Seeding ${communities.length} communit(ies) against ${args.apiUrl}\n`);

// The host has to have cleared the age gate like anybody else, or every call
// below 403s with a message about a date of birth.
await api.ensureAgeGate();
const me = await api.call("/api/me");
console.log(`Host: ${me.displayName} (${me.tag ?? me.id})\n`);

const placements = readPlacements(args.out);

for (const config of communities) {
  const { community } = config;
  console.log(`── ${community.displayName}`);

  const serverId = await ensureServer(community);
  const channels = await ensureChannels(serverId, community);
  const main =
    channels.find((c) => c.name === community.channel) ??
    channels.find((c) => c.type === "text");
  const inviteCode = args.dryRun ? null : await api.ensureInvite(serverId);

  if (!args.dryRun) {
    await ensureWelcome(serverId, main, community);
  }

  placements[community.key] = {
    serverId,
    inviteCode,
    channelId: main?.id ?? null,
    channelName: main?.name ?? community.channel,
    displayName: community.displayName,
    seededAt: new Date().toISOString(),
  };
  console.log(
    `   server=${serverId} main=#${main?.name} invite=${inviteCode ?? "(dry-run)"}\n`,
  );
}

if (args.dryRun) {
  console.log("Dry run — nothing was written.");
} else {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(placements, null, 2)}\n`);
  console.log(`Placements written to ${args.out}`);
  console.log(
    `The runner reads this file to find each community. Point it elsewhere with ` +
      `AMBIENT_SERVERS_FILE.`,
  );
}

// ---------------------------------------------------------------- operations

async function ensureServer(community) {
  const existing = (await api.listServers()).find(
    (server) => server.name === community.displayName,
  );
  if (existing) {
    console.log(`   found existing server`);
    return existing.id;
  }
  if (args.dryRun) {
    console.log(`   would create server`);
    return "(dry-run)";
  }
  const created = await api.createServer(community.displayName);
  const serverId = created.server?.id ?? created.id;
  console.log(`   created server`);
  return serverId;
}

/**
 * Bring the channel list to what the config says, without destroying anything.
 *
 * A brand-new server ships with `general` (text) and `Lobby` (voice). Those are
 * RENAMED into the first configured channel of each type rather than deleted
 * and replaced: renaming keeps `general` at position 0, which is the channel a
 * new member lands in, and deleting a channel that already had a message in it
 * is not something a seed script should ever be able to do.
 *
 * Channels present on the server but absent from the config are left alone. A
 * config file is a description of what must exist, not a claim about what must
 * not.
 */
async function ensureChannels(serverId, community) {
  if (args.dryRun) {
    for (const spec of community.channels ?? []) {
      console.log(`   would ensure #${spec.name} (${spec.type})`);
    }
    return (community.channels ?? []).map((spec) => ({ ...spec, id: null }));
  }

  let channels = await api.listChannels(serverId);
  const specs = community.channels ?? [
    { name: community.channel, type: "text" },
  ];

  for (const spec of specs) {
    let channel = channels.find(
      (c) => c.name === spec.name && c.type === spec.type,
    );

    if (!channel) {
      // The default channel of this type, if it is still sitting there under
      // its factory name and nothing has been configured onto it yet.
      const factory = channels.find(
        (c) =>
          c.type === spec.type &&
          (c.name === "general" || c.name === "Lobby") &&
          !specs.some((s) => s.name === c.name),
      );
      if (factory) {
        channel = await api.updateChannel(factory.id, { name: spec.name });
        console.log(`   renamed #${factory.name} → #${spec.name}`);
      } else {
        channel = await api.createChannel(serverId, spec.name, spec.type);
        console.log(`   created #${spec.name} (${spec.type})`);
      }
      channels = await api.listChannels(serverId);
      channel = channels.find(
        (c) => c.name === spec.name && c.type === spec.type,
      );
    }

    if (spec.topic && channel.topic !== spec.topic) {
      await api.updateChannel(channel.id, { topic: spec.topic });
      console.log(`   set topic on #${spec.name}`);
    }
  }

  return api.listChannels(serverId);
}

/**
 * Post the welcome message and pin it — once, ever.
 *
 * Recognised by its first line rather than by its whole body, so editing the
 * text in the config does not produce a second pinned welcome beside the first.
 * The trade is that changing the *first line* does; that is the right way round,
 * because the first line is the only part somebody would deliberately rewrite to
 * mean "this is a different post".
 */
async function ensureWelcome(serverId, channel, community) {
  const body = String(community.welcome ?? "").trim();
  if (!body || !channel) {
    return;
  }
  const firstLine = body.split("\n")[0].slice(0, 60);

  const pinned = await api.listPins(channel.id);
  if (pinned.some((message) => message.body.startsWith(firstLine))) {
    console.log(`   welcome already pinned in #${channel.name}`);
    return;
  }

  const socket = new PqpSocket({
    wsUrl: args.wsUrl,
    token: args.token,
    label: "seed",
  });
  await socket.connect();
  const seen = [];
  socket.onFrame((frame) => {
    if (frame.type === "message-broadcast") {
      seen.push(frame.message);
    }
  });
  socket.joinChannel(channel.id);
  socket.send(body);

  // The pin needs the message's id, which only arrives on the broadcast.
  let posted = null;
  for (let attempt = 0; attempt < 40 && !posted; attempt++) {
    await sleep(150);
    posted = seen.find((message) => message.body === body);
  }
  socket.close();

  if (!posted) {
    console.log(`   ! welcome posted but never broadcast back — not pinned`);
    return;
  }
  await api.pinMessage(posted.id);
  console.log(`   posted and pinned welcome in #${channel.name}`);
}

function readPlacements(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
