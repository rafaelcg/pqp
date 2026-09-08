import { expect, test, type Page } from "@playwright/test";
import {
  ensureServer,
  leaveVoiceIfConnected,
  openApp,
  waitUntilVoiceConnected,
} from "./fixtures";

/**
 * Who gets the window while a call is on: the picture, or the room talking
 * about it.
 *
 * Reported from a 510-member community on 6 Sep 2026 — with a camera or a
 * screen on, the stage took `68svh` and the transcript underneath was four or
 * five lines. The stage's height stopped being ours and became a divider, the
 * two panes gained a side-by-side arrangement for a wide window, and the
 * channel list gained an icons-only strip.
 *
 * THE THING THAT MUST NOT BREAK, and the reason half of this file exists:
 * `lib/remote-video-delivery.ts` pauses an SFU publication a second after the
 * last `<video>` bound to it goes away. A layout change that remounted the
 * stage would therefore turn the picture black on the other end a second
 * later, in a layout that looks perfectly correct on this one. So the spec
 * marks the real `<video>` node before every layout change and checks the SAME
 * NODE is still there afterwards, still bound, still decoding frames. Asserting
 * "a video is visible" would pass through a remount and prove nothing.
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
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
    ],
  },
  permissions: ["microphone", "camera"],
});

test.setTimeout(90_000);

async function ensureVoiceChannel(): Promise<void> {
  await ensureServer();
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  if (!channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "lobby", type: "voice" }),
    });
  }
  if (!channels.some((c) => c.type === "text" && c.name === "geral")) {
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "geral", type: "text" }),
    });
  }
}

async function joinLobbyWithCamera(page: Page): Promise<void> {
  await page.getByRole("button", { name: /lobby/ }).first().dblclick();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(page);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });
}

/** Mark the live `<video>` so a remount can be told from a re-render. */
async function markStageVideo(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[aria-label="Your camera"]',
    );
    if (!video) {
      throw new Error("no stage video to mark");
    }
    video.dataset.e2eKept = "yes";
  });
}

/**
 * Whether the marked node survived, and whether it is still a live picture.
 * `videoWidth > 0` is frames actually decoded; `srcObject` is the binding
 * `remote-video-delivery` counts.
 */
function stageVideoState(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[aria-label="Your camera"]',
    );
    return {
      present: !!video,
      sameNode: video?.dataset.e2eKept === "yes",
      bound: !!video?.srcObject,
      width: video?.videoWidth ?? 0,
      paused: video?.paused ?? true,
    };
  });
}

function paneGeometry(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>("[data-call-split]")!;
    const stagePane = document.querySelector<HTMLElement>(
      "[data-call-split-stage]",
    )!;
    const paneBox = pane.getBoundingClientRect();
    const stageBox = stagePane.getBoundingClientRect();
    return {
      orientation: pane.dataset.callSplit,
      paneWidth: paneBox.width,
      paneHeight: paneBox.height,
      paneTop: paneBox.top,
      paneLeft: paneBox.left,
      stageWidth: stageBox.width,
      stageHeight: stageBox.height,
      stageLeft: stageBox.left,
      stageTop: stageBox.top,
    };
  });
}

function storedSplit(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("pqp:call-split");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  });
}

