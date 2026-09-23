import { expect, test, type Page } from "@playwright/test";

/**
 * The app shell never scrolls. Only the panes inside it do.
 *
 * Reported 2026-09-23 on a busy community channel: after a while the whole app
 * sat about 110 px too high, the server header cut off at the top and a black
 * band under the composer. Nothing had scrolled the document; the thing that
 * moved was the shell, `#root > div`, which is `overflow: hidden` and therefore
 * still a scroll container that script can move.
 *
 * Two halves had to meet:
 *
 * 1. The shell had something to scroll. Every member row with a rank mark
 *    (owner crown, VIP star, bot...) carries an `sr-only` label, which is
 *    `position: absolute`. Neither the member list's scroller nor its `<aside>`
 *    was positioned, so the label's containing block was the shell itself and
 *    it escaped the scroller's clip: a VIP forty rows down the roster sat,
 *    invisibly, 1 px tall, below the bottom of the window, and the shell's
 *    scrollable height grew to reach it.
 * 2. Something scrolled it. Landing on the NEW divider is
 *    `scrollIntoView({ block: "center" })`, which scrolls EVERY scrollable
 *    ancestor, `overflow: hidden` ones included. With only a few unread
 *    messages the transcript cannot scroll far enough to centre the divider,
 *    so the rest of the distance went to the shell.
 *
 * So the oracle is geometric, not visual: the document and the shell are at
 * scroll offset zero and have nothing to scroll, through the moves that
 * scroll a transcript.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialise(suffix: string): Promise<{ id: string }> {
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as {
    id: string;
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
  return { id: me.id };
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

async function messageCount(
  suffix: string,
  channelId: string,
): Promise<number> {
  const res = await fetch(
    `${API}/api/channels/${channelId}/messages?limit=100`,
    {
      headers: headersFor(suffix),
    },
  );
  const { messages } = (await res.json()) as { messages: unknown[] };
  return messages.length;
}

interface Seeded {
  serverId: string;
  channelId: string;
  owner: string;
}

/**
 * A server shaped like the one in the report: a roster long enough to run past
 * the bottom of the window with a rank mark on the rows down there, and a
 * channel whose NEW divider sits a few messages from the end.
 */
