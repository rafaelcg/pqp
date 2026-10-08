import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  ensureServer,
  leaveVoiceIfConnected,
  openApp,
  waitUntilVoiceConnected,
} from "./fixtures";

/**
 * The call controls leave a stream that fills the stage, and only then.
 *
 * Reported (Rafael, a brother sharing a game in the Lobby, one stream focused
 * on the stage): the pill across the bottom of the picture never went away.
 * The idle chrome from #239 existed, but the bar held itself open for plain
 * focus, and a mouse click on any of its buttons (mute, the quality menu)
 * leaves that button focused, so one press of anything pinned the bar for the
 * rest of the stream. Only KEYBOARD focus holds it now (`isKeyboardFocus`).
 *
 * The rules are unit-tested in `components/voice/stage-chrome.test.ts` and
 * `hooks/use-idle-chrome.test.ts`; this pins that the real stage wires them to
 * real pointer, focus and keyboard events, in a real server voice channel with
 * a real second participant sharing a screen.
 *
 * Two pictures from one real peer (a camera and a screen share) make a grid
 * without a third live participant, the same trick as
 * `voice-call-stage-back-to-streams.spec.ts`; focusing one is the state in the
 * report. The Fullscreen API is deleted before boot so the stage takes the
 * in-page `expand` path deterministically.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const SUFFIXES = ["autohide2", "autohide3"] as const;
const SHOTS = process.env.AUTOHIDE_SHOTS ?? "";

function headersFor(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${suffix ? `${DEV_TOKEN}:${suffix}` : DEV_TOKEN}`,
  };
}

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
  viewport: { width: 1440, height: 900 },
});

test.setTimeout(120_000);

/** Age gate, onboarding and server membership for the second participant. */
async function materialiseMember(
  suffix: string,
  inviteCode: string,
): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
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
  await fetch(`${API}/api/invites/${inviteCode}/join`, {
    method: "POST",
    headers,
  });
}

/** The lobby voice channel, and an invite the second participant can redeem. */
async function seedRoom(): Promise<{ inviteCode: string }> {
  await ensureServer();
  const headers = headersFor();
  const list = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await list.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const channelsRes = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { name: string; type: string }[];
  };
  if (
    !channels.some((c) => c.type === "voice" && c.name.toLowerCase() === "lobby")
  ) {
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "lobby", type: "voice" }),
    });
  }
  const invite = await fetch(`${API}/api/servers/${serverId}/invites`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const { invite: created } = (await invite.json()) as {
    invite: { code: string };
  };
  return { inviteCode: created.code };
}

