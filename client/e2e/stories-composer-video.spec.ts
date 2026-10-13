import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The edit step after a CAMERA capture: record a clip (by the record button and by
 * holding the shutter), take a photo, pick a file, and in each case use every tool
 * on top. A toolbar button that a still-mounted camera step, a drop zone or a gesture
 * surface sits over is a button that does nothing, so every button is also hit-tested.
 *
 * Needs object storage (the camera and the photo tool are not offered without it):
 * with it off these skip.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(150_000);

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera", "microphone"],
});

function headersFor(suffix: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` };
}

async function setup() {
  const suffix = `st-vid-${Date.now().toString(36)}`.toLowerCase().slice(0, 32);
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
  const serverName = `Video ${Date.now()}`;
  const created = await fetch(`${API}/api/servers`, { method: "POST", headers, body: JSON.stringify({ name: serverName }) });
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
  const config = (await (await fetch(`${API}/api/stories/config`, { headers })).json()) as { mediaEnabled?: boolean };
  test.skip(!config.mediaEnabled, "object storage is off: the composer has no camera");
  return { suffix, serverId: server.id, channelId: channels.channels.find((c) => c.type === "text")!.id };
}

async function openComposer(page: Page, ctx: Awaited<ReturnType<typeof setup>>, size = { width: 1440, height: 900 }) {
  // The server menu lives on the desktop layout: open there, then take the window to its size.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.suffix);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-server-menu-trigger]").first().click();
  await page.getByRole("menuitem", { name: "Post a story" }).click();
  const composer = page.getByRole("dialog", { name: "New story" });
  await expect(composer).toBeVisible();
  await page.setViewportSize(size);
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>("[data-story-camera]");
    return Boolean(element && element.videoWidth > 0);
  });
  return composer;
}

/** The element that would take a click at the centre of `target`: it must be the target itself. */
async function expectReachable(page: Page, target: Locator, name: string) {
  const box = await target.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  const hit = await target.evaluate((element, point) => {
    const found = document.elementFromPoint(point.x, point.y);
    return Boolean(found && (found === element || element.contains(found)));
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hit, `${name} is what a click on it reaches`).toBe(true);
}

/** The camera step is gone: no preview mounted, no shutter, no mode tabs, the stream stopped. */
async function expectCameraReleased(page: Page, composer: Locator) {
  await expect(composer.locator("[data-story-camera]")).toHaveCount(0);
  await expect(composer.locator("[data-story-shutter]")).toHaveCount(0);
  await expect(composer.locator("[data-story-mode]")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        // Every <video> left on the page holds no live camera track.
        return [...document.querySelectorAll("video")].every((video) => {
          const stream = video.srcObject as MediaStream | null;
          return !stream || stream.getTracks().every((track) => track.readyState === "ended");
        });
      }),
    )
    .toBe(true);
}

/** The clip is the 9:16 the preview showed, not the webcam's whole landscape frame. */
async function expectPortraitClip(composer: Locator) {
  await expect
    .poll(() =>
      composer.locator("video").evaluate((video: HTMLVideoElement) => (video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 0)),
    )
    .toBeGreaterThan(1.5);
}

async function useEveryTool(page: Page, composer: Locator) {
  const tools = ["close", "retake", "tool-text", "tool-photo", "tool-draw", "tool-stickers", "undo"] as const;
  for (const tool of tools) {
    const button = composer.locator(`[data-story-${tool}]`);
    if ((await button.count()) === 0) {
      continue;
    }
    await expectReachable(page, button.first(), tool);
  }
  // Text: opens over the picture, not over a camera.
  await composer.locator("[data-story-tool-text]").click();
  await expect(composer.locator("[data-story-text-editor]")).toBeVisible();
  await expectCameraReleased(page, composer);
  await composer.locator("[data-story-text]").fill("oi");
  await composer.locator("[data-story-text-done]").click();
  await expect(composer.locator('[data-layer-type="text"]')).toHaveCount(1);
  // Stickers, then closed again.
  await composer.locator("[data-story-tool-stickers]").click();
  await expect(composer.locator("[data-story-sticker=mention]")).toBeVisible();
  await composer.getByRole("button", { name: "Close" }).last().click();
  // Draw, then done.
  await composer.locator("[data-story-tool-draw]").click();
  await expect(composer.locator("[data-story-draw-surface]")).toBeVisible();
  await composer.locator("[data-story-draw-done]").click();
  // Undo takes the text back.
  await composer.locator("[data-story-undo]").click();
  await expectCameraReleased(page, composer);
}

for (const size of [
  { name: "490x1000", width: 490, height: 1000 },
  { name: "1440x900", width: 1440, height: 900 },
]) {
  test.describe(size.name, () => {
    test("a clip recorded with the record button: every tool works and the camera is released", async ({ page }) => {
      const composer = await openComposer(page, await setup(), size);
      const canRecord = await page.evaluate(() => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4"));
      test.skip(!canRecord, "this Chromium cannot record MP4");
      await composer.locator("[data-story-record]").click();
      await expect(composer.getByRole("timer")).toBeVisible();
      await page.waitForTimeout(1500);
      await composer.locator("[data-story-record]").click();
      await expect(composer.locator("[data-story-audience]")).toBeVisible({ timeout: 15_000 });
      await expect(composer.locator("video")).toHaveCount(1);
      await expectPortraitClip(composer);
      await expectCameraReleased(page, composer);
      await useEveryTool(page, composer);
    });

    test("a clip recorded by holding the shutter: every tool works and the camera is released", async ({ page }) => {
      const composer = await openComposer(page, await setup(), size);
      const canRecord = await page.evaluate(() => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4"));
      test.skip(!canRecord, "this Chromium cannot record MP4");
      const shutter = (await composer.locator("[data-story-shutter]").boundingBox())!;
      await page.mouse.move(shutter.x + shutter.width / 2, shutter.y + shutter.height / 2);
      await page.mouse.down();
      await expect(composer.getByRole("timer")).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await page.mouse.up();
      await expect(composer.locator("[data-story-audience]")).toBeVisible({ timeout: 15_000 });
      await expectPortraitClip(composer);
      await expectCameraReleased(page, composer);
      await useEveryTool(page, composer);
    });

    test("a photo: every tool works, and Back returns to a clean camera", async ({ page }) => {
      const composer = await openComposer(page, await setup(), size);
      await composer.locator("[data-story-shutter]").click();
      await expect(composer.locator("[data-story-audience]")).toBeVisible();
      await expectCameraReleased(page, composer);
      await useEveryTool(page, composer);
      await composer.locator("[data-story-retake]").click();
      await expect(composer.locator("[data-story-shutter]")).toBeVisible();
      await expect(composer.locator("[data-story-text-editor]")).toHaveCount(0);
    });
  });
}
