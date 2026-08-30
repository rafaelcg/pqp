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
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({ timeout: 20_000 });
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

/* -------------------------------------------------------------------------
 * The same question in a private call.
 *
 * Reported verbatim, 23 Aug 2026: "nem consigo ampliar os compartilhamentos de
 * tela de outros usuarios". A DM call used to put the only fullscreen control
 * in the call's control bar, which fades to `opacity-0` after three seconds of
 * the pointer resting, and answered no gesture on the share itself. The stage
 * button worked, so a spec that pressed it was green while the thing a person
 * actually reaches for did nothing at all.
 *
 * So this asserts the two affordances that live ON the share, both of which
 * the channel stage has always had: a double click on the video, and a button
 * over the picture naming whose screen it is.
 * ---------------------------------------------------------------------- */

function dmHeaders(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/** Age gate + onboarding for one dev-bypass account. */
async function materialiseAccount(suffix: string) {
  const accountHeaders = dmHeaders(suffix);
  const me = await fetch(`${API}/api/me`, { headers: accountHeaders });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers: accountHeaders,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: accountHeaders,
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return body;
}

async function seedConversation(callerSuffix: string, calleeSuffix: string) {
  const caller = await materialiseAccount(callerSuffix);
  const callee = await materialiseAccount(calleeSuffix);
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: dmHeaders(calleeSuffix),
    body: JSON.stringify({ dmPrivacy: "everyone" }),
  });
  const opened = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: dmHeaders(callerSuffix),
    body: JSON.stringify({ userIds: [callee.id] }),
  });
  const { conversation } = (await opened.json()) as {
    conversation: { channelId: string };
  };
  return {
    conversationId: conversation.channelId,
    callerSuffix,
    calleeSuffix,
    callerName: caller.displayName,
  };
}

async function openConversation(
  target: Page,
  conversationId: string,
  suffix: string,
): Promise<void> {
  await target.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await target.goto(`/app/dm/${conversationId}?lang=en`);
  await expect(target.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(target.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

/** The share on a call stage, and whether it fills the viewport. */
function measureCallStage(target: Page) {
  return target.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[data-testid="call-stage"] video.object-contain',
    );
    const rect = video?.getBoundingClientRect();
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      fullscreen: !!document.fullscreenElement,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

test("a viewer can enlarge a screen share in a private call", async ({
  page,
  browser,
}) => {
  // Two app boots plus a media handshake.
  test.setTimeout(120_000);

  const pair = await seedConversation("fsdm-a", "fsdm-b");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone", "camera"]);

  try {
    const viewer = await context.newPage();
    await openConversation(viewer, pair.conversationId, pair.calleeSuffix);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openConversation(page, pair.conversationId, pair.callerSuffix);

    await page
      .getByRole("button", { name: "Start voice call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await viewer
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(
      viewer.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 30_000 });

    const share = viewer
      .locator('[data-testid="call-stage"] video.object-contain')
      .first();
    await expect(share).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        () => share.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
        { timeout: 30_000 },
      )
      .toBe(true);

    const before = await measureCallStage(viewer);
    expect(before.fullscreen).toBe(false);

    // 1. The gesture. Double clicking somebody's share enlarges it, exactly as
    //    it does on a channel stage.
    await share.dblclick({ position: { x: 40, y: 40 } });
    await expect
      .poll(async () => (await measureCallStage(viewer)).fullscreen, {
        timeout: 10_000,
      })
      .toBe(true);

    const enlarged = await measureCallStage(viewer);
    // Not merely "something is fullscreen": the picture has to have grown.
    expect(enlarged.width).toBe(enlarged.viewport.width);
    expect(enlarged.height).toBeGreaterThan(before.height);
    expect(enlarged.height).toBeGreaterThan(enlarged.viewport.height * 0.9);

    // 2. The visible control, on the share rather than in the fading bar, and
    //    saying whose screen it is.
    const shareControl = viewer.getByTestId("share-fullscreen");
    await expect(shareControl).toHaveAttribute("aria-label", "Exit fullscreen");
    await shareControl.click();
    await expect
      .poll(async () => (await measureCallStage(viewer)).fullscreen, {
        timeout: 10_000,
      })
      .toBe(false);

    await expect(shareControl).toHaveAttribute(
      "aria-label",
      `View ${pair.callerName}'s screen fullscreen`,
    );
    await shareControl.click();
    await expect
      .poll(async () => (await measureCallStage(viewer)).fullscreen, {
        timeout: 10_000,
      })
      .toBe(true);
  } finally {
    await context.close().catch(() => {});
  }
});
