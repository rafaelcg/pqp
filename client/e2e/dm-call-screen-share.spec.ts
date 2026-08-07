import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Screen share inside a DM *video* call — the reported regression shape.
 *
 * Two real clients (dev-bypass accounts, same pattern as
 * `dm-call-video-stage.spec.ts`): a 1:1 conversation call with BOTH cameras
 * on, then the caller starts a screen share mid-call. What must hold on the
 * other end:
 *
 *  - the stage flips to the "screen" layout (presenter line visible),
 *  - the share is bound to a <video> that actually renders frames
 *    (videoWidth > 0 — a black box with the right class is the bug),
 *  - the camera tiles survive as thumbnails (camera vs screen tracks must not
 *    be confused while both are live),
 *  - stopping the share returns the stage to the camera spotlight.
 *
 * The camera-and-share-together case matters: mesh classification files an
 * incoming video stream as "screen" only because its id differs from the
 * roster's announced `cameraStreamId`, and this is the scenario where both
 * kinds are on the wire at once.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

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
  permissions: ["microphone", "camera"],
});

// Two full app boots, a media handshake, and two renegotiations per test.
test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/** Age-gate + onboarding for one dev-bypass account. */
async function materialiseAccount(suffix: string) {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return body;
}

interface CallPair {
  conversationId: string;
  callerSuffix: string;
  calleeSuffix: string;
  callerName: string;
  calleeName: string;
}

async function seedConversation(
  callerSuffix: string,
  calleeSuffix: string,
): Promise<CallPair> {
  const caller = await materialiseAccount(callerSuffix);
  const callee = await materialiseAccount(calleeSuffix);
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headersFor(calleeSuffix),
    body: JSON.stringify({ dmPrivacy: "everyone" }),
  });
  const opened = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor(callerSuffix),
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
    calleeName: callee.displayName,
  };
}

/** Boot the app straight into the conversation as one of the pair. */
async function openConversation(
  page: Page,
  conversationId: string,
  suffix: string,
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`/app/dm/${conversationId}`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

/** A second, fully real client for the callee. Caller closes it. */
async function openCallee(browser: Browser, pair: CallPair) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone", "camera"]);
  const page = await context.newPage();
  await openConversation(page, pair.conversationId, pair.calleeSuffix);
  return { context, page };
}

/** Wait until a tile's <video> is actually rendering frames. */
async function expectVideoPlaying(page: Page, tileName: string) {
  const video = page.locator(`[data-call-tile="${tileName}"] video`).first();
  await expect(video).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * The screen-layout stage video: the only `object-contain` video on the stage
 * (camera tiles render `object-cover`).
 */
function screenVideo(page: Page) {
  return page.locator('[data-testid="call-stage"] video.object-contain');
}

test("a screen share started mid-video-call reaches the other side's stage", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("share-a", "share-b");
  const callee = await openCallee(browser, pair);

  try {
    await openConversation(page, pair.conversationId, pair.callerSuffix);

    // Caller starts the call with video; callee answers from the overlay.
    await page
      .getByRole("button", { name: "Start video call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    // Both cameras live before the share starts — the classification-under-
    // load scenario. The caller's camera came on with the video call; the
    // callee turns theirs on from the stage.
    await expectVideoPlaying(callee.page, pair.callerName);
    await callee.page.getByRole("button", { name: "Turn camera on" }).click();
    await expectVideoPlaying(page, pair.calleeName);

    // Mid-call, the caller starts sharing.
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(page.getByText("You are presenting")).toBeVisible({
      timeout: 20_000,
    });

    // The callee's stage must flip to the screen layout…
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 20_000 });

    // …and actually render the shared frames, not a black placeholder.
    const share = screenVideo(callee.page);
    await expect(share).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        () => share.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Camera tiles survive as thumbnails on the rail — the share must not have
    // eaten the caller's camera tile (screen vs camera confusion).
    await expectVideoPlaying(callee.page, pair.callerName);

    // Stop the share: the callee's stage returns to the camera spotlight and
    // the caller's camera keeps playing.
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click();
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).not.toBeVisible({ timeout: 20_000 });
    await expect(share).not.toBeVisible({ timeout: 20_000 });
    await expectVideoPlaying(callee.page, pair.callerName);
  } finally {
    await callee.context.close();
  }
});
