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
  // With no object storage the composer opens straight on the text card, its editor already up (and the
  // tabs out of the way); with storage it opens on the camera and the Text tab is the way in.
  const textTab = composer.getByRole("radio", { name: "Text" });
  await expect(textTab.or(composer.locator("[data-story-text]"))).toBeVisible();
  // (If the editor came up by itself in the meantime the tab is gone and there is nothing to click.)
  await textTab.click({ timeout: 3000 }).catch(() => undefined);
  return composer;
}

async function addText(composer: Locator, text: string) {
  // The first text of an empty text card opens its editor on its own; later ones come from the
  // text tool. (While the editor is open the tools are out of the way, so never reach for one
  // then: the card with no layers is the one that opens by itself, however slowly.)
  const opensItself = (await composer.locator("[data-layer-type]").count()) === 0;
  if (!opensItself) {
    await composer.locator("[data-story-tool-text]").click();
  }
  await composer.locator("[data-story-text]").waitFor({ state: "visible", timeout: 15_000 });
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

  // And the viewer draws them: the text where it was put, the mention as a button, the
  // drawing as a layer, every one inside the 9:16 layer canvas.
  await page.getByRole("button", { name: "Your story, view" }).click();
  const viewer = page.locator("[data-story-viewer]");
  await expect(viewer.locator("[data-story-layer-canvas]")).toBeVisible({ timeout: 15_000 });
  await expect(viewer.locator('[data-layer-type="text"]')).toContainText("bora?");
  await expect(viewer.locator('[data-layer-type="drawing"]')).toHaveCount(canDraw ? 1 : 0);
  const mention = viewer.locator("button[data-story-mention]");
  await expect(mention).toContainText("@Bia Guest");
  // Tapping a mention opens that person's card over the story.
  await mention.click();
  await expect(page.getByText("Bia Guest").first()).toBeVisible();
});

/**
 * The layers of a real story Rafael posted on production (text "LOL", moved, scaled, tilted)
 * must be drawn by the viewer where the editor put them, at every window size: the layer's
 * centre is x .527, y .777 of the 9:16 canvas, whatever the card around the canvas is.
 */
for (const size of [
  { name: "desktop 1440x900", width: 1440, height: 900 },
  { name: "phone 390x844", width: 390, height: 844 },
]) {
  test(`the viewer draws a posted text layer where it was put (${size.name})`, async ({ page }) => {
    const ctx = await setup();
    const created = await fetch(`${API}/api/stories`, {
      method: "POST",
      headers: headersFor(ctx.owner),
      body: JSON.stringify({
        kind: "text",
        background: "grape",
        layers: [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            type: "text",
            text: "LOL",
            font: "classic",
            color: "purple",
            background: "none",
            align: "center",
            size: 2.4,
            x: 0.527,
            y: 0.777,
            scale: 3.42,
            rotation: 0.198,
          },
        ],
        audiences: { serverIds: [ctx.serverId], friends: false },
      }),
    });
    expect(created.status).toBe(201);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.owner);
    await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: size.width, height: size.height });
    // The strip is in the channel list (a drawer on a phone): open the viewer through it.
    await page.locator("[data-story-ring]").first().evaluate((element) => (element as HTMLElement).click());
    const viewer = page.locator("[data-story-viewer]");
    const layer = viewer.locator('[data-layer-type="text"]');
    await expect(layer).toContainText("LOL", { timeout: 15_000 });
    // Measured in one frame, once the viewer has finished opening (it scales in, and a box read
    // halfway through would be read against a canvas read a moment earlier).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const canvas = document.querySelector("[data-story-viewer] [data-story-layer-canvas]")!.getBoundingClientRect();
            const box = document.querySelector('[data-story-viewer] [data-layer-type="text"]')!.getBoundingClientRect();
            return {
              x: Math.round(((box.x + box.width / 2 - canvas.x) / canvas.width) * 1000) / 1000,
              y: Math.round(((box.y + box.height / 2 - canvas.y) / canvas.height) * 1000) / 1000,
            };
          }),
        { timeout: 10_000 },
      )
      .toEqual({ x: 0.527, y: 0.777 });
    // The viewer never crops the author's canvas: it is the whole 9:16, fitted INSIDE the card (a
    // phone is taller than 9:16, so there are bars above and below), never wider or taller than it.
    const fit = await page.evaluate(() => {
      const card = document.querySelector("[data-story-card]")!.getBoundingClientRect();
      const canvas = document.querySelector("[data-story-viewer] [data-story-layer-canvas]")!.getBoundingClientRect();
      return {
        ratio: canvas.width / canvas.height,
        inside:
          canvas.left >= card.left - 1 &&
          canvas.right <= card.right + 1 &&
          canvas.top >= card.top - 1 &&
          canvas.bottom <= card.bottom + 1,
      };
    });
    expect(fit.inside).toBe(true);
    expect(fit.ratio).toBeCloseTo(9 / 16, 2);
    // Its type is the same fraction of the canvas width at any size: 8% x size x scale of the width.
    // (Both in layout pixels: the viewer scales in while it opens, which scales a bounding box.)
    const fraction = await layer.locator(".story-tl").evaluate((element) => {
      const canvas = element.closest("[data-story-layer-canvas]") as HTMLElement;
      return parseFloat(getComputedStyle(element).fontSize) / canvas.offsetWidth;
    });
    expect(fraction).toBeCloseTo(0.08 * 2.4, 2);
  });
}

