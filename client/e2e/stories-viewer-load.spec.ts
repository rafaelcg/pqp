import { expect, test, type Page } from "@playwright/test";

/**
 * The viewer on a link that does not deliver: a story is NEVER shown with a picture missing or half
 * drawn. While its pieces are slow the card keeps its placeholder, then says "Didn't load" with a Retry,
 * and a real click on Retry shows it whole once the pieces arrive. The header icons are 44 px boxes whose
 * corners are the button's too (a tap there must not fall through to the stage and skip the story).
 *
 * Needs object storage (a story with a picture): skipped without it, like the other upload specs.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

const headersFor = (suffix: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` });
const suffixFor = (name: string) => `${name}-${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`.toLowerCase().slice(0, 32);

async function account(suffix: string, displayName: string) {
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
  await fetch(`${API}/api/me`, { method: "PATCH", headers, body: JSON.stringify({ displayName }) });
}

/** A noisy JPEG made in the page (nothing to ship in the repo). */
async function noisePhoto(page: Page, kb: number): Promise<Buffer> {
  const base64 = await page.evaluate(async (target) => {
    const side = Math.ceil(Math.sqrt((target * 1024) / 1.1));
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(side, side);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = Math.random() * 255;
      image.data[i + 1] = Math.random() * 255;
      image.data[i + 2] = Math.random() * 255;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9));
    let binary = "";
    for (const byte of new Uint8Array(await blob.arrayBuffer())) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, kb);
  return Buffer.from(base64, "base64");
}

async function setup(page: Page) {
  const author = suffixFor("vl-a");
  const viewer = suffixFor("vl-v");
  await account(author, "Load Author");
  await account(viewer, "Load Viewer");
  const created = await fetch(`${API}/api/servers`, { method: "POST", headers: headersFor(author), body: JSON.stringify({ name: `Load ${Date.now()}` }) });
  const { server } = (await created.json()) as { server: { id: string } };
  const channels = (await (await fetch(`${API}/api/servers/${server.id}/channels`, { headers: headersFor(author) })).json()) as {
    channels: { id: string; type: string }[];
  };
  const invite = (await (await fetch(`${API}/api/servers/${server.id}/invites`, { method: "POST", headers: headersFor(author), body: JSON.stringify({}) })).json()) as {
    invite: { code: string };
  };
  await fetch(`${API}/api/invites/${invite.invite.code}/join`, { method: "POST", headers: headersFor(viewer) });
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: server.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  const config = (await (await fetch(`${API}/api/stories/config`, { headers: headersFor(author) })).json()) as { mediaEnabled?: boolean };
  test.skip(!config.mediaEnabled, "object storage is off: no pictures to load");
  // Two photo stories by the author, through the plain flow (create, PUT, publish).
  for (let i = 0; i < 2; i += 1) {
    const bytes = await noisePhoto(page, 150);
    const made = await fetch(`${API}/api/stories`, {
      method: "POST",
      headers: headersFor(author),
      body: JSON.stringify({
        kind: "image",
        audiences: { serverIds: [server.id] },
        media: { contentType: "image/jpeg", byteSize: bytes.length, width: 400, height: 400 },
      }),
    });
    const body = (await made.json()) as { story: { id: string }; upload: { url: string; headers: Record<string, string> } };
    expect(made.status).toBe(201);
    const put = await fetch(body.upload.url, { method: "PUT", headers: body.upload.headers, body: bytes });
    expect(put.ok).toBe(true);
    expect((await fetch(`${API}/api/stories/${body.story.id}/publish`, { method: "POST", headers: headersFor(author) })).status).toBe(200);
  }
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), viewer);
  return { serverId: server.id, channelId: channels.channels.find((c) => c.type === "text")!.id };
}

async function samplePartialFrames(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __partial: unknown[] }).__partial = [];
    const tick = () => {
      for (const reveal of document.querySelectorAll('[data-story-reveal="shown"]')) {
        if (Number(getComputedStyle(reveal).opacity) > 0) {
          const bad = [...reveal.querySelectorAll("img")].filter((i) => !(i.complete && i.naturalWidth > 0));
          if (bad.length) (window as unknown as { __partial: unknown[] }).__partial.push(bad.length);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test("a story that cannot load says so, never shows half a picture, and Retry shows it whole", async ({ page }) => {
  const ctx = await setup(page);
  // The media store stops answering; the API stays up. Requests wait until it is released.
  let starved = false;
  await page.route("**/pqp-attachments/**", async (route) => {
    while (starved) await new Promise((resolve) => setTimeout(resolve, 100));
    await route.continue().catch(() => undefined);
  });
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  const nav = page.getByRole("button", { name: "Open navigation" });
  if (await nav.isVisible().catch(() => false)) {
    await nav.click();
  }
  const ring = page.locator("[data-story-ring]:not([data-story-ring$=':own'])").first();
  await expect(ring).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => ((await ring.boundingBox())?.x ?? -1) >= 0).toBe(true);
  await page.waitForTimeout(500);
  await samplePartialFrames(page);

  starved = true;
  // Wait out the tray warming (it was released before the starve) by opening a ring whose pictures are not cached.
  const box = (await ring.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("[data-story-stalled]")).toBeVisible({ timeout: 40_000 });
  // Hidden, not half drawn.
  expect(await page.evaluate(() => Number(getComputedStyle(document.querySelector("[data-story-reveal]")!).opacity))).toBe(0);
  await expect(page.getByText("Didn't load")).toBeVisible();

  starved = false;
  const retry = page.locator("[data-story-load-retry]");
  const rb = (await retry.boundingBox())!;
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-story-load-retry]") !== null, {
    x: rb.x + rb.width / 2,
    y: rb.y + rb.height / 2,
  });
  expect(hit, "a click on Retry reaches the Retry button, not the stage").toBe(true);
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await expect(page.locator('[data-story-reveal="shown"]')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-story-reveal="shown"] img')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __partial: unknown[] }).__partial.length), "no frame showed a half-loaded picture").toBe(0);
});

test("a tap in the corner of a header icon's 44 px box is the icon's, and does not skip the story", async ({ page }) => {
  const ctx = await setup(page);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  const nav = page.getByRole("button", { name: "Open navigation" });
  if (await nav.isVisible().catch(() => false)) {
    await nav.click();
  }
  const ring = page.locator("[data-story-ring]:not([data-story-ring$=':own'])").first();
  await expect(ring).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => ((await ring.boundingBox())?.x ?? -1) >= 0).toBe(true);
  await page.waitForTimeout(500);
  const box = (await ring.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  const bar = () => page.locator('[data-story-bar="current"]').count();
  const bars = await page.locator("[data-story-bar]").evaluateAll((els) => els.map((el) => el.getAttribute("data-story-bar")));
  const pb = (await pause.boundingBox())!;
  expect(Math.round(pb.width)).toBe(44);
  // The left corners of the box (a pixel inside): outside the round button, inside its 44 px.
  for (const dy of [-21, 21]) {
    const x = pb.x + pb.width / 2 - 21;
    const y = pb.y + pb.height / 2 + dy;
    const reached = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? "none", { x, y });
    expect(["Pause", "Play"], `(${dy}) reaches the icon`).toContain(reached);
    await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  }
  // Two toggles: paused and playing again, and the walk never moved.
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  expect(await page.locator("[data-story-bar]").evaluateAll((els) => els.map((el) => el.getAttribute("data-story-bar")))).toEqual(bars);
  expect(await bar()).toBe(1);
});
