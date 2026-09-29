import { expect, test } from "@playwright/test";

/**
 * A message that arrives in the channel on screen is marked read, so the next
 * visit's NEW rule does not sit above it. Only when the reader could see it,
 * though: one that lands below a reader scrolled up in history stays unread
 * until they scroll back down to the live end.
 *
 * Read through the server's own unread count, which is the cursor itself and
 * what the NEW rule and the sidebar badge are drawn from.
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

async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as {
    ageGate?: string;
  };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
}

async function messageCount(
  suffix: string,
  channelId: string,
): Promise<number> {
  const res = await fetch(
    `${API}/api/channels/${channelId}/messages?limit=100`,
    { headers: headersFor(suffix) },
  );
  const { messages } = (await res.json()) as { messages: unknown[] };
  return messages.length;
}

/** Sending is a WebSocket frame; there is no HTTP route for a person. */
async function sendMessages(
  suffix: string,
  channelId: string,
  bodies: string[],
  expectTotal: number,
): Promise<void> {
  const socket = new WebSocket(WS_URL);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    const ready = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        if (
          (JSON.parse(String(event.data)) as { type: string }).type === "ready"
        ) {
          resolve();
        }
      });
    });
    socket.send(
      JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }),
    );
    await ready;
    for (const body of bodies) {
      socket.send(JSON.stringify({ type: "message-create", channelId, body }));
    }
    // Closing straight away can drop frames still queued behind the socket.
    await expect.poll(() => messageCount(suffix, channelId)).toBe(expectTotal);
  } finally {
    socket.close();
  }
}

async function unreadCount(
  suffix: string,
  serverId: string,
  channelId: string,
): Promise<number> {
  const res = await fetch(`${API}/api/servers/${serverId}/unread`, {
    headers: headersFor(suffix),
  });
  const { unread } = (await res.json()) as {
    unread: { channelId: string; count: number }[];
  };
  return unread.find((row) => row.channelId === channelId)?.count ?? 0;
}

interface Seeded {
  serverId: string;
  channelId: string;
  /** A second text channel, short: it never scrolls. */
  otherChannelId: string;
  owner: string;
  guest: string;
}

/** A channel with enough read history to scroll, and a second member. */
async function seed(): Promise<Seeded> {
  const stamp = Date.now().toString(36);
  const owner = `ack-owner-${stamp}`;
  const guest = `ack-guest-${stamp}`;
  await materialise(owner);
  await materialise(guest);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Ack ${stamp}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const { channels } = (await (
    await fetch(`${API}/api/servers/${server.id}/channels`, {
      headers: headersFor(owner),
    })
  ).json()) as { channels: { id: string; type: string }[] };
  const channel = channels.find((one) => one.type === "text")!;
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(owner),
      body: "{}",
    })
  ).json()) as { invite: { code: string } };
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(guest),
  });
  expect(joined.ok).toBe(true);

  const other = await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: "short", type: "text" }),
  });
  expect(other.ok).toBe(true);
  const { channel: otherChannel } = (await other.json()) as {
    channel: { id: string };
  };

  await sendMessages(
    guest,
    channel.id,
    Array.from(
      { length: 40 },
      (_, i) => `history ${i} ${"lorem ipsum ".repeat(i % 6)}`,
    ),
    40,
  );
  return {
    serverId: server.id,
    channelId: channel.id,
    otherChannelId: otherChannel.id,
    owner,
    guest,
  };
}

