import { expect, test } from "@playwright/test";

/**
 * THE RAIL SAYS WHAT HAPPENED IN THE SERVERS YOU WERE NOT LOOKING AT.
 *
 * Production, 2026-10-13: "the channel badge notifications are not showing up".
 * The open server read as caught up and no other server icon lit, while the
 * server held unread for other servers. The cause was that unread was only
 * ever fetched for the SELECTED server, and the live `channel-activity` frame
 * is the only other writer, a one-shot nothing replays. Anything that arrived
 * while this tab had no socket (a reload, the laptop asleep, an API restart)
 * was never drawn.
 *
 * Every earlier check sent the message while the reader's page was already
 * open, which is the one shape that always worked. This one posts BEFORE the
 * reader's page exists, so the only way the icon can light is by asking the
 * server on load.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function api<T>(
  suffix: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: headersFor(suffix),
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function materialise(suffix: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(suffix, "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await api(suffix, "/api/me/age-check", {
      method: "POST",
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  const now = new Date().toISOString();
  await api(suffix, "/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
}

interface Made {
  server: { id: string; name: string };
  channels: { id: string; type: string; name: string }[];
}

async function makeServer(suffix: string, name: string): Promise<Made> {
  return api<Made>(suffix, "/api/servers", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

async function join(owner: string, joiner: string, serverId: string) {
  const { invite } = await api<{ invite: { code: string } }>(
    owner,
    `/api/servers/${serverId}/invites`,
    { method: "POST", body: JSON.stringify({}) },
  );
  await api(joiner, `/api/invites/${invite.code}/join`, { method: "POST" });
}

async function say(
  suffix: string,
  channelId: string,
  body: string,
): Promise<void> {
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
    await expect
      .poll(async () => {
        const { messages } = await api<{ messages: { body: string }[] }>(
          suffix,
          `/api/channels/${channelId}/messages?limit=20`,
        );
        return messages.some((m) => m.body === body);
      })
      .toBe(true);
  } finally {
    socket.close();
  }
}

test("a server that got messages while this tab was away lights its icon on load", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const ana = `rail-ana-${tag}`;
  const bia = `rail-bia-${tag}`;
  await materialise(ana);
  await materialise(bia);

  // Ana's first server is the one she lands on; the second is the one that
  // gets the news.
  const first = await makeServer(ana, `Rail first ${tag}`);
  const quiet = await makeServer(ana, `Rail quiet ${tag}`);
  const busy = await makeServer(ana, `Rail busy ${tag}`);
  await join(ana, bia, quiet.server.id);
  await join(ana, bia, busy.server.id);
  void first;

  const quietText = quiet.channels.find((c) => c.type === "text")!;
  const busyText = busy.channels.find((c) => c.type === "text")!;
  const me = await api<{ username: string }>(ana, "/api/me");

  // Posted with no page open for Ana: no socket, so no live frame to count.
  await say(bia, quietText.id, "anyone around?");
  await say(bia, busyText.id, `@${me.username} look at this`);

  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), ana);
  await page.goto("/app?lang=en");

  const quietIcon = page.getByRole("button", { name: quiet.server.name, exact: true });
  const busyIcon = page.getByRole("button", { name: busy.server.name, exact: true });
  await expect(quietIcon).toBeVisible({ timeout: 20_000 });

  // The one that only said something: the pip (and the screen-reader text).
  await expect(quietIcon.locator(".sr-only")).toHaveText("unread messages", {
    timeout: 15_000,
  });
  // The one that named her: the red count.
  await expect(busyIcon.locator(".sr-only")).toHaveText("1 unread mention", {
    timeout: 15_000,
  });

  // Reading it clears it: open the server, then look at the rail again.
  await busyIcon.click();
  await page.getByRole("button", { name: new RegExp(busyText.name) }).first().click();
  await expect(busyIcon.locator(".sr-only")).toHaveCount(0, { timeout: 10_000 });
  // And the other server is still lit, because nobody read it.
  await expect(quietIcon.locator(".sr-only")).toHaveText("unread messages");
});
