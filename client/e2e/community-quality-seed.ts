import { expect } from "@playwright/test";

/**
 * Make a seeded community clear the directory's quality bar.
 *
 * Browsing shows a listed room only while it has three people in it and a
 * person wrote in it in the last 30 days (`DIRECTORY_MIN_HUMAN_MEMBERS`,
 * `DIRECTORY_ACTIVE_WINDOW_DAYS` in `@pqp/shared`). A suite that seeds an
 * owner plus one filler, with no messages, gets an empty grid and no error;
 * this adds the third person and one message from the owner.
 *
 * Sending is a WebSocket frame: there is no HTTP route for a person.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";

function headers(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function ensureAccount(suffix: string): Promise<void> {
  const me = await fetch(`${API}/api/me`, { headers: headers(suffix) });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate === "passed") {
    return;
  }
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
}

async function newestBodies(suffix: string, channelId: string): Promise<string[]> {
  const res = await fetch(`${API}/api/channels/${channelId}/messages`, {
    headers: headers(suffix),
  });
  const { messages } = (await res.json()) as { messages: { body: string }[] };
  return messages.map((message) => message.body);
}

async function say(suffix: string, channelId: string, body: string): Promise<void> {
  const socket = new WebSocket(WS_URL);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    const ready = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type: string }).type === "ready") {
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }));
    await ready;
    socket.send(JSON.stringify({ type: "message-create", channelId, body }));
    await expect.poll(() => newestBodies(suffix, channelId)).toContain(body);
  } finally {
    socket.close();
  }
}

/**
 * `channels` is what `POST /api/servers` answered with; the first text one
 * gets the message.
 */
export async function clearQualityBar(options: {
  serverId: string;
  channels: { id: string; type: string }[];
  owner: string;
  thirdMember: string;
}): Promise<void> {
  await ensureAccount(options.thirdMember);
  const invite = await fetch(`${API}/api/servers/${options.serverId}/invites`, {
    method: "POST",
    headers: headers(options.owner),
    body: JSON.stringify({}),
  });
  const { invite: made } = (await invite.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${made.code}/join`, {
    method: "POST",
    headers: headers(options.thirdMember),
  });
  const text = options.channels.find((channel) => channel.type === "text");
  if (!text) {
    throw new Error("a new server should come with a text channel");
  }
  await say(options.owner, text.id, "oi, pessoal");
}