async function openChannel(
  page: import("@playwright/test").Page,
  seeded: Seeded,
): Promise<void> {
  await page.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, seeded.owner);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}?lang=en`,
  );
  await expect(
    page.getByRole("log").getByText("history 39", { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  // Opening marked it read.
  await expect
    .poll(() => unreadCount(seeded.owner, seeded.serverId, seeded.channelId))
    .toBe(0);
}

test("a message that arrives at the live end is marked read", async ({
  page,
}) => {
  const seeded = await seed();
  await openChannel(page, seeded);

  await sendMessages(seeded.guest, seeded.channelId, ["seen live"], 41);
  await expect(page.getByRole("log").getByText("seen live")).toBeInViewport();
  await expect
    .poll(() => unreadCount(seeded.owner, seeded.serverId, seeded.channelId), {
      timeout: 10_000,
    })
    .toBe(0);
});

test("a message below a reader scrolled up stays unread until they scroll down", async ({
  page,
}) => {
  const seeded = await seed();
  await openChannel(page, seeded);

  const log = page.getByRole("log");
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    page.getByRole("button", { name: /jump to present|new message/i }),
  ).toBeVisible();

  await sendMessages(seeded.guest, seeded.channelId, ["arrived below"], 41);
  await expect(log.getByText("arrived below")).not.toBeInViewport();
  // Well past the quiet second the ack waits for.
  await page.waitForTimeout(3_000);
  expect(
    await unreadCount(seeded.owner, seeded.serverId, seeded.channelId),
  ).toBe(1);

  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(log.getByText("arrived below")).toBeInViewport();
  await expect
    .poll(() => unreadCount(seeded.owner, seeded.serverId, seeded.channelId), {
      timeout: 10_000,
    })
    .toBe(0);
});

test("scrolling up in one channel does not stop acks in the next", async ({
  page,
}) => {
  const seeded = await seed();
  // Unread waiting in the short channel: opening it lands on the NEW rule.
  await sendMessages(seeded.guest, seeded.otherChannelId, ["already read"], 1);
  await fetch(`${API}/api/channels/${seeded.otherChannelId}/read`, {
    method: "POST",
    headers: headersFor(seeded.owner),
  });
  await sendMessages(seeded.guest, seeded.otherChannelId, ["waiting"], 2);
  await openChannel(page, seeded);

  await page.getByRole("log").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    page.getByRole("button", { name: /jump to present|new message/i }),
  ).toBeVisible();

  // In the app, not a reload: the list is the same component across the
  // switch, and its scroll state must not follow the reader to the next one.
  await page
    .locator(`[data-channel-id="${seeded.otherChannelId}"]`)
    .first()
    .click();
  await expect(page.getByRole("log").getByText("waiting")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("separator", { name: "New" })).toBeVisible();
  await expect
    .poll(() =>
      unreadCount(seeded.owner, seeded.serverId, seeded.otherChannelId),
    )
    .toBe(0);

  await sendMessages(seeded.guest, seeded.otherChannelId, ["seen here"], 3);
  await expect(page.getByRole("log").getByText("seen here")).toBeInViewport();
  await expect
    .poll(
      () => unreadCount(seeded.owner, seeded.serverId, seeded.otherChannelId),
      { timeout: 10_000 },
    )
    .toBe(0);
});

test("a message that arrives while What's New covers the chat stays unread", async ({
  page,
}) => {
  const seeded = await seed();
  await openChannel(page, seeded);

  // The chat stays mounted under Novidades, still "at its live end".
  await page.locator("[data-whats-new-rail]").click();
  await expect(page.getByRole("log")).toBeHidden();

  await sendMessages(seeded.guest, seeded.channelId, ["arrived unseen"], 41);
  await page.waitForTimeout(3_000);
  expect(
    await unreadCount(seeded.owner, seeded.serverId, seeded.channelId),
  ).toBe(1);

  // Back on the chat, it is on screen and is read.
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("log").getByText("arrived unseen"),
  ).toBeInViewport();
  await expect
    .poll(() => unreadCount(seeded.owner, seeded.serverId, seeded.channelId), {
      timeout: 10_000,
    })
    .toBe(0);
});

test("a message that arrives while the Communities directory covers the chat stays unread", async ({
  page,
}) => {
  const seeded = await seed();
  await openChannel(page, seeded);

  // The directory is an opaque overlay; the chat stays mounted under it.
  await page.locator("[data-communities-rail]").click();
  await page.waitForTimeout(500);

  await sendMessages(seeded.guest, seeded.channelId, ["arrived under the directory"], 41);
  await page.waitForTimeout(3_000);
  expect(
    await unreadCount(seeded.owner, seeded.serverId, seeded.channelId),
  ).toBe(1);
});