test("the divider resizes the call, remembers it, and never starves a pane", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await joinLobbyWithCamera(page);

  const divider = page.getByTestId("call-split-divider");
  await expect(divider).toBeVisible();
  // It says what it is to a screen reader as well as to a pointer.
  await expect(divider).toHaveAttribute("role", "separator");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");

  const before = await paneGeometry(page);
  expect(before.orientation).toBe("stacked");
  // Nobody has moved it yet, so nothing about the layout has changed: the
  // stage is still `68svh` of the window, exactly as it was before there was
  // a divider at all. The minimums bound a drag; they do not re-decide a
  // default nobody chose.
  await expect(page.locator("[data-call-split-sized]")).toHaveCount(0);
  expect(before.stageHeight).toBeCloseTo(
    page.viewportSize()!.height * 0.68,
    -1,
  );

  // --- drag it up, giving the transcript the room -------------------------
  await markStageVideo(page);
  const grip = (await divider.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 200, { steps: 10 });
  await page.mouse.up();

  const dragged = await paneGeometry(page);
  expect(dragged.stageHeight).toBeLessThan(before.stageHeight - 150);
  // The picture is the same element, still bound, still decoding.
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
    paused: false,
  });
  expect((await stageVideoState(page)).width).toBeGreaterThan(0);

  // --- and it was written down --------------------------------------------
  const stored = await storedSplit(page);
  expect(stored).not.toBeNull();
  expect(stored!.orientation).toBe("stacked");
  expect(stored!.stacked as number).toBeCloseTo(
    dragged.stageHeight / (dragged.paneHeight - 8),
    1,
  );

  // --- the ends hold ------------------------------------------------------
  // Yank it to the floor of the window. The transcript keeps its minimum and
  // the composer stays on screen, which is the whole point of a minimum.
  const gripNow = (await divider.boundingBox())!;
  await page.mouse.move(
    gripNow.x + gripNow.width / 2,
    gripNow.y + gripNow.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(gripNow.x + gripNow.width / 2, 5000, { steps: 10 });
  await page.mouse.up();

  const bottomed = await paneGeometry(page);
  expect(bottomed.paneHeight - bottomed.stageHeight).toBeGreaterThanOrEqual(
    220,
  );
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible();

  // And the other end: the stage keeps a picture rather than a sliver.
  const gripLow = (await divider.boundingBox())!;
  await page.mouse.move(
    gripLow.x + gripLow.width / 2,
    gripLow.y + gripLow.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(gripLow.x + gripLow.width / 2, -5000, { steps: 10 });
  await page.mouse.up();
  expect((await paneGeometry(page)).stageHeight).toBeGreaterThanOrEqual(160);

  // --- the keyboard drives the same divider -------------------------------
  const keyedFrom = (await paneGeometry(page)).stageHeight;
  await divider.focus();
  await divider.press("ArrowDown");
  await divider.press("ArrowDown");
  const keyedTo = (await paneGeometry(page)).stageHeight;
  expect(keyedTo).toBeGreaterThan(keyedFrom);
  await divider.press("ArrowUp");
  expect((await paneGeometry(page)).stageHeight).toBeLessThan(keyedTo);

  await leaveVoiceIfConnected(page);
});

/**
 * Asked for in the QG on 8 Sep 2026: "tem como fechar o chat quando ta com a
 * call aberta?". The drag stops at the minimums by design, so putting a pane
 * away entirely is a separate, named act with its own way back.
 *
 * The invariant at the top of this file applies here more than anywhere: the
 * collapsed pane is HIDDEN, never unmounted, so the marked `<video>` has to
 * survive both directions.
 */
test("putting a pane away hides it, keeps the picture, and gives it back", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await joinLobbyWithCamera(page);
  await markStageVideo(page);

  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible();
  const divider = page.getByTestId("call-split-divider");

  // The two ends of the drag are buttons on the divider, quiet until the
  // pointer is near the boundary.
  const hover = async () => {
    const grip = (await divider.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  };

  // --- the chat away, which is what was actually asked for -----------------
  await hover();
  await page.getByTestId("call-split-collapse-chat").click();
  await expect(composer).toBeHidden();
  // The call took the pane, bar the strip that brings the chat back.
  const filled = await paneGeometry(page);
  expect(filled.paneHeight - filled.stageHeight).toBeLessThanOrEqual(24);
  // Same node, still bound, still decoding: the SFU never stopped sending it.
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
    paused: false,
  });
  expect((await storedSplit(page))!.collapsed).toBe("chat");

  // --- and back, from the strip where the pane used to be ------------------
  await page.getByTestId("call-split-restore").click();
  await expect(composer).toBeVisible();
  await expect(divider).toBeVisible();
  expect((await storedSplit(page))!.collapsed).toBe("none");
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
  });

  // --- the other end of the same divider -----------------------------------
  await hover();
  await page.getByTestId("call-split-collapse-stage").click();
  await expect(page.getByTestId("call-stage")).toBeHidden();
  await expect(composer).toBeVisible();
  // Off screen, not gone. Coming back costs no renegotiation.
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
  });
  expect((await storedSplit(page))!.collapsed).toBe("stage");

  await page.getByTestId("call-split-restore").click();
  await expect(page.getByTestId("call-stage")).toBeVisible();
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
  });

  await leaveVoiceIfConnected(page);
});

