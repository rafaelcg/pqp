#!/usr/bin/env node
/**
 * Say something in a community's channel, as a visitor.
 *
 *   node scripts/say.mjs resenha-fc "e aí, quem vocês acham que ganha domingo?"
 *
 * This is the other half of testing the reply-to-humans path: the runner only
 * answers a `message-broadcast` from an author who is not part of the cast, so
 * exercising it needs an actual third party on an actual socket. Reading the
 * runner's log afterwards tells you which way the screen went — `line.posted`
 * for an answer, `reply.declined` with a reason for a refusal.
 *
 * Local only by default: identity is the dev bypass, with a suffix so each
 * visitor is a distinct account and the per-human rate cap is testable. Against
 * a deploy, pass a real bearer token in `AMBIENT_VISITOR_TOKEN` — but think
 * twice, because whatever you type lands in a public server.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { PqpApi, PqpSocket, sleep } from "../src/pqp-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const positional = argv.filter(
  (value, index) =>
    !value.startsWith("--") && !argv[index - 1]?.startsWith("--"),
);
const [communityKey, ...rest] = positional;
const body = rest.join(" ");

if (!communityKey || !body) {
  console.error(
    `usage: node scripts/say.mjs <community-key> "<message>" [--as <name>]`,
  );
  process.exit(1);
}

const apiUrl =
  process.env.PQP_API_URL ?? process.env.AMBIENT_API_URL ?? "http://127.0.0.1:3001";
const wsUrl =
  process.env.PQP_WS_URL ??
  apiUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
const who = valueOf(argv, "--as") ?? "visitante";
const token =
  process.env.AMBIENT_VISITOR_TOKEN ??
  `${process.env.AMBIENT_DEV_TOKEN ?? "dev-local-token"}:${who}`;

const placementsPath =
  valueOf(argv, "--servers") ??
  process.env.AMBIENT_SERVERS_FILE ??
  join(process.env.AMBIENT_STATE_DIR ?? join(ROOT, "state"), "servers.json");
const placements = JSON.parse(readFileSync(placementsPath, "utf8"));
const placement = placements[communityKey];
if (!placement) {
  console.error(
    `No placement for "${communityKey}" in ${placementsPath}. ` +
      `Run scripts/seed-servers.mjs first.`,
  );
  process.exit(1);
}

const api = new PqpApi({ baseUrl: apiUrl, token });
await api.ensureAgeGate();
await api.setProfile({ displayName: who });
try {
  await api.joinInvite(placement.inviteCode);
} catch (error) {
  if (!/already/i.test(String(error.message))) {
    throw error;
  }
}

const socket = new PqpSocket({ wsUrl, token, label: who });
await socket.connect();
socket.joinChannel(placement.channelId);
socket.send(body);
// The send is fire-and-forget on an open socket; give the frame a moment to
// leave before closing it out from under itself.
await sleep(400);
socket.close();

console.log(`${who} → #${placement.channelName}: ${body}`);