async function openWithSuffix(target: Page, suffix: string): Promise<void> {
  await target.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await target.goto("/app?lang=en");
  await expect(target.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(target.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

async function joinLobby(target: Page): Promise<void> {
  await target.getByRole("button", { name: /lobby/i }).first().dblclick();
  await expect(target.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(target);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
}

const HIDE_WITHIN = { timeout: 6_000 };

interface Room {
  /** The watching account: nothing published, so its stage is all others. */
  page: Page;
  others: Page[];
  close: () => Promise<void>;
}

/**
 * The watcher joins the Lobby, then `count` real second and third accounts
 * join it too. The Fullscreen API is deleted on the watcher before boot so the
 * stage takes the in-page `expand` path deterministically.
 */
async function joinRoom(
  page: Page,
  browser: Browser,
  count: number,
  watcherInit?: () => void,
): Promise<Room> {
  const { inviteCode } = await seedRoom();
  const suffixes = SUFFIXES.slice(0, count);
  for (const suffix of suffixes) {
    await materialiseMember(suffix, inviteCode);
  }
  // One context per account: the dev-user suffix lives in localStorage, which
  // pages of one context share.
  const contexts: BrowserContext[] = [];
  const others: Page[] = [];
  const close = async () => {
    await leaveVoiceIfConnected(page).catch(() => {});
    for (const other of others) {
      await leaveVoiceIfConnected(other).catch(() => {});
    }
    for (const context of contexts) {
      await context.close().catch(() => {});
    }
  };
  // A setup that fails half way must not strand the contexts it already made
  // or the seats it already took: the caller never gets a Room to close.
  try {
    await page.addInitScript(() => {
      // @ts-expect-error deleting a platform API is the point
      delete Element.prototype.requestFullscreen;
      // @ts-expect-error the prefixed spelling too
      delete Element.prototype.webkitRequestFullscreen;
    });
    if (watcherInit) {
      await page.addInitScript(watcherInit);
    }
    await openApp(page);
    for (const suffix of suffixes) {
      const context = await browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 1440, height: 900 },
      });
      contexts.push(context);
      const other = await context.newPage();
      await openWithSuffix(other, suffix);
      others.push(other);
    }
    await joinLobby(page);
    for (const other of others) {
      await joinLobby(other);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { page, others, close };
}

async function turnCameraOn(other: Page): Promise<void> {
  await other
    .getByRole("main")
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
}

test("one focused stream hides its controls when idle, and only then", async ({
  page,
  browser,
}) => {
  const room = await joinRoom(page, browser, 1);
  const [second] = room.others as [Page];
  try {
    await turnCameraOn(second);
    await second.getByRole("button", { name: "Share your screen" }).click();
    await expect(page.getByText(/is presenting/)).toBeVisible({
      timeout: 30_000,
    });

    const stage = page.getByTestId("call-stage");
    const bar = page.getByTestId("call-controls-bar");
    const overlay = page.locator('[data-call-chrome="overlay"]');
    const stageGrid = page.getByTestId("stage-grid");
    await expect(stageGrid.locator("video")).toHaveCount(2, {
      timeout: 20_000,
    });

    // --- focus one stream: the report ---------------------------------------
    await stageGrid.getByTestId("tile-click-target").first().click();
    await expect(stageGrid).toHaveCount(0);
    const back = page.getByTestId("stage-show-all-streams");
    await expect(back).toBeVisible();
    await page.mouse.move(720, 320);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await shot(page, "1-controls-visible");

    // Everything in the overlay group goes together, and the pointer with it.
    await expect(bar).toHaveAttribute("data-chrome-hidden", "true", HIDE_WITHIN);
    await expect(overlay).toHaveAttribute("data-chrome-hidden", "true");
    await expect(back).toHaveAttribute("data-chrome-hidden", "true");
    await expect(bar).toHaveCSS("opacity", "0");
    await expect(overlay).toHaveCSS("opacity", "0");
    await expect(back).toHaveCSS("opacity", "0");
    // The focused tile's own corner controls (fit, volume, back to the grid)
    // are part of the same group, even with the pointer parked on the picture.
    const tileControls = page.locator('[data-call-chrome="tile"]');
    await expect(tileControls).toHaveCount(1);
    await expect(tileControls).toHaveCSS("opacity", "0");
    await expect(stage).toHaveCSS("cursor", "none");
    // The picture is untouched: still one live video, still playing.
    await expect(page.locator("video")).toHaveCount(1);
    await shot(page, "2-controls-hidden");

    // --- any pointer move brings it all back --------------------------------
    await page.mouse.move(760, 340);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await expect(overlay).toHaveCSS("opacity", "1");
    await expect(back).toHaveCSS("opacity", "1");
    await expect(tileControls).toHaveCSS("opacity", "1");
    await expect(stage).not.toHaveCSS("cursor", "none");
    await shot(page, "3-revealed-on-move");

    // --- a mouse press on a control does NOT pin the bar (the bug) ----------
    await page
      .getByRole("button", { name: /^(Mute|Unmute)/ })
      .first()
      .click();
    await page.mouse.move(700, 300);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "true", HIDE_WITHIN);

    // --- resting the pointer on the bar holds it ----------------------------
    await page.mouse.move(720, 310);
    const barBox = (await bar.boundingBox())!;
    await page.mouse.move(
      barBox.x + barBox.width / 2,
      barBox.y + barBox.height - 12,
    );
    await page.waitForTimeout(4_500);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");

    // --- an open menu holds it ----------------------------------------------
    await page
      .getByRole("button", { name: /Video you are receiving/ })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
    // Park the pointer on the picture: only the open menu can hold the bar.
    await page.mouse.move(700, 300);
    await page.waitForTimeout(4_500);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await expect(page.getByRole("menu")).toBeVisible();
    await shot(page, "4-menu-open-stays-visible");
    // Closed with the mouse, so the button keeps mouse focus, which must not
    // hold the bar (Escape would hand a keyboard user focus back, which should).
    await page
      .getByRole("button", { name: /Video you are receiving/ })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.mouse.move(720, 300);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "true", HIDE_WITHIN);

    // --- keyboard: a Tab reveals and keeps the controls ---------------------
    await page.keyboard.press("Tab");
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await page.waitForTimeout(4_500);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");

    // --- keyboard focus on a tile's own control holds the bar too -----------
    let inTile = false;
    for (let i = 0; i < 25 && !inTile; i += 1) {
      await page.keyboard.press("Shift+Tab");
      inTile = await page.evaluate(
        () =>
          document.activeElement?.closest('[data-call-chrome="tile"]') !== null,
      );
    }
    expect(inTile).toBe(true);
    await page.mouse.move(700, 300);
    await page.waitForTimeout(4_500);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(bar).toHaveAttribute("data-chrome-hidden", "true", HIDE_WITHIN);

    // --- a tile's own open menu ("⋯") holds the bar --------------------------
    await page.mouse.move(720, 300);
    const tilePanelButton = tileControls.locator('button[aria-haspopup="menu"]');
    await expect(tilePanelButton).toHaveCount(1);
    await tilePanelButton.click();
    await expect(tilePanelButton).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(700, 300);
    await page.waitForTimeout(4_500);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "false");
    await expect(tilePanelButton).toHaveAttribute("aria-expanded", "true");
    // Closed with a press on its button, not Escape: Escape would also leave
    // the real fullscreen this focused stream is in.
    const panelBox = (await tilePanelButton.boundingBox())!;
    await page.mouse.click(
      panelBox.x + panelBox.width / 2,
      panelBox.y + panelBox.height / 2,
    );
    await expect(tilePanelButton).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.mouse.move(720, 300);
    await expect(bar).toHaveAttribute("data-chrome-hidden", "true", HIDE_WITHIN);

    // --- the way back is still one press, hidden or not ---------------------
    await back.click();
    await expect(page.getByTestId("stage-grid")).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await room.close();
  }
});

