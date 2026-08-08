#!/usr/bin/env node
/**
 * Print a channel as a reader would see it — author, body, reactions.
 *
 * Reads back through the same API a client uses, so what it prints is what a
 * visitor would actually find in the server, not what the runner believes it
 * posted. That distinction is the point: this is how you check that guardrails
 * and rate caps did what they claimed.
 *
 *   node scripts/transcript.mjs [serverName]
 */
const API = process.env.AMBIENT_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = `${process.env.AMBIENT_DEV_TOKEN ?? "dev-local-token"}:ambienthost`;

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const wanted = process.argv[2];
const { servers } = await api("/api/servers");
const server = wanted ? servers.find((s) => s.name === wanted) : servers[0];
if (!server) {
  console.error(`No server found${wanted ? ` named ${wanted}` : ""}.`);
  process.exit(1);
}

const { channels } = await api(`/api/servers/${server.id}/channels`);
const channel = channels.find((c) => c.type === "text");
const { messages } = await api(`/api/channels/${channel.id}/messages`);

console.log(`# ${server.name} — #${channel.name}\n`);
for (const message of messages) {
  const reactions = (message.reactions ?? [])
    .map((r) => `${r.emoji}${r.count}`)
    .join(" ");
  const time = new Date(message.createdAt).toISOString().slice(11, 19);
  console.log(
    `${time}  ${message.authorName.padEnd(16)}${message.body}` +
      (reactions ? `   [${reactions}]` : ""),
  );
}
