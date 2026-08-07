import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Fullscreen on a shared screen, for the presenter and for whoever is watching.
 *
 * The reported failure was "I clicked fullscreen on my laptop and nothing
 * happened" while watching somebody else's share. Two things had to be checked
 * to tell the two candidate causes apart, and both are asserted below:
 *
 *  1. `document.fullscreenElement` — did the request go through at all.
 *  2. The **video's rendered size** — a container that goes fullscreen while
 *     the video inside it stays boxed by `max-h-*` looks exactly like nothing
 *     happening, and checking only (1) would let that through.
 *
 * Chromium takes the standard path, so what this pins is that the standard path
 * keeps working; the prefixed Safari path it fell through to is covered by
 * `components/voice/capabilities.test.ts`, which can reproduce a Safari 16.3
 * shape that no browser here can.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // getDisplayMedia otherwise blocks on a picker no headless run can answer.
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone"],
  trace: "off",
});

async function ensureVoiceChannel(): Promise<void> {
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  if (channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

async function joinLobby(page: Page): Promise<void> {
  await page.getByRole("button", { name: /lobby/ }).first().click();
  await page.getByRole("button", { name: "Join Voice" }).click();
  await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });
}

/** Rendered geometry of the share, plus whether anything is fullscreen. */
function measure(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector("video")!;
    const rect = video.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      fullscreen: !!document.fullscreenElement,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

test("the presenter can put their own share fullscreen", async ({ page }) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await joinLobby(page);

  await page.getByRole("button", { name: "Share your screen" }).click();
  await expect(page.getByText("You are presenting")).toBeVisible({
    timeout: 20_000,
  });

  const before = await measure(page);
  expect(before.fullscreen).toBe(false);

  await page.getByRole("button", { name: "View fullscreen" }).click();
  await expect
    .poll(async () => (await measure(page)).fullscreen, { timeout: 10_000 })
    .toBe(true);

  const after = await measure(page);
  // Not just "an element is fullscreen": the video has to have grown into it.
  expect(after.width).toBe(after.viewport.width);
  expect(after.height).toBeGreaterThan(before.height * 2);
  expect(after.height).toBeGreaterThan(after.viewport.height * 0.9);

  // And back out, which is the second half of the same button.
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect
    .poll(async () => (await measure(page)).fullscreen, { timeout: 10_000 })
    .toBe(false);
});

test("a viewer can put someone else's share fullscreen", async ({
  page,
  browser,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await joinLobby(page);

  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1440, height: 900 },
  });
  try {
    const viewer = await context.newPage();
    await viewer.goto("/app");
    await joinLobby(viewer);

    await page.getByRole("button", { name: "Share your screen" }).click();
    await expect(viewer.getByText(/is presenting/)).toBeVisible({
      timeout: 30_000,
    });

    const before = await measure(viewer);
    expect(before.fullscreen).toBe(false);

    await viewer.getByRole("button", { name: "View fullscreen" }).click();
    await expect
      .poll(async () => (await measure(viewer)).fullscreen, { timeout: 10_000 })
      .toBe(true);

    const after = await measure(viewer);
    expect(after.width).toBe(after.viewport.width);
    expect(after.height).toBeGreaterThan(after.viewport.height * 0.9);
  } finally {
    await context.close().catch(() => {});
  }
});