test("a call with no stream on the stage keeps its controls", async ({
  page,
  browser,
}) => {
  // The people-only state: nothing is published, the stage is collapsed into
  // the composer's bar, and no idle period may take hang-up away. A grid of
  // cameras follows the same rule (`stage-chrome.test.ts`); it is not driven
  // here because three mesh participants with two cameras trip the room's
  // camera cap on a rig with no SFU ("No room for more cameras").
  const room = await joinRoom(page, browser, 1);
  try {
    await expect(page.getByTestId("call-stage-collapsed")).toBeVisible();
    await page.mouse.move(700, 300);
    await page.waitForTimeout(4_500);
    await expect(
      page.getByRole("button", { name: "Leave", exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-chrome-hidden="true"]')).toHaveCount(0);
    await shot(page, "5-people-only-never-hides");
  } finally {
    await room.close();
  }
});

test("with Hide controls automatically off, a focused stream keeps them", async ({
  page,
  browser,
}) => {
  const room = await joinRoom(page, browser, 1, () => {
    localStorage.setItem("pqp:auto-hide-stage-controls", "0");
  });
  const [second] = room.others as [Page];
  try {
    await turnCameraOn(second);
    await second.getByRole("button", { name: "Share your screen" }).click();
    await expect(page.getByText(/is presenting/)).toBeVisible({
      timeout: 30_000,
    });
    const stageGrid = page.getByTestId("stage-grid");
    await expect(stageGrid.locator("video")).toHaveCount(2, {
      timeout: 20_000,
    });
    await stageGrid.getByTestId("tile-click-target").first().click();
    await expect(page.getByTestId("stage-show-all-streams")).toBeVisible();
    await page.mouse.move(720, 320);
    await page.waitForTimeout(4_500);
    await expect(page.getByTestId("call-controls-bar")).toHaveAttribute(
      "data-chrome-hidden",
      "false",
    );
  } finally {
    await room.close();
  }
});