async function seed(): Promise<Seeded> {
  const stamp = Date.now().toString(36);
  const owner = `shell-owner-${stamp}`;
  const guest = `shell-guest-${stamp}`;
  await materialise(owner);
  await materialise(guest);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Shell ${stamp}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const { channels } = (await (
    await fetch(`${API}/api/servers/${server.id}/channels`, {
      headers: headersFor(owner),
    })
  ).json()) as { channels: { id: string; type: string }[] };
  const channel = channels.find((one) => one.type === "text")!;
  const { roles } = (await (
    await fetch(`${API}/api/servers/${server.id}/roles`, {
      headers: headersFor(owner),
    })
  ).json()) as { roles: { id: string; systemKey: string | null }[] };
  const vip = roles.find((role) => role.systemKey === "vip")!;
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(owner),
      body: "{}",
    })
  ).json()) as { invite: { code: string } };

  // Thirty VIPs: the star (and its `sr-only` "VIP") on every row, the lower
  // rows well below a 900 px window.
  const joiners = [
    guest,
    ...Array.from({ length: 30 }, (_, i) => `shell-vip${i}-${stamp}`),
  ];
  for (const suffix of joiners) {
    const { id } = await materialise(suffix);
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(suffix),
    });
    expect(joined.ok, `join ${suffix}`).toBe(true);
    if (suffix !== guest) {
      // Without the star there is no sr-only label, and the test would pass
      // without exercising anything.
      const granted = await fetch(
        `${API}/api/servers/${server.id}/members/${id}/roles/${vip.id}`,
        { method: "PUT", headers: headersFor(owner) },
      );
      expect(granted.ok, `VIP for ${suffix}`).toBe(true);
    }
  }

  // Read history, then a SHORT unread tail: the transcript cannot scroll far
  // enough to centre a divider three rows from the end.
  await sendMessages(
    owner,
    channel.id,
    Array.from(
      { length: 40 },
      (_, i) => `earlier ${i} ${"lorem ipsum ".repeat(i % 6)}`,
    ),
    40,
  );
  await fetch(`${API}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headersFor(owner),
  });
  await sendMessages(
    guest,
    channel.id,
    ["new one", "new two", "new three"],
    43,
  );

  return { serverId: server.id, channelId: channel.id, owner };
}

interface ShellGeometry {
  documentScrollTop: number;
  documentOverflow: number;
  shellScrollTop: number;
  shellOverflow: number;
}

function geometry(page: Page): Promise<ShellGeometry> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const shell = document.querySelector<HTMLElement>("#root > div");
    return {
      documentScrollTop: root.scrollTop,
      documentOverflow: root.scrollHeight - window.innerHeight,
      shellScrollTop: shell?.scrollTop ?? 0,
      shellOverflow: shell ? shell.scrollHeight - shell.clientHeight : 0,
    };
  });
}

const STILL: ShellGeometry = {
  documentScrollTop: 0,
  documentOverflow: 0,
  shellScrollTop: 0,
  shellOverflow: 0,
};

/**
 * Absolutely positioned boxes that escape a scroll container because their
 * containing block is outside it. Each one is invisible scrollable height
 * handed to whatever is further up; this is the cause, the geometry above is
 * the symptom.
 */
function escapingBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll("#root *"))) {
      if (getComputedStyle(el).position !== "absolute") {
        continue;
      }
      if (el.getClientRects().length === 0) {
        continue;
      }
      for (
        let up = el.parentElement;
        up && up.id !== "root";
        up = up.parentElement
      ) {
        const style = getComputedStyle(up);
        if (
          style.position !== "static" ||
          style.transform !== "none" ||
          /paint|layout|strict|content/.test(style.contain)
        ) {
          break;
        }
        if (style.overflowY !== "visible" || style.overflowX !== "visible") {
          found.push(
            `"${(el.textContent ?? "").trim().slice(0, 24)}" escapes ${up.tagName.toLowerCase()}.${String(up.className).slice(0, 60)}`,
          );
          break;
        }
      }
    }
    return found;
  });
}

test("landing on the NEW divider scrolls the transcript, never the app", async ({
  page,
}) => {
  const seeded = await seed();
  await page.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, seeded.owner);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}?lang=en`,
  );
  await expect(page.getByRole("separator", { name: "New" })).toBeVisible({
    timeout: 20_000,
  });
  // The roster has to be down to its lower rows for the escape to matter.
  await expect(page.locator("[data-member-sidebar]")).toContainText(
    "shell-vip29",
    {
      timeout: 20_000,
    },
  );
  await expect(
    page.locator("[data-member-sidebar] [data-rank-mark='vip']"),
  ).toHaveCount(30);
  // Let the landing effect and its one extra frame run.
  await page.waitForTimeout(500);

  expect(await geometry(page)).toEqual(STILL);

  // The move that reproduced it: the roster is loaded by now, so the shell
  // has had its invisible height for a while, and "Mark as unread" lands the
  // divider again. Before the fix this left the shell 274px down.
  await page
    .getByRole("article")
    .filter({ hasText: "new two" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(page.getByRole("separator", { name: "New" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await geometry(page)).toEqual(STILL);
  expect(await escapingBoxes(page)).toEqual([]);

  // A wheel past the end of the transcript must not chain into the document.
  await page.getByRole("log").hover();
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  expect(await geometry(page)).toEqual(STILL);

  // Keyboard focus scrolls ancestors into view too.
  await page.getByPlaceholder(/^Message /).focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(300);
  expect(await geometry(page)).toEqual(STILL);

  // Narrower and shorter: the roster runs further past the fold.
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.waitForTimeout(300);
  expect(await escapingBoxes(page)).toEqual([]);
  expect(await geometry(page)).toEqual(STILL);
});

test("a phone gets the same still frame", async ({ page }) => {
  const seeded = await seed();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, seeded.owner);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}?lang=en`,
  );
  await expect(page.getByRole("separator", { name: "New" })).toBeVisible({
    timeout: 20_000,
  });
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeInViewport();
  await composer.focus();
  await page.waitForTimeout(300);
  expect(await geometry(page)).toEqual(STILL);
});

test("the marketing pages are ordinary scrolling documents", async ({
  page,
}) => {
  // The app route switches the document to a still frame while it is
  // mounted; nothing outside it may inherit that.
  for (const path of [
    "/",
    "/vem",
    "/c/nao-existe-aqui",
    "/@ninguem_aqui_mesmo",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const state = await page.evaluate(() => ({
      flagged: document.documentElement.hasAttribute("data-app-shell"),
      html: getComputedStyle(document.documentElement).overflowY,
      body: getComputedStyle(document.body).overflowY,
    }));
    expect(state, path).toEqual({
      flagged: false,
      html: "visible",
      body: "visible",
    });
  }
  for (const path of ["/", "/vem"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const scrolled = await page.evaluate(async () => {
      const root = document.scrollingElement ?? document.documentElement;
      window.scrollTo({ top: 400, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return root.scrollTop;
    });
    expect(scrolled, path).toBeGreaterThan(0);
  }
});
