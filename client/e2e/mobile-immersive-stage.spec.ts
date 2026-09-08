import { expect, test, type Page } from "@playwright/test";
import {
  ensureServer,
  leaveVoiceIfConnected,
  openApp,
  waitUntilVoiceConnected,
} from "./fixtures";

/**
 * Watching a share on a phone.
 *
 * Runs under the two phone projects only (`mobile-iphone`, WebKit with
 * Safari's iOS user agent; `mobile-pixel`, Chromium with a touch screen), see
 * `playwright.config.ts`. Each starts in portrait and is rotated here with
 * `setViewportSize`, which is what flips `(orientation: landscape)`.
 *
 * What is proved, per device and per orientation:
 *  - sideways with a share focused, the stage is the full viewport width and
 *    the rail, channel list and roster are gone, with a button that brings
 *    them back and one that hides them again;
 *  - upright, nothing is hidden and the stage is still edge to edge;
 *  - the controls bar pads its bottom with `env(safe-area-inset-bottom)`;
 *  - the control-bar fullscreen button asks the platform: `requestFullscreen`
 *    on the stage where element fullscreen exists (Pixel), and the focused
 *    video's `webkitEnterFullscreen()` on an iPhone, whose button state
 *    follows `webkitbeginfullscreen` / `webkitendfullscreen`;
 *  - the "add to home screen" hint shows once on an iPhone in a tab and never
 *    again after dismiss, and never on Android;
 *  - the page never scrolls sideways.
 *
 * No headless engine can capture a screen or open a microphone here, so both
 * are stubbed at init: the share is a canvas stream, the mic an AudioContext
 * destination. Fullscreen is stubbed on the prototypes and the calls
 * recorded, because the assertion is "the platform was asked", which is the
 * part a real device would take from there. The iPhone stub also removes the
 * element API that desktop WebKit has and a real iPhone does not.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

const LANDSCAPE = {
  "mobile-iphone": { width: 750, height: 340 },
  "mobile-pixel": { width: 863, height: 360 },
} as const;

type MobileProject = keyof typeof LANDSCAPE;

declare global {
  interface Window {
    __fsCalls: string[];
  }
}

test.use({ trace: "off" });

// A test that fails mid-call would otherwise leave a 90s voice orphan behind
// that disables Share for the next one.
test.afterEach(async ({ page }) => {
  await leaveVoiceIfConnected(page).catch(() => {});
});

test.beforeEach(async ({ page }, testInfo) => {
  const iphone = testInfo.project.name === "mobile-iphone";
  await page.addInitScript(
    ({ iphone }) => {
      window.__fsCalls = [];
      try {
        // The hint store never persists on localhost; this spec needs it to.
        localStorage.setItem("pqp:hints-persist", "1");
        // The native player path on an iPhone is opt-in (see lib/fullscreen.ts).
        localStorage.setItem("pqp:native-video-fullscreen", "1");
      } catch {
        // Storage refused: the hint assertions below will say so.
      }

      // --- media -----------------------------------------------------------
      const fakeVideoStream = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          ctx.fillStyle = `hsl(${(frame * 3) % 360} 60% 40%)`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#fff";
          ctx.font = "bold 96px sans-serif";
          ctx.fillText("shared screen", 200, 400);
          frame += 1;
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(15);
      };
      const fakeAudioStream = () => {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        osc.connect(dest);
        osc.start();
        return dest.stream;
      };
      const md = navigator.mediaDevices;
      Object.defineProperty(md, "getDisplayMedia", {
        configurable: true,
        value: async () => fakeVideoStream(),
      });
      Object.defineProperty(md, "getUserMedia", {
        configurable: true,
        value: async (constraints?: MediaStreamConstraints) =>
          constraints?.video ? fakeVideoStream() : fakeAudioStream(),
      });

      // --- fullscreen ------------------------------------------------------
      if (iphone) {
        // A real iPhone has neither of these.
        delete (Element.prototype as { requestFullscreen?: unknown })
          .requestFullscreen;
        delete (Element.prototype as { webkitRequestFullscreen?: unknown })
          .webkitRequestFullscreen;
        Object.defineProperty(document, "fullscreenEnabled", {
          configurable: true,
          get: () => false,
        });
        Object.defineProperty(document, "webkitFullscreenEnabled", {
          configurable: true,
          get: () => false,
        });
        const proto = HTMLVideoElement.prototype as unknown as Record<
          string,
          unknown
        >;
        Object.defineProperty(proto, "webkitSupportsFullscreen", {
          configurable: true,
          get: () => true,
        });
        proto.webkitEnterFullscreen = function (this: HTMLVideoElement) {
          window.__fsCalls.push("webkitEnterFullscreen");
          this.dispatchEvent(new Event("webkitbeginfullscreen"));
        };
        proto.webkitExitFullscreen = function (this: HTMLVideoElement) {
          window.__fsCalls.push("webkitExitFullscreen");
          this.dispatchEvent(new Event("webkitendfullscreen"));
        };
      } else {
        const original = Element.prototype.requestFullscreen;
        Element.prototype.requestFullscreen = function (
          this: Element,
          options?: FullscreenOptions,
        ) {
          window.__fsCalls.push("requestFullscreen");
          return original.call(this, options);
        };
      }
    },
    { iphone },
  );
});

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
  if (channels.some((c) => c.type === "voice" && c.name.toLowerCase() === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

/** Portrait phone: the channel list is a drawer behind the menu button. */
async function joinLobbyFromPhone(page: Page): Promise<void> {
  // The drawer is translated off screen, which WebKit still reports as
  // visible; the menu button is the honest signal that it is closed.
  const openNav = page.getByRole("button", { name: "Open navigation" });
  if (await openNav.isVisible().catch(() => false)) {
    await openNav.click();
  }
  await page.getByRole("button", { name: /lobby/i }).first().dblclick();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({
    timeout: 20_000,
  });
  await waitUntilVoiceConnected(page);
}