test("a stored split is what the next call opens with", async ({ page }) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "pqp:call-split",
      JSON.stringify({ orientation: "stacked", stacked: 0.3, side: 0.62 }),
    ),
  );
  await page.reload();
  await joinLobbyWithCamera(page);

  const geometry = await paneGeometry(page);
  // 30% of the pane, not the 68% the stage used to take on its own.
  expect(geometry.stageHeight / (geometry.paneHeight - 8)).toBeCloseTo(0.3, 1);
  await leaveVoiceIfConnected(page);
});

test("side by side puts the chat beside the call without remounting it", async ({
  page,
}) => {
  await ensureVoiceChannel();
  // Wide enough for a picture AND a real transcript: the rail, the channel
  // list and the roster are 568px of chrome before the pane starts.
  await page.setViewportSize({ width: 1800, height: 900 });
  await openApp(page);
  await joinLobbyWithCamera(page);

  const toggle = page.locator("[data-call-split-toggle]");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await markStageVideo(page);
  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const side = await paneGeometry(page);
  expect(side.orientation).toBe("side-by-side");
  // The stage is a column on the left, full height, and the transcript has the
  // rest of the width.
  expect(side.stageHeight).toBeCloseTo(side.paneHeight, 0);
  expect(side.stageWidth).toBeLessThan(side.paneWidth - 300);
  expect(side.stageLeft).toBeCloseTo(side.paneLeft, 0);

  // The divider turned with it.
  await expect(page.getByTestId("call-split-divider")).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );

  // The same `<video>` element came through the rearrangement.
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
    paused: false,
  });
  expect((await stageVideoState(page)).width).toBeGreaterThan(0);

  // Dragging works on the other axis too. Leftwards, because a 1440 window
  // with the roster open leaves the stage a hair off its ceiling already:
  // the transcript's 320px minimum is what is on the other side of it.
  const grip = (await page.getByTestId("call-split-divider").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y + grip.height / 2, { steps: 10 });
  await page.mouse.up();
  expect((await paneGeometry(page)).stageWidth).toBeLessThan(
    side.stageWidth - 120,
  );

  // Back to stacked, still the same element.
  await markStageVideo(page);
  await toggle.click();
  expect((await paneGeometry(page)).orientation).toBe("stacked");
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
  });

  await leaveVoiceIfConnected(page);
});

test("a window too narrow for two columns is not offered them", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);
  await joinLobbyWithCamera(page);

  // 900px, minus the 72px rail and the 256px channel list, leaves 572 for the
  // pane. Two columns need 888 (a 320 picture, a 560 transcript, the divider).
  // The divider is still there; the toggle is not, because it would have
  // nothing to do.
  await expect(page.getByTestId("call-split-divider")).toBeVisible();
  await expect(page.locator("[data-call-split-toggle]")).toHaveCount(0);
  expect((await paneGeometry(page)).orientation).toBe("stacked");

  // Widen the window and the offer comes back, with no reload.
  await page.setViewportSize({ width: 1800, height: 800 });
  await expect(page.locator("[data-call-split-toggle]")).toBeVisible();

  await leaveVoiceIfConnected(page);
});

