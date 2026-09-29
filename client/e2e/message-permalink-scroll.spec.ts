import { expect, test, type Page } from "@playwright/test";

/**
 * A permalink or a search result lands on its message, and stays there.
 *
 * Reported 2026-09-28: opening `/app/server/<id>/channel/<id>/message/<id>`,
 * or clicking a Cmd+K result, opened the channel and left it pinned to the
 * bottom. The row was flashed, off screen. Only a message already in the
 * loaded page was affected; an older one is fetched around and worked.
 *
 * The jump starts a smooth scroll, and its first scroll events are still near
 * the bottom, so the list re-pinned itself. Rows are `content-visibility:
 * auto` and take their real height as the animation passes them; the
 * ResizeObserver saw a pinned list change size and snapped it back to the
 * tail. So the oracle is where the row IS once things have settled, not that
 * something scrolled.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";
/** Enough for the first page (50) to start well after the first message. */
const HISTORY = 80;

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

async function listMessages(
  suffix: string,
  channelId: string,
): Promise<{ id: string; body: string }[]> {
  const res = await fetch(
    `${API}/api/channels/${channelId}/messages?limit=100`,
    { headers: headersFor(suffix) },
  );
  const { messages } = (await res.json()) as {
    messages: { id: string; body: string }[];
  };
  return messages;
}

/** What the server says to one `message-create`, matched by its nonce. */
interface Answer {
  type: string;
  retryAfterMs?: number;
}

/**
 * Sending is a WebSocket frame; there is no HTTP route for a person.
 *
 * One at a time, each waited for, and paced under the socket's general frame
 * budget (60 burst, 20/s: `server/src/ws/frame-budget.ts`), which closes a
 * socket that sends 80 in a hurry. The ids are looked up by body afterwards,
 * so the order matters too. A rejection is retried after the wait it names.
 */
async function sendMessages(
  suffix: string,
  channelId: string,
  bodies: string[],
): Promise<void> {
  const socket = new WebSocket(WS_URL);
  const answers = new Map<string, (frame: Answer) => void>();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    const ready = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Answer & {
          nonce?: string;
        };
        if (frame.type === "ready") {
          resolve();
        }
        if (frame.nonce) {
          answers.get(frame.nonce)?.(frame);
        }
      });
    });
    socket.send(
      JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }),
    );
    await ready;
    const closed = new Promise<never>((_, reject) => {
      socket.addEventListener("close", (event) =>
        reject(new Error(`socket closed (${event.code}) while seeding`)),
      );
    });
    socket.send(JSON.stringify({ type: "join-channel", channelId }));
    for (const [index, body] of bodies.entries()) {
      for (let attempt = 0; ; attempt += 1) {
        const nonce = `${index}-${attempt}`;
        await new Promise((resolve) => setTimeout(resolve, 60));
        const frame = await Promise.race([
          closed,
          new Promise<Answer>((resolve) => {
            answers.set(nonce, resolve);
            socket.send(
              JSON.stringify({
                type: "message-create",
                channelId,
                body,
                nonce,
              }),
            );
          }),
        ]);
        answers.delete(nonce);
        if (frame.type !== "message-rejected") {
          break;
        }
        expect(attempt, `"${body}" keeps being rejected`).toBeLessThan(10);
        await new Promise((resolve) =>
          setTimeout(resolve, frame.retryAfterMs ?? 500),
        );
      }
    }
  } finally {
    socket.close();
  }
}

interface Seeded {
  serverId: string;
  channelId: string;
  owner: string;
  guest: string;
  /** Message id by its number in "history message N". */
  ids: Map<number, string>;
}

async function seed(): Promise<Seeded> {
  const stamp = Date.now().toString(36);
  const owner = `permalink-owner-${stamp}`;
  const guest = `permalink-guest-${stamp}`;
  await materialise(owner);
  await materialise(guest);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Permalink ${stamp}` }),
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
  expect(joined.ok, "guest joins").toBe(true);

  await sendMessages(
    owner,
    channel.id,
    Array.from({ length: HISTORY }, (_, i) => `history message ${i + 1}`),
  );
  // Read, so opening the channel is a plain visit with no NEW divider.
  await fetch(`${API}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headersFor(owner),
  });

  const ids = new Map<number, string>();
  for (const message of await listMessages(owner, channel.id)) {
    const n = Number(/^history message (\d+)$/.exec(message.body)?.[1]);
    if (n) {
      ids.set(n, message.id);
    }
  }
  return { serverId: server.id, channelId: channel.id, owner, guest, ids };
}

