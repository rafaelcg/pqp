import { expect, test, type Page } from "@playwright/test";

/**
 * Sending takes you to what you sent, wherever you were reading.
 *
 * Reported by the local E2E sweep: scrolled up in a busy channel, a send left
 * the view where it was, and the "N new messages" pill counted the reader's
 * own message as news. Twenty-five quick sends read "25 new messages". The
 * arrival effect in `message-list.tsx` counted every appended row and only
 * followed the bottom for a reader who was already sitting on it.
 *
 * The other half is kept too: somebody else's message still waits for a reader
 * who scrolled up, and still counts.
 *
 * From a jump into history the send goes back to the present. That run also
 * caught a page forward, still in flight when the window was replaced, landing
 * on the new window and dragging it back into the past (`windowGeneration` in
 * `use-chat.ts`).
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

async function newestBodies(
  suffix: string,
  channelId: string,
): Promise<string[]> {
  const res = await fetch(`${API}/api/channels/${channelId}/messages`, {
    headers: headersFor(suffix),
  });
  const { messages } = (await res.json()) as { messages: { body: string }[] };
  return messages.map((message) => message.body);
}

/** Sending is a WebSocket frame; there is no HTTP route for a person. */
async function sendMessages(
  suffix: string,
  channelId: string,
  bodies: string[],
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
    await expect
      .poll(() => newestBodies(suffix, channelId))
      .toContain(bodies.at(-1));
  } finally {
    socket.close();
  }
}

interface Seeded {
  serverId: string;
  channelId: string;
  owner: string;
  guest: string;
}

/** A channel long enough to scroll, all of it already read by the owner. */
async function seed(count: number): Promise<Seeded> {
  const stamp = Date.now().toString(36);
  const owner = `sendjump-owner-${stamp}`;
  const guest = `sendjump-guest-${stamp}`;
  await materialise(owner);
  await materialise(guest);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Send ${stamp}` }),
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

  // Long enough to wrap, so the first page alone is several screens tall and
  // scrolling up never reaches the top and pages in older history. Sent in
  // chunks: one socket asked for more than about sixty at once drops the rest.
  const bodies = Array.from(
    { length: count },
    (_, i) => `history ${i} ${"lorem ipsum dolor sit amet ".repeat(12).trim()}`,
  );
  for (let start = 0; start < bodies.length; start += 40) {
    await sendMessages(guest, channel.id, bodies.slice(start, start + 40));
  }
  await fetch(`${API}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headersFor(owner),
  });
  return { serverId: server.id, channelId: channel.id, owner, guest };
}

/** How far the transcript's scrollport is from its own bottom, in px. */
function distanceFromBottom(page: Page): Promise<number> {
  return page
    .getByRole("log")
    .evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight);
}

async function scrollUp(page: Page, px: number): Promise<void> {
  await page.getByRole("log").evaluate((log, by) => {
    log.scrollTop = log.scrollHeight - log.clientHeight - by;
  }, px);
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(px - 50);
  await expect(
    page.getByRole("button", { name: "Jump to present" }),
  ).toBeVisible();
}

test("sending while scrolled up lands on your message and counts nothing", async ({
  page,
}) => {
  const seeded = await seed(60);
  await page.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, seeded.owner);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}?lang=en`,
  );
  await expect(page.getByText("history 59 ")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  const composer = page.getByPlaceholder(/^Message /);

  // One send from well up the history.
  await scrollUp(page, 900);
  await composer.fill("sent from up here");
  await composer.press("Enter");
  await expect(page.getByText("sent from up here")).toBeInViewport();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(
    0,
  );

  // A burst: every one of them the reader's own, none of them news.
  await scrollUp(page, 900);
  for (let i = 0; i < 5; i += 1) {
    await composer.fill(`burst ${i}`);
    await composer.press("Enter");
  }
  await expect(page.getByText("burst 4")).toBeInViewport();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(
    0,
  );

  // Somebody else's message still waits for a reader who scrolled up.
  await scrollUp(page, 900);
  const before = await distanceFromBottom(page);
  await sendMessages(seeded.guest, seeded.channelId, ["from the guest"]);
  await expect(
    page.getByRole("button", { name: "1 new message" }),
  ).toBeVisible();
  expect(await distanceFromBottom(page)).toBeGreaterThan(before);
});

test("sending from a jump into history goes back to the present", async ({
  page,
}) => {
  // More than two pages, so a page around an old message stops well short of
  // the end.
  const seeded = await seed(120);
  const res = await fetch(
    `${API}/api/channels/${seeded.channelId}/messages?limit=100`,
    { headers: headersFor(seeded.owner) },
  );
  const { messages } = (await res.json()) as {
    messages: { id: string; body: string }[];
  };
  const old = messages.find((one) => one.body.startsWith("history 20 "))!;

  await page.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, seeded.owner);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}/message/${old.id}?lang=en`,
  );
  await expect(page.getByText("history 20 ")).toBeVisible({ timeout: 20_000 });
  // The window stops short of the present: that is what makes this a jump.
  await expect(
    page.getByRole("button", { name: "Load newer messages" }),
  ).toBeVisible();

  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("sent from the past");
  await composer.press("Enter");

  await expect(page.getByText("sent from the past")).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Load newer messages" }),
  ).toHaveCount(0);
  await expect(page.getByText("sent from the past")).toHaveCount(1);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);
  await expect(
    page.getByRole("button", { name: "Jump to present" }),
  ).toHaveCount(0);
});