test("the channel list collapses to icons while somebody else presents, and comes back", async ({
  page,
  browser,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.getByRole("button", { name: /lobby/ }).first().dblclick();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(page);

  // Wide list first: names, not glyphs.
  await expect(page.locator("[data-channel-rail]")).toHaveCount(0);
  const listWide = (await page
    .locator("aside", { has: page.getByText("geral") })
    .first()
    .boundingBox())!;

  // A second client presents. Deliberately not this one: the automation is
  // for the person WATCHING, and a presenter keeps the list because the
  // voice seats in it are how a room gets moderated.
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1280, height: 800 },
  });
  const presenter = await context.newPage();
  try {
    await presenter.goto("/app");
    await presenter.getByRole("button", { name: /lobby/ }).first().dblclick();
    await waitUntilVoiceConnected(presenter);
    await presenter.getByRole("button", { name: "Share your screen" }).click();
    await expect(page.getByText(/is presenting/)).toBeVisible({
      timeout: 30_000,
    });

    // Nobody chose anything, so the share decides: the list is a strip.
    const rail = page.locator("[data-channel-rail]");
    await expect(rail).toBeVisible({ timeout: 10_000 });
    const railBox = (await rail.boundingBox())!;
    expect(railBox.width).toBeLessThan(listWide.width - 100);

    // The presenter's own list is untouched, which is the whole distinction.
    await expect(presenter.locator("[data-channel-rail]")).toHaveCount(0);

    // Navigation still works from it, by name, and the way back is on screen.
    await expect(rail.locator("[data-channel-id]").first()).toBeVisible();
    await expect(rail.getByLabel("geral")).toBeVisible();
    await expect(rail.locator("[data-channel-rail-expand]")).toBeVisible();

    // Hanging up is one click away from the strip, and the strip still says
    // the state in words even with no room to print them: the 72px column
    // drops the sentence to screen-reader text rather than dropping it. Half
    // the voice suite reads that string to know a call is up.
    await expect(
      page.locator("[data-voice-bar-compact]").getByRole("button", {
        name: "Disconnect from voice",
      }),
    ).toBeVisible();
    await expect(page.getByText("Voice connected")).toBeVisible();

    // And the call really did get the width it cost — enough of it, on this
    // 1440 window, that the two panes now fit side by side, which they did
    // not while the channel list was 16rem wide.
    const withRail = await paneGeometry(page);
    await expect(page.locator("[data-call-split-toggle]")).toBeVisible();

    // One click puts the names back, and it stays back: the choice outranks
    // the share from here on, which is what stops the layout moving on its
    // own.
    await rail.locator("[data-channel-rail-expand]").click();
    await expect(page.locator("[data-channel-rail]")).toHaveCount(0);
    await expect(page.getByText(/is presenting/)).toBeVisible();
    const withList = await paneGeometry(page);
    expect(withList.paneWidth).toBeLessThan(withRail.paneWidth - 100);
    expect(
      await page.evaluate(() => localStorage.getItem("pqp:channel-sidebar")),
    ).toBe("open");

    // The header carries the same toggle, so it can be collapsed on purpose.
    const headerToggle = page.locator("[data-channel-sidebar-toggle]");
    await expect(headerToggle).toBeVisible();
    await headerToggle.click();
    await expect(page.locator("[data-channel-rail]")).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("pqp:channel-sidebar")),
    ).toBe("icons");
    await headerToggle.click();
  } finally {
    await leaveVoiceIfConnected(presenter).catch(() => {});
    await context.close().catch(() => {});
    await leaveVoiceIfConnected(page).catch(() => {});
  }
});

/**
 * The toggle used to be offered only while a stage was up, which meant the
 * only route to a narrower channel list in a plain text channel was to wait
 * for somebody to start sharing and let the automation do it. It is window
 * furniture now, and it lives at the left of the channel header, next to the
 * column it controls.
 */
test("the channel list collapses with no call anywhere in sight", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);

  // Nothing is connected and nobody is presenting: no stage of any kind.
  await expect(page.getByTestId("call-stage")).toHaveCount(0);
  await expect(page.getByTestId("call-stage-collapsed")).toHaveCount(0);

  const toggle = page.locator("[data-channel-sidebar-toggle]");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-channel-rail]")).toHaveCount(0);

  await toggle.click();
  const rail = page.locator("[data-channel-rail]");
  await expect(rail).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => localStorage.getItem("pqp:channel-sidebar")),
  ).toBe("icons");

  // The strip still carries its own way back, so the header button is never
  // the only exit.
  await expect(rail.locator("[data-channel-rail-expand]")).toBeVisible();
  await rail.locator("[data-channel-rail-expand]").click();
  await expect(page.locator("[data-channel-rail]")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("pqp:channel-sidebar")),
  ).toBe("open");

  // And the choice is remembered, with no call ever having happened.
  await toggle.click();
  await page.reload();
  await expect(page.locator("[data-channel-rail]")).toBeVisible({
    timeout: 20_000,
  });
});

/** What `object-fit` the browser actually resolved on the live picture. */
function stageVideoFit(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[aria-label="Your camera"]',
    );
    return video ? getComputedStyle(video).objectFit : null;
  });
}