test("editing a text layer happens in place: it does not move, resize or untilt, and undo is one step", async ({ page }) => {
  const ctx = await setup();
  const composer = await openTextComposer(page, ctx);
  await addText(composer, "no lugar");

  const layer = composer.locator('[data-layer-type="text"]').first();
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

  // Move it with the mouse, scale and turn it from the keyboard (the same transforms a pinch makes).
  const start = await box(layer);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 40, start.y + start.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await layer.focus();
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("+");
  }
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("]");
  }
  const before = await geometry(layer);
  expect(before.scale).toBeGreaterThan(1.4);
  expect(before.rotation).toBeGreaterThan(0.1);
  const placed = await box(layer);

  // Tap to edit: the editor's box sits exactly where the layer was, at its size and tilt.
  await page.mouse.click(placed.x + placed.width / 2, placed.y + placed.height / 2);
  const editor = composer.locator("[data-story-text-box]");
  await expect(editor).toBeVisible();
  const editing = await box(editor);
  expect(Math.abs(centre(editing).x - centre(placed).x)).toBeLessThan(2);
  expect(Math.abs(centre(editing).y - centre(placed).y)).toBeLessThan(2);
  expect(Math.abs(editing.width - placed.width)).toBeLessThan(3);
  expect(Math.abs(editing.height - placed.height)).toBeLessThan(3);
  const tilt = await editor.evaluate((element) => {
    const match = /rotate\(([-\d.e]+)rad\) scale\(([-\d.e]+)\)/.exec((element as HTMLElement).style.transform);
    return { rotation: Number(match![1]), scale: Number(match![2]) };
  });
  expect(tilt.rotation).toBeCloseTo(before.rotation, 5);
  expect(tilt.scale).toBeCloseTo(before.scale, 5);

  // Typing and the live controls keep the centre where it was.
  await composer.locator("[data-story-text]").fill("no lugar, editado");
  await composer.locator("[data-story-color=lime]").click();
  await composer.locator("[data-story-font=classic]").click();
  const live = await box(editor);
  expect(Math.abs(centre(live).x - centre(placed).x)).toBeLessThan(2);
  expect(Math.abs(centre(live).y - centre(placed).y)).toBeLessThan(2);

  // Done ends editing without a jump: the layer is where it was, with its new words and colour.
  await composer.locator("[data-story-text-done]").click();
  await expect(composer.locator("[data-story-text-box]")).toHaveCount(0);
  const after = await geometry(layer);
  expect(after.left).toBeCloseTo(before.left, 5);
  expect(after.top).toBeCloseTo(before.top, 5);
  expect(after.scale).toBeCloseTo(before.scale, 5);
  expect(after.rotation).toBeCloseTo(before.rotation, 5);
  await expect(layer).toContainText("no lugar, editado");
  const settled = await box(layer);
  expect(Math.abs(centre(settled).x - centre(placed).x)).toBeLessThan(2);
  expect(Math.abs(centre(settled).y - centre(placed).y)).toBeLessThan(2);

  // The whole edit is one undo step: back to the words and colour before it, in place.
  await composer.locator("[data-story-undo]").click();
  await expect(layer).toContainText("no lugar");
  await expect(layer).not.toContainText("editado");
  expect((await geometry(layer)).scale).toBeCloseTo(before.scale, 5);
});

