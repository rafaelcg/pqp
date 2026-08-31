import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitUntilVoiceConnected } from "./fixtures";

/**
 * The DM call *stage*, measured — not assumed.
 *
 * Two real clients in two browser contexts: both are dev-bypass accounts
 * selected via the `pqp:dev-user-suffix` localStorage hook in
 * `lib/dev-auth.ts` (`dev-local-token:<suffix>` is a distinct account, the
 * same mechanism `dm-call.spec.ts` drives over a raw WebSocket). Both run the
 * actual app, so the WebRTC mesh, the camera tracks and the stage layout are
 * all the real thing; the fake media device makes the video deterministic.
 *
 * Each test gets its own PAIR of accounts on purpose. Reusing one pair across
 * tests made the previous test's teardown (a socket closed mid-call) race the
 * next test's voice join server-side, which surfaced ~30s later as a spurious
 * `peer-left` in the middle of the new call.
 *
 * What is pinned here is the complaint that produced the stage: a video call
 * used to render as ~160px thumbnails above the chat. Now the remote person
 * must occupy at least half of the viewport — at desktop and phone widths —
 * the call must be startable from the always-visible header buttons (no
 * hover, so it works on touch), the stage must collapse to a banner and come
 * back, and hanging up from the stage must end the call.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Real joins need a microphone and (here) a camera; the fake device supplies
// deterministic frames for both.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone", "camera"],
});

// Two full app boots plus a media handshake per test.
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
  // The two accounts share no server, and the default privacy refuses
  // strangers — open the door for this pair.
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

async function measuredArea(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`no box for ${selector}`);
  }
  return box.width * box.height;
}

test("desktop: a 1:1 video call gives the remote person at least half the viewport, collapses, and hangs up", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("stage-a", "stage-b");
  const callee = await openCallee(browser, pair);

  try {
    await openConversation(page, pair.conversationId, pair.callerSuffix);

    // The header affordance needs no hover — this is the tap path.
    const videoButton = page.getByRole("button", {
      name: "Start video call",
      exact: true,
    });
    await expect(videoButton).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start voice call", exact: true }),
    ).toBeVisible();
    await videoButton.click();

    // The ringing state owns the stage, not a thumbnail strip.
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Calling…")).toBeVisible({ timeout: 20_000 });

    // The callee is rung for real and answers from the overlay.
    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    // Caller joined "with video": camera comes on without a second tap, so the
    // callee sees the caller's camera as the full-stage remote tile.
    await expectVideoPlaying(callee.page, pair.callerName);

    // Callee answers with their own camera from the stage controls.
    await callee.page.getByRole("button", { name: "Turn camera on" }).click();
    await expectVideoPlaying(page, pair.calleeName);

    // THE measurement: the remote person occupies at least half the viewport.
    const viewport = page.viewportSize()!;
    const remoteArea = await measuredArea(
      page,
      `[data-call-tile="${pair.calleeName}"]`,
    );
    expect(remoteArea).toBeGreaterThanOrEqual(
      viewport.width * viewport.height * 0.5,
    );

    // Self is a corner preview, not a peer-sized tile.
    const selfArea = await measuredArea(
      page,
      `[data-call-tile="${pair.callerName}"]`,
    );
    expect(selfArea).toBeLessThanOrEqual(remoteArea * 0.15);

    // Collapse → a slim banner, chat back in reach; expand → the stage again,
    // with the remote video still live.
    await page.getByRole("button", { name: "Collapse call" }).click();
    const collapsedBox = await page
      .getByTestId("call-stage-collapsed")
      .boundingBox();
    expect(collapsedBox).not.toBeNull();
    expect(collapsedBox!.height).toBeLessThanOrEqual(80);
    await expect(page.getByTestId("call-stage")).not.toBeVisible();

    await page.getByRole("button", { name: "Expand call" }).click();
    await expect(page.getByTestId("call-stage")).toBeVisible();
    await expectVideoPlaying(page, pair.calleeName);

    // Hang up from the stage.
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByTestId("call-stage")).not.toBeVisible();
    await expect(
      page.locator(`[data-call-tile="${pair.calleeName}"]`),
    ).not.toBeVisible();
  } finally {
    await callee.context.close();
  }
});

test("desktop: a voice-only DM stays a slim bar until a camera turns on", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("stage-e", "stage-f");
  const callee = await openCallee(browser, pair);

  try {
    await openConversation(page, pair.conversationId, pair.callerSuffix);
    await page.getByRole("button", { name: "Start voice call", exact: true }).click();
    // An outgoing ring owns the stage. After pickup, voice-only is the slim bar.
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Calling…")).toBeVisible({ timeout: 20_000 });

    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("call-stage")).toHaveCount(0);

    await waitUntilVoiceConnected(page);
    await page.getByRole("button", { name: "Turn camera on", exact: true }).click();
    await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });
  } finally {
    await callee.context.close();
  }
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("390px: the call is startable without hover and the remote person still gets half the screen", async ({
    page,
    browser,
  }) => {
    const pair = await seedConversation("stage-c", "stage-d");
    const callee = await openCallee(browser, pair);

    try {
      await openConversation(page, pair.conversationId, pair.callerSuffix);

      // Both call buttons visible in the header, inside the 390px viewport,
      // with nothing hovered — touch has no hover.
      const voiceButton = page.getByRole("button", {
        name: "Start voice call",
        exact: true,
      });
      const videoButton = page.getByRole("button", {
        name: "Start video call",
        exact: true,
      });
      await expect(voiceButton).toBeVisible();
      await expect(videoButton).toBeVisible();
      const videoBox = (await videoButton.boundingBox())!;
      expect(videoBox.x).toBeGreaterThanOrEqual(0);
      expect(videoBox.x + videoBox.width).toBeLessThanOrEqual(390);

      await videoButton.click();
      await expect(page.getByTestId("call-stage")).toBeVisible({
        timeout: 20_000,
      });

      await callee.page
        .getByRole("button", { name: "Accept" })
        .click({ timeout: 20_000 });
      // The caller's video arriving proves the callee is connected — the
      // camera toggle is a deliberate no-op while a join is still settling.
      await expectVideoPlaying(callee.page, pair.callerName);
      await callee.page.getByRole("button", { name: "Turn camera on" }).click();
      await expectVideoPlaying(page, pair.calleeName);

      // The stage spans the whole chat pane, flush to the right edge. (The
      // 72px server rail keeps the left edge — the pane is the phone canvas.)
      const stageBox = (await page.getByTestId("call-stage").boundingBox())!;
      expect(stageBox.x + stageBox.width).toBeGreaterThanOrEqual(389);
      expect(stageBox.width).toBeGreaterThanOrEqual(300);

      // …and the remote person occupies at least half the viewport.
      const remoteArea = await measuredArea(
        page,
        `[data-call-tile="${pair.calleeName}"]`,
      );
      expect(remoteArea).toBeGreaterThanOrEqual(390 * 844 * 0.5);

      // Controls dock at the bottom of the stage — thumb territory.
      const leave = page.getByRole("button", { name: "Leave", exact: true });
      const leaveBox = (await leave.boundingBox())!;
      expect(leaveBox.y).toBeGreaterThanOrEqual(
        stageBox.y + stageBox.height * 0.7,
      );

      await leave.click();
      await expect(page.getByTestId("call-stage")).not.toBeVisible();
    } finally {
      await callee.context.close();
    }
  });
});
