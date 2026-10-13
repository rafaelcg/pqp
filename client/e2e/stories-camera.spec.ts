import { expect, test, type Page } from "@playwright/test";

/**
 * The story composer's camera, with Chromium's fake device (a test pattern)
 * standing in for a webcam: open on the camera, tap for a photo, record a clip
 * with the record button, go back to the camera, and post the photo.
 *
 * Needs object storage (`S3_*`) on the suite's server: with it off the
 * composer has no camera tab at all and every test here skips.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(120_000);

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["camera", "microphone"],
});

function headersFor(suffix: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` };
}

async function setup(): Promise<{ suffix: string; serverId: string; channelId: string; serverName: string }> {
  const suffix = `st-cam-${Date.now().toString(36)}`.toLowerCase().slice(0, 32);
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as { ageGate?: string };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  const serverName = `Camera ${Date.now()}`;
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: serverName }),
  });
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
  return {
    suffix,
    serverId: server.id,
    channelId: channels.channels.find((channel) => channel.type === "text")!.id,
    serverName,
  };
}

async function skipWithoutMedia(suffix: string): Promise<void> {
  const config = (await (
    await fetch(`${API}/api/stories/config`, { headers: headersFor(suffix) })
  ).json()) as { mediaEnabled?: boolean };
  test.skip(!config.mediaEnabled, "object storage is off: the composer has no camera tab");
}

async function openComposer(page: Page, ctx: Awaited<ReturnType<typeof setup>>) {
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.suffix);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-server-menu-trigger]").first().click();
  await page.getByRole("menuitem", { name: "Post a story" }).click();
  return page.getByRole("dialog", { name: "New story" });
}

test("opens on the camera, takes a photo, goes back, and posts", async ({ page }) => {
  const ctx = await setup();
  await skipWithoutMedia(ctx.suffix);
  const composer = await openComposer(page, ctx);
  await expect(composer).toBeVisible();

  // The live preview: the fake device starts and the video has a size.
  const video = composer.locator("[data-story-camera]");
  await expect(video).toBeVisible();
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>("[data-story-camera]");
    return Boolean(element && element.videoWidth > 0);
  });
  // The shutter is the only way forward until there is a picture.
  await expect(composer.locator("[data-story-post]")).toHaveCount(0);

  await composer.locator("[data-story-shutter]").click();
  await expect(composer.locator("[data-story-caption]")).toBeVisible();
  // Pre-ticked where the person was.
  await expect(composer.locator("[data-story-audience]")).toContainText(ctx.serverName);

  // Back to the camera: the stream restarts, the picture is gone.
  await composer.locator("[data-story-retake]").click();
  await expect(composer.locator("[data-story-shutter]")).toBeVisible();
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>("[data-story-camera]");
    return Boolean(element && element.videoWidth > 0);
  });

  await composer.locator("[data-story-shutter]").click();
  await composer.locator("[data-story-caption]").fill("fake camera");
  await composer.locator("[data-story-post]").click();
  await expect(composer).toBeHidden();
  await expect(page.getByRole("button", { name: "Your story, view" })).toBeVisible({ timeout: 30_000 });
});

test("records a clip with the record button and previews it", async ({ page }) => {
  const ctx = await setup();
  await skipWithoutMedia(ctx.suffix);
  const composer = await openComposer(page, ctx);
  await expect(composer.locator("[data-story-camera]")).toBeVisible();
  const canRecord = await page.evaluate(
    () => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4"),
  );
  test.skip(!canRecord, "this Chromium cannot record MP4");

  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>("[data-story-camera]");
    return Boolean(element && element.videoWidth > 0);
  });
  await composer.locator("[data-story-record]").click();
  await expect(composer.getByRole("timer")).toBeVisible();
  await page.waitForTimeout(1500);
  await composer.locator("[data-story-record]").click();
  // The recorded clip comes back as a video the person can caption and post.
  await expect(composer.locator("[data-story-caption]")).toBeVisible({ timeout: 15_000 });
  await expect(composer.locator("video").first()).toBeVisible();
});

test("a file dropped on the composer becomes the story", async ({ page }) => {
  const ctx = await setup();
  await skipWithoutMedia(ctx.suffix);
  const composer = await openComposer(page, ctx);
  await expect(composer).toBeVisible();

  // A 2x2 PNG, built in the page and dropped as a real DataTransfer.
  await composer.evaluate(async (root) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const file = new File([blob], "dot.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = root.querySelector(".story-cmp")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  });
  await expect(composer.locator("[data-story-caption]")).toBeVisible({ timeout: 15_000 });
});
