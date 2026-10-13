import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The story editor on a text card (no object storage needed): text layers,
 * drag, keyboard, pinch, the trash, undo, a mention, and what the server holds
 * after posting. Pointer events are driven for real (a mouse) and synthetic
 * (the two fingers of a pinch, which Playwright has no API for).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` };
}

async function account(suffix: string, displayName: string): Promise<string> {
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as { id: string; ageGate?: string };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
  await fetch(`${API}/api/me`, { method: "PATCH", headers, body: JSON.stringify({ displayName }) });
  return me.id;
}

async function setup() {
  const stamp = Date.now().toString(36);
  const owner = `st-ed-${stamp}`.toLowerCase().slice(0, 32);
  const guest = `st-eg-${stamp}`.toLowerCase().slice(0, 32);
  await account(owner, "Editor Owner");
  await account(guest, "Bia Guest");
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Editor ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const channels = (await (await fetch(`${API}/api/servers/${server.id}/channels`, { headers: headersFor(owner) })).json()) as {
    channels: { id: string; type: string }[];
  };
  const invite = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({}) })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.invite.code}/join`, { method: "POST", headers: headersFor(guest) });
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: server.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  return { owner, serverId: server.id, channelId: channels.channels.find((c) => c.type === "text")!.id };
}

async function openTextComposer(page: Page, ctx: Awaited<ReturnType<typeof setup>>) {
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.owner);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-server-menu-trigger]").first().click();
  await page.getByRole("menuitem", { name: "Post a story" }).click();
  const composer = page.getByRole("dialog", { name: "New story" });
  await composer.getByRole("radio", { name: "Text" }).click();
  return composer;
}

async function addText(composer: Locator, text: string) {
  // The first text opens on its own; later ones from the text tool.
  if (!(await composer.locator("[data-story-text]").isVisible())) {
    await composer.locator("[data-story-tool-text]").click();
  }
  await composer.locator("[data-story-text]").fill(text);
  await composer.locator("[data-story-text-done]").click();
  await expect(composer.locator("[data-story-text]")).toHaveCount(0);
}

async function geometry(layer: Locator) {
  return layer.evaluate((element) => {
    const style = (element as HTMLElement).style;
    const match = /rotate\(([-\d.e]+)rad\) scale\(([-\d.e]+)\)/.exec(style.transform);
    return {
      left: parseFloat(style.left),
      top: parseFloat(style.top),
      rotation: match ? Number(match[1]) : 0,
      scale: match ? Number(match[2]) : 1,
    };
  });
}

test("text layers: place, drag, keyboard, pinch, trash, undo", async ({ page }) => {
  const ctx = await setup();
  const composer = await openTextComposer(page, ctx);
  await addText(composer, "primeira");
  await addText(composer, "segunda");

  const layers = composer.locator('[data-layer-type="text"]');
  await expect(layers).toHaveCount(2);
  const first = layers.nth(0);
  const surface = composer.locator("[data-story-surface]");
  const box = (await surface.boundingBox())!;

  // Drag the first one with the mouse: it lands where the pointer let go.
  const before = await geometry(first);
  const at = (await first.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + 40, at.y + at.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  const dragged = await geometry(first);
  expect(dragged.left).toBeGreaterThan(before.left);
  expect(dragged.top).toBeGreaterThan(before.top);

  // Keyboard: a layer is a tab stop; arrows move it, + scales, Delete removes it.
  await first.focus();
  await page.keyboard.press("ArrowRight");
  const nudged = await geometry(first);
  expect(nudged.left).toBeGreaterThan(dragged.left);
  await page.keyboard.press("+");
  expect((await geometry(first)).scale).toBeGreaterThan(1);
  await page.keyboard.press("]");
  expect((await geometry(first)).rotation).toBeGreaterThan(0);

  // Pinch: two fingers, held layer plus a second pointer anywhere. Synthetic
  // pointer events stand in for a touch screen.
  const target = (await layers.nth(1).boundingBox())!;
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const startScale = (await geometry(layers.nth(1))).scale;
  await page.evaluate(
    ({ cx, cy, bx, by }) => {
      const layer = document.querySelectorAll('[data-layer-type="text"]')[1] as HTMLElement;
      const surfaceEl = document.querySelector("[data-story-surface]") as HTMLElement;
      const fire = (el: HTMLElement, type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y }),
        );
      fire(layer, "pointerdown", 1, cx, cy);
      // The second finger lands beside the first and spreads away from it.
      void bx;
      void by;
      fire(surfaceEl, "pointerdown", 2, cx + 30, cy);
      fire(surfaceEl, "pointermove", 2, cx + 150, cy);
      fire(surfaceEl, "pointerup", 2, cx + 150, cy);
      fire(surfaceEl, "pointerup", 1, cx, cy);
    },
    { cx, cy, bx: box.x, by: box.y },
  );
  expect((await geometry(layers.nth(1))).scale).toBeGreaterThan(startScale);

  // Undo takes the pinch back as one step.
  await composer.locator("[data-story-undo]").click();
  expect((await geometry(layers.nth(1))).scale).toBeCloseTo(startScale, 5);

  // Trash: drag a layer to the bottom center and let go.
  const victim = layers.nth(1);
  const v = (await victim.boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - box.width * 0.16, { steps: 8 });
  await expect(composer.locator("[data-story-trash]")).toHaveAttribute("data-hot", "true");
  await page.mouse.up();
  await expect(layers).toHaveCount(1);
  await composer.locator("[data-story-undo]").click();
  await expect(layers).toHaveCount(2);

  // Delete from the keyboard.
  await layers.nth(0).focus();
  await page.keyboard.press("Delete");
  await expect(layers).toHaveCount(1);
});

test("posts a text card with layers and a mention; the server keeps them", async ({ page }) => {
  const ctx = await setup();
  const composer = await openTextComposer(page, ctx);
  await addText(composer, "bora?");

  await composer.locator("[data-story-tool-stickers]").click();
  await composer.locator("[data-story-sticker=mention]").click();
  await composer.locator("[data-story-person]").first().click();
  await expect(composer.locator('[data-layer-type="mention"]')).toHaveCount(1);

  // The draw tool: one stroke becomes a drawing layer. A drawing goes up as a picture, so
  // where there is no object storage (a suite without S3_*) the tool is simply not offered.
  const canDraw = (await composer.locator("[data-story-tool-draw]").count()) > 0;
  if (canDraw) {
    await composer.locator("[data-story-tool-draw]").click();
    const surface = composer.locator("[data-story-draw-surface]");
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 140, { steps: 6 });
    await page.mouse.up();
    await composer.locator("[data-story-draw-done]").click();
  }

  await composer.locator("[data-story-post]").click();
  await expect(composer).toBeHidden();
  await expect(page.getByRole("button", { name: "Your story, view" })).toBeVisible({ timeout: 30_000 });

  const strip = (await (
    await fetch(`${API}/api/servers/${ctx.serverId}/stories`, { headers: headersFor(ctx.owner) })
  ).json()) as { own: { storyIds: string[] } };
  const read = (await (
    await fetch(`${API}/api/stories?ids=${strip.own.storyIds[0]}`, { headers: headersFor(ctx.owner) })
  ).json()) as { stories: { kind: string; altText: string | null; layers: { type: string }[] }[] };
  const story = read.stories[0]!;
  expect(story.kind).toBe("text");
  expect(story.layers.map((layer) => layer.type).sort()).toEqual(canDraw ? ["drawing", "mention", "text"] : ["mention", "text"]);
  expect(story.altText).toContain("bora?");
  expect(story.altText).toContain("Bia Guest");
});
