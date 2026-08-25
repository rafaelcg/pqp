import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * A camera and a screen share from the same person, at the same time.
 *
 * Two real clients (dev-bypass accounts, same pattern as
 * `dm-call-video-stage.spec.ts`) in a 1:1 conversation call, doing it in both
 * orders — camera first then share, and share first then camera. What must
 * hold on the other end:
 *
 *  - the stage flips to the "screen" layout (presenter line visible),
 *  - the share renders real frames,
 *  - the camera tiles keep rendering real frames while it does,
 *  - stopping the share leaves the camera running and returns the stage to
 *    the camera spotlight.
 *
 * WHY BOTH ORDERS. Mesh classification files an incoming video stream as
 * "screen" only because its id differs from the roster's announced
 * `cameraStreamId`, and `classifyVideo` is first-wins over insertion order —
 * so which of the two arrives first is a genuinely different code path, not a
 * restatement of the same one.
 *
 * WHY FRAMES AND NOT `videoWidth`. This file used to assert `videoWidth > 0`,
 * which cannot fail here. A `<video>` bound to a dead remote track keeps the
 * dimensions of the last frame it decoded, still reports `readyState: 4`,
 * still has an `srcObject`, is still "visible", and renders a black
 * rectangle — which is exactly what the camera/screen mix-up produces. So
 * every liveness check below measures decoded frames advancing across a
 * window of real time instead. See CONTRIBUTING.md, "On tests".
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

// Two full app boots, a media handshake, and two renegotiations per test, plus
// a frame-sampling window per liveness check, which is wall-clock time these
// tests spend deliberately.
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

/**
 * Frames genuinely decoded into one element, sampled across real time.
 *
 * `getVideoPlaybackQuality().totalVideoFrames` is per-element, so it cannot be
 * satisfied by some other live video elsewhere on the stage — which matters
 * enormously here, where a camera tile and a share are on screen together and
 * the bug shape is one of them being pointed at the other's dead stream. The
 * delta is what carries the assertion: a count that is merely non-zero is a
 * count that stopped moving some time ago.
 */
async function expectDecodingFrames(video: Locator, what: string) {
  await expect(video).toBeVisible({ timeout: 30_000 });
  const frames = () =>
    video.evaluate((el) => {
      const media = el as HTMLVideoElement;
      return media.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    });
  await expect
    .poll(frames, { timeout: 30_000, message: `${what}: no frame ever decoded` })
    .toBeGreaterThan(0);
  const before = await frames();
  // Long enough that even a badly throttled encoder clears one frame, short
  // enough that four of these do not dominate the test's runtime.
  await video.page().waitForTimeout(1_500);
  expect(await frames(), `${what}: decoding stalled`).toBeGreaterThan(before);
}

/** The same, for the camera tile belonging to one named participant. */
async function expectTileDecodingFrames(page: Page, tileName: string) {
  await expectDecodingFrames(
    page.locator(`[data-call-tile="${tileName}"] video`).first(),
    `${tileName}'s camera`,
  );
}

/**
 * The screen-layout stage video: the only `object-contain` video on the stage
 * (camera tiles render `object-cover`).
 */
function screenVideo(page: Page) {
  return page.locator('[data-testid="call-stage"] video.object-contain');
}

/**
 * Nudge the pointer so the call controls are awake before clicking one.
 *
 * The control bar fades to `opacity-0 pointer-events-none` three seconds after
 * the last pointer movement over the stage (`callControlsMayIdle`), which is
 * right for somebody watching a film and fatal for a test that just spent a
 * sampling window holding perfectly still: `click()` then waits forever for a
 * button that can no longer receive the event, and Playwright's default action
 * timeout is *no* timeout. A person moves the mouse to reach the button, so
 * this does too.
 */
async function wakeCallControls(page: Page) {
  const box = await page.getByTestId("call-stage").boundingBox();
  if (!box) {
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 8);
}

/** Every control-bar click, with a timeout, so a dead one fails instead of hanging. */
const CLICK = { timeout: 20_000 } as const;

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
    await expectTileDecodingFrames(callee.page, pair.callerName);
    await wakeCallControls(callee.page);
    await callee.page
      .getByRole("button", { name: "Turn camera on" })
      .click(CLICK);
    await expectTileDecodingFrames(page, pair.calleeName);

    // Mid-call, the caller starts sharing.
    await wakeCallControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click(CLICK);
    await expect(page.getByText("You are presenting")).toBeVisible({
      timeout: 20_000,
    });

    // The callee's stage must flip to the screen layout…
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 20_000 });

    // …and actually render the shared frames, not a black placeholder.
    const share = screenVideo(callee.page);
    await expectDecodingFrames(share, "the share");

    // Camera tiles survive as thumbnails on the rail — the share must not have
    // eaten the caller's camera tile (screen vs camera confusion).
    await expectTileDecodingFrames(callee.page, pair.callerName);

    // Stop the share: the callee's stage returns to the camera spotlight and
    // the caller's camera keeps playing.
    await wakeCallControls(page);
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click(CLICK);
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).not.toBeVisible({ timeout: 20_000 });
    await expect(share).not.toBeVisible({ timeout: 20_000 });
    // The assertion the whole file exists for: the camera outlives the share.
    // Nothing weaker than a frame delta can make this one fail, because the
    // element is still bound to a stream that decoded frames a moment ago.
    await expectTileDecodingFrames(callee.page, pair.callerName);
  } finally {
    await callee.context.close();
  }
});

test("a camera turned on during a share joins it instead of replacing it", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("share-c", "share-d");
  const callee = await openCallee(browser, pair);

  try {
    await openConversation(page, pair.conversationId, pair.callerSuffix);

    // A voice call, so no camera exists yet anywhere: this is the order the
    // other test cannot reach, where the share is the first video the callee
    // ever sees from the caller and the camera arrives on top of it.
    await page
      .getByRole("button", { name: "Start voice call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    await wakeCallControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click(CLICK);
    await expect(page.getByText("You are presenting")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 20_000 });
    const share = screenVideo(callee.page);
    await expectDecodingFrames(share, "the share");

    // Now the camera, with the share already up. On the mesh this is a second
    // video track on a connection that already carries one, and the callee
    // tells them apart by the `cameraStreamId` the roster announces.
    await wakeCallControls(page);
    await page.getByRole("button", { name: "Turn camera on" }).click(CLICK);

    // Both, together: the camera arrives as its own tile and the share is
    // still the share. Either one pointing at the other's stream is the bug.
    await expectTileDecodingFrames(callee.page, pair.callerName);
    await expectDecodingFrames(share, "the share, with a camera alongside it");
  } finally {
    await callee.context.close();
  }
});