/**
 * Fill or fit, and the two things that must not go wrong with it: the picture
 * must not be remounted by the switch (`lib/remote-video-delivery.ts` would
 * pause the publication a second later and the far end would go black), and
 * the choice must outlive both a reload and a rearrangement of the panes.
 */
test("the whole-picture toggle sticks, and never remounts the picture", async ({
  page,
}) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1800, height: 900 });
  await openApp(page);
  await joinLobbyWithCamera(page);

  const fit = page.getByTestId("tile-fit").first();
  // A face is cropped out of the box; that is the default this keeps.
  await expect(fit).toHaveAttribute("data-tile-fit", "cover");
  await expect.poll(() => stageVideoFit(page)).toBe("cover");

  await markStageVideo(page);
  await fit.click();

  await expect(page.getByTestId("tile-fit").first()).toHaveAttribute(
    "data-tile-fit",
    "contain",
  );
  await expect.poll(() => stageVideoFit(page)).toBe("contain");
  // The same element, still bound, still decoding frames.
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
    paused: false,
  });
  expect((await stageVideoState(page)).width).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => localStorage.getItem("pqp:video-fit")),
  ).toContain('"camera":"contain"');

  // --- a layout switch keeps it, and keeps the element ---------------------
  await markStageVideo(page);
  await page.locator("[data-call-split-toggle]").click();
  expect((await paneGeometry(page)).orientation).toBe("side-by-side");
  await expect(page.getByTestId("tile-fit").first()).toHaveAttribute(
    "data-tile-fit",
    "contain",
  );
  await expect.poll(() => stageVideoFit(page)).toBe("contain");
  expect(await stageVideoState(page)).toMatchObject({
    sameNode: true,
    bound: true,
    paused: false,
  });

  // --- and a reload ---------------------------------------------------------
  await leaveVoiceIfConnected(page);
  await page.reload();
  await joinLobbyWithCamera(page);
  await expect(page.getByTestId("tile-fit").first()).toHaveAttribute(
    "data-tile-fit",
    "contain",
  );
  await expect.poll(() => stageVideoFit(page)).toBe("contain");

  await leaveVoiceIfConnected(page);
});

/**
 * THE EMPTY COLUMN. Reported from live use on 7 Sep 2026: side by side was
 * chosen during a share, the share ended, and the left column stayed. It was
 * then a quarter of the window holding the call's control strip and nothing
 * else, with the chat squeezed into the rest. The stored choice is kept; it
 * is not drawn until there is a picture to draw beside the chat, which is the
 * same treatment a window too narrow for two columns already gets.
 */
test("an empty stage is never given a column of its own", async ({ page }) => {
  await ensureVoiceChannel();
  await page.setViewportSize({ width: 1800, height: 900 });
  await openApp(page);
  await joinLobbyWithCamera(page);

  await page.locator("[data-call-split-toggle]").click();
  const side = await paneGeometry(page);
  expect(side.orientation).toBe("side-by-side");

  // The camera goes off, so nobody is publishing anything.
  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera off", exact: true })
    .click();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });

  const empty = await paneGeometry(page);
  // The slim bar is a full-width row above the transcript, not a column: it
  // spans the pane and takes a bar's worth of height rather than a quarter of
  // the window's width.
  expect(empty.stageWidth).toBeCloseTo(empty.paneWidth, 0);
  expect(empty.stageHeight).toBeLessThan(empty.paneHeight / 2);
  // And the arrangement toggle goes with it: there is nothing to arrange.
  await expect(page.locator("[data-call-split-toggle]")).toHaveCount(0);

  // Nothing was forgotten. The camera comes back and so does the column.
  await page
    .getByRole("main")
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await expect(page.getByTestId("call-stage")).toBeVisible({ timeout: 20_000 });
  const back = await paneGeometry(page);
  expect(back.orientation).toBe("side-by-side");
  expect(back.stageWidth).toBeCloseTo(side.stageWidth, 0);
  expect(
    await page.evaluate(() => {
      const raw = localStorage.getItem("pqp:call-split");
      return raw
        ? (JSON.parse(raw) as { orientation: string }).orientation
        : null;
    }),
  ).toBe("side-by-side");

  await leaveVoiceIfConnected(page);
});
