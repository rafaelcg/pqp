import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Picture-in-picture of a peer's screen share (PQP-5).
 *
 * Two real clients in a DM call, the caller shares, and on the callee's side:
 *
 *  - the share tile offers a PiP control, and the caller's own tile does not,
 *  - the control bar offers one for the main share, only to the viewer,
 *  - pressing it hands the share's <video> to the browser's PiP window, which
 *    is still rendering frames,
 *  - pressing it again brings it back,
 *  - the presenter stopping closes the window rather than leaving a frozen
 *    last frame floating over the desktop,
 *  - while the share is on the viewer's stage the page hands the browser an
 *    `enterpictureinpicture` media session action, so Chrome can pop it out
 *    by itself when the viewer switches tabs, and takes it back afterwards.
 *    Playwright keeps every page `visible`, so the tab switch itself cannot
 *    be driven from here,
 *  - a viewer on a phone gets neither control nor the automatic window, even
 *    though the browser underneath has the API.
 *
 * The LiveKit half (a share in PiP keeps arriving in a hidden tab) has no SFU
 * here and is pinned in `remote-video-delivery.test.ts`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone", "camera"],
});

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

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

async function seedConversation(callerSuffix: string, calleeSuffix: string) {
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
    callerName: caller.displayName,
  };
}

async function openConversation(
  page: Page,
  conversationId: string,
  suffix: string,
) {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`/app/dm/${conversationId}`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

async function openCallee(
  browser: Browser,
  conversationId: string,
  suffix: string,
  userAgent?: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    ...(userAgent ? { userAgent } : {}),
  });
  await context.grantPermissions(["microphone", "camera"]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const session = navigator.mediaSession;
    const original = session.setActionHandler.bind(session);
    const record: Record<string, boolean> = {};
    (window as unknown as { __pipActions: typeof record }).__pipActions =
      record;
    session.setActionHandler = (action, handler) => {
      original(action, handler);
      record[action] = handler !== null;
    };
  });
  await openConversation(page, conversationId, suffix);
  return { context, page };
}

function autoPipRegistered(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __pipActions?: Record<string, boolean> })
        .__pipActions?.enterpictureinpicture ?? false,
  );
}

function pipVideoIsShare(page: Page) {
  return page.evaluate(() => {
    const el = document.pictureInPictureElement as HTMLVideoElement | null;
    return Boolean(
      el &&
      el.classList.contains("object-contain") &&
      el.closest('[data-testid="call-stage"]') &&
      el.videoWidth > 0,
    );
  });
}

test("a viewer pops a peer's screen share into picture-in-picture and back", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("pip-a", "pip-b");
  const callee = await openCallee(browser, pair.conversationId, "pip-b");

  try {
    await openConversation(page, pair.conversationId, "pip-a");
    await page
      .getByRole("button", { name: "Start video call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(page.getByText("You are presenting")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      callee.page.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 20_000 });

    // The presenter gets no PiP for their own screen.
    await expect(page.getByTestId("share-pip")).toHaveCount(0);

    const share = callee.page.locator(
      '[data-testid="call-stage"] video.object-contain',
    );
    await expect
      .poll(
        () => share.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
        { timeout: 30_000 },
      )
      .toBe(true);

    await expect.poll(() => autoPipRegistered(callee.page)).toBe(true);
    expect(await autoPipRegistered(page)).toBe(false);

    const pip = callee.page.getByTestId("share-pip");
    await share.hover({ force: true });
    await expect(pip).toHaveCount(1);
    await expect(pip).toHaveAttribute("aria-label", "Picture-in-picture");
    await expect(pip).toHaveAttribute("aria-pressed", "false");

    await pip.click();
    await expect.poll(() => pipVideoIsShare(callee.page)).toBe(true);
    await expect(pip).toHaveAttribute("aria-pressed", "true");

    await share.hover({ force: true });
    await pip.click();
    await expect
      .poll(() => callee.page.evaluate(() => document.pictureInPictureElement))
      .toBeNull();
    await expect(pip).toHaveAttribute("aria-pressed", "false");

    // The control bar carries the same switch for the main share, and the
    // two buttons agree about the state.
    const barPip = callee.page.getByTestId("stage-pip");
    await share.hover({ force: true });
    await expect(barPip).toBeVisible();
    await expect(barPip).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("stage-pip")).toHaveCount(0);
    await barPip.click();
    await expect.poll(() => pipVideoIsShare(callee.page)).toBe(true);
    await expect(barPip).toHaveAttribute("aria-pressed", "true");
    await expect(pip).toHaveAttribute("aria-pressed", "true");
    await share.hover({ force: true });
    await barPip.click();
    await expect
      .poll(() => callee.page.evaluate(() => document.pictureInPictureElement))
      .toBeNull();
    await expect(pip).toHaveAttribute("aria-pressed", "false");

    // Back in, then the presenter stops: the window closes with the share.
    await share.hover({ force: true });
    await pip.click();
    await expect.poll(() => pipVideoIsShare(callee.page)).toBe(true);
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click();
    await expect
      .poll(
        () => callee.page.evaluate(() => document.pictureInPictureElement),
        { timeout: 20_000 },
      )
      .toBeNull();
    await expect(callee.page.getByTestId("share-pip")).toHaveCount(0);
    await expect(callee.page.getByTestId("stage-pip")).toHaveCount(0);
    await expect.poll(() => autoPipRegistered(callee.page)).toBe(false);
  } finally {
    await callee.context.close();
  }
});

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";

test("a viewer on a phone gets no picture-in-picture for a share", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("pip-c", "pip-d");
  const callee = await openCallee(
    browser,
    pair.conversationId,
    "pip-d",
    ANDROID_UA,
  );

  try {
    await openConversation(page, pair.conversationId, "pip-c");
    await page
      .getByRole("button", { name: "Start video call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await callee.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();

    const share = callee.page.locator(
      '[data-testid="call-stage"] video.object-contain',
    );
    await expect
      .poll(
        () => share.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(
      await callee.page.evaluate(
        () => "requestPictureInPicture" in HTMLVideoElement.prototype,
      ),
    ).toBe(true);

    await share.hover({ force: true });
    await expect(callee.page.getByTestId("share-pip")).toHaveCount(0);
    await expect(callee.page.getByTestId("stage-pip")).toHaveCount(0);
    expect(await autoPipRegistered(callee.page)).toBe(false);
  } finally {
    await callee.context.close();
  }
});