async function startShare(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Share your screen" }).click();
  await expect(page.getByText("You are presenting").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("call-stage")).toBeVisible();
}

function geometry(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="call-stage"]')!;
    const rect = stage.getBoundingClientRect();
    const hidden = Array.from(
      document.querySelectorAll("[data-immersive-hide]"),
    ).map((el) => getComputedStyle(el).display === "none");
    const controls = document.querySelector(
      '[data-testid="call-controls-bar"]',
    ) as HTMLElement;
    return {
      stageLeft: rect.left,
      stageWidth: rect.width,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      immersive: document.documentElement.hasAttribute("data-immersive-stage"),
      hiddenColumns: hidden,
      controlsClass: controls.className,
      controlsPaddingBottom: parseFloat(getComputedStyle(controls).paddingBottom),
      scrollWidth: document.scrollingElement!.scrollWidth,
      fullscreenElement: document.fullscreenElement?.getAttribute("data-testid") ?? null,
    };
  });
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const g = await geometry(page);
  expect(g.scrollWidth).toBeLessThanOrEqual(g.innerWidth);
}

test("sideways with a share: the stage owns the width, upright: nothing is hidden", async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name as MobileProject;
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobbyFromPhone(page);
  await startShare(page);

  // Portrait first: no takeover, no sideways scroll. The 72px server rail
  // stays (it always does upright); the stage owns everything right of it.
  const portrait = await geometry(page);
  expect(portrait.immersive).toBe(false);
  expect(portrait.stageLeft + portrait.stageWidth).toBe(portrait.innerWidth);
  expect(portrait.stageWidth).toBeGreaterThan(portrait.innerWidth * 0.75);
  expect(portrait.scrollWidth).toBeLessThanOrEqual(portrait.innerWidth);
  await page.screenshot({
    path: testInfo.outputPath(`${project}-portrait-share.png`),
  });

  // Rotate.
  await page.setViewportSize(LANDSCAPE[project]);
  await expect
    .poll(async () => (await geometry(page)).immersive, { timeout: 10_000 })
    .toBe(true);
  const landscape = await geometry(page);
  expect(landscape.stageLeft).toBe(0);
  expect(landscape.stageWidth).toBe(landscape.innerWidth);
  expect(landscape.hiddenColumns.length).toBeGreaterThan(0);
  expect(landscape.hiddenColumns.every(Boolean)).toBe(true);
  expect(landscape.scrollWidth).toBeLessThanOrEqual(landscape.innerWidth);
  await page.screenshot({
    path: testInfo.outputPath(`${project}-landscape-share.png`),
  });

  // The way back, and the way in again.
  const toggle = page.getByTestId("stage-immersive-toggle");
  await expect(toggle).toHaveAccessibleName("Show chat");
  await toggle.click();
  await expect
    .poll(async () => (await geometry(page)).immersive)
    .toBe(false);
  const restored = await geometry(page);
  expect(restored.hiddenColumns.some((h) => !h)).toBe(true);
  expect(restored.stageWidth).toBeLessThan(restored.innerWidth);
  await expect(toggle).toHaveAccessibleName("Hide chat");
  await toggle.click();
  await expect.poll(async () => (await geometry(page)).immersive).toBe(true);

  // Back upright: the columns return on their own.
  await page.setViewportSize(
    project === "mobile-iphone"
      ? { width: 390, height: 664 }
      : { width: 412, height: 839 },
  );
  await expect.poll(async () => (await geometry(page)).immersive).toBe(false);
  await expect(toggle).toBeHidden();
  await expectNoSidewaysScroll(page);

  await leaveVoiceIfConnected(page);
});