interface Placement {
  /** Row centre minus transcript centre, in px. */
  offCentre: number;
  rowHeight: number;
  scrollTop: number;
  distanceFromBottom: number;
}

/** Where `history message <n>` sits in the transcript's viewport. */
function placement(page: Page, n: number): Promise<Placement | null> {
  return page.evaluate((n) => {
    const row = Array.from(document.querySelectorAll("article")).find((one) =>
      new RegExp(`history message ${n}(?!\\d)`).test(one.textContent ?? ""),
    );
    const scroller = row?.closest<HTMLElement>(".overflow-y-auto");
    if (!row || !scroller) {
      return null;
    }
    const box = scroller.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      offCentre: Math.round(
        rect.top + rect.height / 2 - (box.top + box.height / 2),
      ),
      rowHeight: Math.round(rect.height),
      scrollTop: Math.round(scroller.scrollTop),
      distanceFromBottom: Math.round(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      ),
    };
  }, n);
}

/**
 * The row ends up in the middle of the transcript and stays there. Polled to
 * get past the smooth scroll, then read again after a pause, because the bug
 * was a scroll that arrived and was then undone.
 */
async function expectSettledOn(page: Page, n: number): Promise<Placement> {
  // A cold Vite optimises its dependencies on the first visit and reloads.
  await expect(
    page.getByRole("article").filter({ hasText: `history message ${n}` }),
  ).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => Math.abs((await placement(page, n))?.offCentre ?? 9999), {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(24);
  await page.waitForTimeout(1_500);
  const settled = (await placement(page, n))!;
  expect(Math.abs(settled.offCentre)).toBeLessThanOrEqual(24);
  // Off the tail the list used to snap back to: past the 120px within which
  // the transcript counts as following the conversation.
  expect(settled.distanceFromBottom).toBeGreaterThan(120);
  return settled;
}

test.describe("message permalink scroll", () => {
  let seeded: Seeded;

  test.beforeAll(async () => {
    // Eighty paced sends: longer than a hook's default budget.
    test.setTimeout(90_000);
    seeded = await seed();
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((suffix) => {
      localStorage.setItem("pqp:dev-user-suffix", suffix);
    }, seeded.owner);
  });

  test("a permalink to a message in the first page lands on it", async ({
    page,
  }) => {
    // 55 of 80: inside the first page (31..80) and far from both ends of it.
    const target = 55;
    await page.goto(
      `/app/server/${seeded.serverId}/channel/${seeded.channelId}/message/${seeded.ids.get(target)}?lang=en`,
    );
    const settled = await expectSettledOn(page, target);

    // A live message while the reader is parked there counts as missed. It
    // does not drag them to the bottom.
    await sendMessages(seeded.guest, seeded.channelId, ["a live arrival"]);
    await expect(
      page.getByRole("button", { name: /1 new message/ }),
    ).toBeVisible();
    const after = (await placement(page, target))!;
    expect(after.scrollTop).toBe(settled.scrollTop);
  });

  test("a search result in the open channel lands on it", async ({ page }) => {
    await page.goto(
      `/app/server/${seeded.serverId}/channel/${seeded.channelId}?lang=en`,
    );
    // A plain visit still opens at the bottom.
    await expect(
      page
        .getByRole("article")
        .filter({ hasText: `history message ${HISTORY}` }),
    ).toBeAttached({ timeout: 30_000 });
    await expect
      .poll(async () => (await placement(page, HISTORY))?.distanceFromBottom)
      .toBeLessThanOrEqual(1);

    const target = 50;
    // The button the shortcut opens; the shortcut itself is Ctrl or Cmd by
    // user agent, which is not the test's subject.
    await page.getByRole("button", { name: /Search messages/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Search messages" })
      .fill(`history message ${target}`);
    await dialog
      .getByRole("option")
      .filter({ hasText: new RegExp(`history message ${target}$`) })
      .first()
      .click();
    await expectSettledOn(page, target);
  });
});