test("a layer never scales past the canvas, and the corner handle turns only past its dead zone or with Shift", async ({ page }) => {
  const ctx = await setup();
  const composer = await openTextComposer(page, ctx);
  await addText(composer, "limite");
  const layer = composer.locator('[data-layer-type="text"]').first();
  const surface = (await composer.locator("[data-story-surface]").boundingBox())!;
  const width = async () => (await layer.boundingBox())!.width;

  // The wheel and the keyboard stop where the layer fills the canvas.
  const at = (await layer.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(30);
  }
  await expect.poll(width).toBeLessThanOrEqual(surface.width + 1.5);
  // The wheel commits its scale a moment after the last notch.
  await page.waitForTimeout(450);
  await layer.focus();
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("+");
  }
  expect(await width()).toBeLessThanOrEqual(surface.width + 1.5);
  expect(await width()).toBeGreaterThan(surface.width * 0.9);

  // The handle: a pull with a small wobble is a pure scale; a swing turns it; Shift only turns.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("-");
  }
  const before = await geometry(layer);
  const handle = (await composer.locator("[data-story-handle]").boundingBox())!;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  const box = (await layer.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.hypot(hx - cx, hy - cy);
  const angle = Math.atan2(hy - cy, hx - cx);
  const wobble = (4 * Math.PI) / 180;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(cx + radius * 1.2 * Math.cos(angle + wobble), cy + radius * 1.2 * Math.sin(angle + wobble), { steps: 8 });
  await page.mouse.up();
  const pulled = await geometry(layer);
  expect(pulled.rotation).toBeCloseTo(before.rotation, 6);
  expect(pulled.scale).toBeGreaterThan(before.scale);

  const handle2 = (await composer.locator("[data-story-handle]").boundingBox())!;
  const h2x = handle2.x + handle2.width / 2;
  const h2y = handle2.y + handle2.height / 2;
  const box2 = (await layer.boundingBox())!;
  const c2x = box2.x + box2.width / 2;
  const c2y = box2.y + box2.height / 2;
  const r2 = Math.hypot(h2x - c2x, h2y - c2y);
  const a2 = Math.atan2(h2y - c2y, h2x - c2x);
  await page.keyboard.down("Shift");
  await page.mouse.move(h2x, h2y);
  await page.mouse.down();
  await page.mouse.move(c2x + r2 * 1.5 * Math.cos(a2 + wobble), c2y + r2 * 1.5 * Math.sin(a2 + wobble), { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const shifted = await geometry(layer);
  expect(shifted.scale).toBeCloseTo(pulled.scale, 6);
  expect(Math.abs(shifted.rotation - pulled.rotation)).toBeGreaterThan(0.03);
});

test("layer order is creation order: a drawing is created on top, and drawing again brings it back to the top", async ({ page }) => {
  const ctx = await setup();
  const composer = await openTextComposer(page, ctx);
  await addText(composer, "primeiro");
  const canDraw = (await composer.locator("[data-story-tool-draw]").count()) > 0;
  test.skip(!canDraw, "object storage is off: there is no draw tool");
  const order = () =>
    composer.locator("[data-story-surface] [data-layer-type]").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.layerType));
  const stroke = async () => {
    await composer.locator("[data-story-tool-draw]").click();
    const box = (await composer.locator("[data-story-draw-surface]").boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 150, { steps: 6 });
    await page.mouse.up();
    await composer.locator("[data-story-draw-done]").click();
  };
  await stroke();
  expect(await order()).toEqual(["text", "drawing"]);
  await addText(composer, "segundo");
  expect(await order()).toEqual(["text", "drawing", "text"]);
  await stroke();
  expect(await order()).toEqual(["text", "text", "drawing"]);
  // The stroke and the move are one undo step.
  await composer.locator("[data-story-undo]").click();
  expect(await order()).toEqual(["text", "drawing", "text"]);
});