test("the controls bar keeps clear of the home indicator", async ({ page }, testInfo) => {
  const project = testInfo.project.name as MobileProject;
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobbyFromPhone(page);
  await startShare(page);
  await page.setViewportSize(LANDSCAPE[project]);

  const g = await geometry(page);
  expect(g.controlsClass).toContain("env(safe-area-inset-bottom)");
  expect(g.controlsClass).toContain("env(safe-area-inset-left)");
  expect(g.controlsClass).toContain("env(safe-area-inset-right)");
  // Headless has no inset, so `max(0.75rem, env(...))` resolves to the floor.
  expect(g.controlsPaddingBottom).toBeGreaterThanOrEqual(12);
  await expectNoSidewaysScroll(page);
  await leaveVoiceIfConnected(page);
});

test("the fullscreen button asks the platform, and its state follows the platform", async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name as MobileProject;
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobbyFromPhone(page);
  await startShare(page);
  await page.setViewportSize(LANDSCAPE[project]);

  const button = page.getByTestId("stage-fullscreen");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();

  if (project === "mobile-iphone") {
    await expect
      .poll(() => page.evaluate(() => window.__fsCalls))
      .toContain("webkitEnterFullscreen");
    // Never the element API on an iPhone: it does not exist there.
    expect(await page.evaluate(() => window.__fsCalls)).not.toContain(
      "requestFullscreen",
    );
    // The stub raised `webkitbeginfullscreen`; the button follows it.
    await expect(button).toHaveAttribute("aria-pressed", "true");
    // The call's audio sinks are separate <audio> elements and untouched.
    const audioState = await page.evaluate(() =>
      Array.from(document.querySelectorAll("audio")).map((a) => ({
        connected: a.isConnected,
        hasStream: a.srcObject !== null,
      })),
    );
    expect(audioState.every((a) => a.connected)).toBe(true);
    // The player closing (swipe, Done) arrives as `webkitendfullscreen`.
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="call-stage"] video')!
        .dispatchEvent(new Event("webkitendfullscreen"));
    });
    await expect(button).toHaveAttribute("aria-pressed", "false");
  } else {
    await expect
      .poll(() => page.evaluate(() => window.__fsCalls))
      .toContain("requestFullscreen");
    await expect
      .poll(async () => (await geometry(page)).fullscreenElement, {
        timeout: 10_000,
      })
      .toBe("call-stage");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    const g = await geometry(page);
    expect(g.stageWidth).toBe(g.innerWidth);
    await button.click();
    await expect
      .poll(async () => (await geometry(page)).fullscreenElement)
      .toBeNull();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await expectNoSidewaysScroll(page);
  await leaveVoiceIfConnected(page);
});

test("the home-screen hint shows once on an iPhone in a tab, never on Android", async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name as MobileProject;
  await ensureVoiceChannel();
  await openApp(page);
  await joinLobbyFromPhone(page);
  await startShare(page);

  const hint = page.locator("[data-cinema-hint]");
  if (project !== "mobile-iphone") {
    await expect(hint).toHaveCount(0);
    await leaveVoiceIfConnected(page);
    return;
  }

  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Add pqp to your home screen");
  await page.screenshot({
    path: testInfo.outputPath(`${project}-portrait-hint.png`),
  });
  await hint.getByRole("button", { name: "Dismiss hint" }).click();
  await expect(hint).toHaveCount(0);
  await leaveVoiceIfConnected(page);

  // A fresh load, same browser: it remembers.
  await page.reload();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
  await joinLobbyFromPhone(page);
  await startShare(page);
  await expect(hint).toHaveCount(0);
  await leaveVoiceIfConnected(page);
});
