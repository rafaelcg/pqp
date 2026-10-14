import { expect, test, type Page } from "@playwright/test";

/**
 * The "+" on the own story ring was nearly impossible to hit (a 24 px dot whose click area was the dot, so
 * clicks at its edge opened the stories). It is a 32 px target with a mouse and 44 px on a touch screen, it
 * wins over the ring's own click, and the ring offers "New story" on a right-click or a long-press.
 * Every point is hit-tested with `elementFromPoint` and then really clicked.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(90_000);

const headersFor = (suffix: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` });

async function setup() {
  const suffix = `st-own-${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`.toLowerCase().slice(0, 32);
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as { ageGate?: string };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
  const created = await fetch(`${API}/api/servers`, { method: "POST", headers, body: JSON.stringify({ name: `Own ${Date.now()}` }) });
  const { server } = (await created.json()) as { server: { id: string } };
  const channels = (await (await fetch(`${API}/api/servers/${server.id}/channels`, { headers })).json()) as {
    channels: { id: string; type: string }[];
  };
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: server.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  const story = await fetch(`${API}/api/stories`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "text", text: "oi", background: "night", audiences: { serverIds: [server.id] } }),
  });
  expect(story.status).toBe(201);
  return { suffix, serverId: server.id, channelId: channels.channels.find((c) => c.type === "text")!.id };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function openOwnStrip(page: Page, ctx: Ctx) {
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.suffix);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  const nav = page.getByRole("button", { name: "Open navigation" });
  if (await nav.isVisible().catch(() => false)) {
    await nav.click();
  }
  const plus = page.locator(`[data-story-strip="server:${ctx.serverId}"] [data-story-plus]`);
  await expect(plus).toBeVisible({ timeout: 20_000 });
  // The drawer of a narrow window slides in.
  await expect.poll(async () => ((await plus.boundingBox())?.x ?? -1) >= 0).toBe(true);
  await page.waitForTimeout(500);
  return plus;
}

/** What a click at (x, y) reaches: the badge, the ring, or something else. */
function reached(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const found = document.elementFromPoint(x, y);
      return found?.closest("[data-story-plus]") ? "plus" : found?.closest("[data-story-ring]") ? "ring" : "other";
    },
    { x, y },
  );
}

const ringOf = (page: Page, ctx: Ctx) => page.locator(`[data-story-ring="server:${ctx.serverId}:own"]`);

test("the + on the own ring is a 32 px target with a mouse and wins over the ring's own click", async ({ page }) => {
  const ctx = await setup();
  const plus = await openOwnStrip(page, ctx);
  const box = (await plus.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The dot is drawn 24 px; every edge of a 32 px square around it is the badge's.
  for (const [dx, dy] of [[15, 0], [-15, 0], [0, 15], [0, -15], [15, 15], [-15, -15], [15, -15], [-15, 15]]) {
    expect(await reached(page, cx + dx!, cy + dy!), `(${dx}, ${dy}) from the centre`).toBe("plus");
  }
  // ...and just past it is the ring or nothing, so the target did not grow without bound.
  expect(await reached(page, cx + 22, cy + 22)).not.toBe("plus");
  // A real click at the edge opens the composer, not the story.
  await page.mouse.click(cx + 15, cy + 15);
  await expect(page.getByRole("dialog", { name: "New story" })).toBeVisible();
  await expect(page.locator("[data-story-root]")).toHaveCount(0);
});

test("the own ring offers New story on a right-click, and a plain click on it still opens the story", async ({ page }) => {
  const ctx = await setup();
  await openOwnStrip(page, ctx);
  const box = (await ringOf(page, ctx).boundingBox())!;
  // The top left of the ring, far from the badge.
  const x = box.x + 10;
  const y = box.y + 10;
  expect(await reached(page, x, y)).toBe("ring");
  await page.mouse.click(x, y, { button: "right" });
  await page.getByRole("menuitem", { name: "New story" }).click();
  await expect(page.getByRole("dialog", { name: "New story" })).toBeVisible();

  const second = await setup();
  await openOwnStrip(page, second);
  const again = (await ringOf(page, second).boundingBox())!;
  await page.mouse.click(again.x + 10, again.y + 10);
  await expect(page.locator("[data-story-root]").first()).toBeVisible({ timeout: 15_000 });
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the + on the own ring is a 44 px target", async ({ page }) => {
    const ctx = await setup();
    const plus = await openOwnStrip(page, ctx);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const box = (await plus.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const [dx, dy] of [[21, 0], [-21, 0], [0, 21], [0, -21], [20, 20], [-20, -20]]) {
      expect(await reached(page, cx + dx!, cy + dy!), `(${dx}, ${dy}) from the centre`).toBe("plus");
    }
    await page.touchscreen.tap(cx + 20, cy + 20);
    await expect(page.getByRole("dialog", { name: "New story" })).toBeVisible();
  });
});
