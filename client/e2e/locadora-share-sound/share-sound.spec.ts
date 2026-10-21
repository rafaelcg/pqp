import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { snesPattern } from "../../../apps/locadora/e2e/patterns";
import { startAppsOrigin, type AppsOrigin } from "../locadora-guest/apps";

/**
 * "SHARE INSIDE LOCADORA HAS NO SOUND" (2026-10-21), MEASURED AT THE VIEWER.
 *
 * Two people in one voice call. One starts Locadora, loads a generated test pattern (never a game), starts it and
 * shares the app pane into the call. The game's own sound is a steady 440 Hz tone played through the same door the
 * core uses (the test patterns are silent, exactly as in the app's own mute e2e), and the call's voices are a
 * steady 880 Hz tone that the sharer's tab plays, which is what a browser tab capture would also have carried.
 * What the VIEWER receives is read as the energy at each of the two frequencies in the audio of the share they are
 * watching:
 *
 *   - the game (440 Hz) must be heard, and
 *   - the call (880 Hz) must NOT come back inside the share.
 *
 * Before the fix the pane share asked the browser for no sound at all (`audio: false` in `lib/apps/pane-share.ts`,
 * nothing in the whole-tab path either) and published a picture only: the viewer had no audio in the share.
 *
 * `getDisplayMedia` is a stub that returns a canvas as the picture, because headless Chromium cannot capture a
 * tab. It also behaves the way Chrome's tab capture does for the thing this test is about: when the page asks
 * for audio it hands over the tab's sound, which contains the call. That is what makes the second assertion mean
 * something. A real capture (headed, `E2E_REAL_CAPTURE=1`) skips the stub.
 */

const CLIENT_PORT = Number(process.env.E2E_SHARE_SOUND_CLIENT_PORT ?? 5251);
const SERVER_PORT = Number(process.env.E2E_SHARE_SOUND_SERVER_PORT ?? 3151);
const APPS_PORT = Number(process.env.E2E_SHARE_SOUND_APPS_PORT ?? 5252);
const CLIENT = `http://localhost:${CLIENT_PORT}`;
const API = `http://localhost:${SERVER_PORT}`;
const REAL_CAPTURE = process.env.E2E_REAL_CAPTURE === "1";

/** Seeded Sandbox members that hold no socket of their own (`server/src/services/dev-seed.ts`). */
const SHARER = "bia";
const VIEWER = "fabi";
const GAME_HZ = 440;
const CALL_HZ = 880;

let apps: AppsOrigin;
let scratch: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  apps = await startAppsOrigin(APPS_PORT, CLIENT);
  scratch = mkdtempSync(join(tmpdir(), "pqp-share-sound-"));
  // a cold `vite dev` optimises its dependencies on the first visit and reloads once: pay that before measuring
  const warm = await browser.newPage({ baseURL: CLIENT });
  await warm.addInitScript((who) => localStorage.setItem("pqp:dev-user-suffix", who), SHARER);
  await warm.goto("/app");
  await warm.getByText("Lobby").first().waitFor({ timeout: 90_000 });
  await warm.waitForTimeout(1_500);
  await warm.close();
});

test.afterAll(async () => {
  await apps?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const headers = (who: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${who}`,
});

/** A fresh voice channel on the Sandbox hall, so no session or call of an earlier run is in the way. */
async function freshVoiceChannel(): Promise<string> {
  const servers = (await (await fetch(`${API}/api/servers`, { headers: headers(SHARER) })).json()) as {
    servers: Array<{ id: string; name: string }>;
  };
  const sandbox = servers.servers.find((server) => server.name === "Sandbox");
  if (!sandbox) throw new Error("the dev seed's Sandbox hall is not there");
  const name = `sound-${Date.now().toString(36)}`;
  const created = await fetch(`${API}/api/servers/${sandbox.id}/channels`, {
    method: "POST",
    headers: headers(SHARER),
    body: JSON.stringify({ name, type: "voice" }),
  });
  expect(created.ok).toBe(true);
  return name;
}

/**
 * Runs in every frame before any script. In the app's frame it records the audio contexts the core makes (so a
 * test can play the game's tone through the same door); in the page it stands in for the screen capture picker.
 */
function instrument(options: { stubCapture: boolean; regionCapture?: boolean }) {
  const w = window as unknown as Record<string, unknown> & { __ctxs: unknown[]; __captures: unknown[] };
  w.__ctxs = [];
  w.__captures = [];
  const Native = w.AudioContext as (new (...args: unknown[]) => AudioContext) | undefined;
  if (Native) {
    class Recorded extends Native {
      constructor(...args: unknown[]) {
        super(...args);
        w.__ctxs.push(this);
      }
    }
    w.AudioContext = Recorded;
    w.webkitAudioContext = Recorded;
  }
  if (options.regionCapture === false) {
    // a browser that cannot crop a tab capture to an element: the page falls back to the whole tab
    for (const name of ["CropTarget", "BrowserCaptureMediaStreamTrack"]) {
      Object.defineProperty(window, name, { configurable: true, value: undefined });
    }
  }
  if (!options.stubCapture || !navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    w.__captures.push(JSON.parse(JSON.stringify(constraints ?? {})));
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d")!;
    let hue = 0;
    setInterval(() => {
      hue = (hue + 7) % 360;
      context.fillStyle = `hsl(${hue} 70% 45%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 33);
    const stream = canvas.captureStream(30);
    // a tab capture's video track can be cropped to an element (CropTarget): the page crops to the pane, so this must too
    (stream.getVideoTracks()[0] as unknown as { cropTo: () => Promise<void> }).cropTo = async () => {};
    const audio = (constraints as { audio?: unknown } | undefined)?.audio;
    if (audio && audio !== false) {
      // what a Chrome tab capture hands over when sound is asked for: the tab's own sound, with the call in it
      const context = new AudioContext();
      const call = context.createOscillator();
      call.frequency.value = 880;
      const gain = context.createGain();
      gain.gain.value = 0.3;
      const out = context.createMediaStreamDestination();
      call.connect(gain).connect(out);
      call.start();
      for (const track of out.stream.getAudioTracks()) stream.addTrack(track);
    }
    return stream;
  };
}

async function signedInPage(context: BrowserContext, who: string): Promise<Page> {
  await context.addInitScript((suffix) => localStorage.setItem("pqp:dev-user-suffix", suffix), who);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto("/app");
  return page;
}

async function joinCall(page: Page, channel: string) {
  await page.getByRole("button", { name: new RegExp(channel) }).first().click();
  await page.getByRole("button", { name: /Join Voice/ }).click();
  await expect(page.getByText("Voice connected")).toBeVisible();
}

/** Starts Locadora in the call's channel and takes the seat. */
async function startLocadora(page: Page) {
  await page.getByTestId("apps-button").click();
  await page.getByTestId("apps-launcher").getByText("Locadora").first().click();
  await page.getByTestId("apps-launcher").getByRole("button", { name: /^Start$/ }).click();
  const sheet = page.locator('[role="dialog"]:has-text("Join Locadora?")');
  // the join sheet is only asked once per account; a seat taken before goes straight in
  await sheet.getByRole("button", { name: /^Join$/ }).click({ timeout: 6_000 }).catch(() => {});
}

function appFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(`http://localhost:${APPS_PORT}/`));
  if (!frame) throw new Error("the Locadora frame is not there");
  return frame;
}

async function loadAndStartGame(page: Page) {
  let frame: Frame | null = null;
  await expect
    .poll(() => {
      frame = page.frames().find((candidate) => candidate.url().startsWith(`http://localhost:${APPS_PORT}/`)) ?? null;
      return frame !== null;
    })
    .toBe(true);
  frame = appFrame(page);
  // the walkthrough shows on a device that has not seen it (a fresh browser context always has not)
  await frame
    .locator("#v-onboarding .loc-onb-foot .loc-onb-btn-ghost")
    .filter({ hasText: /skip/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
  const path = join(scratch, "pattern.sfc");
  writeFileSync(path, snesPattern());
  const chooser = page.waitForEvent("filechooser");
  await frame.locator(".loc-top-pick").click();
  await (await chooser).setFiles(path);
  const start = frame.locator('.loc-start[data-choice="fresh"]').first();
  await start.waitFor({ state: "visible", timeout: 45_000 });
  await start.click();
  await frame.locator("canvas.ejs_canvas").waitFor({ state: "visible", timeout: 30_000 });
  return appFrame(page);
}

/** A steady tone through the door the core plays through: the context's own destination. */
async function playGameTone(frame: Frame, hz: number) {
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { __ctxs: AudioContext[] }).__ctxs.filter((c) => c.state !== "closed").length))
    .toBeGreaterThan(0);
  await frame.evaluate(async (frequency) => {
    const contexts = (window as unknown as { __ctxs: AudioContext[] }).__ctxs.filter((c) => c.state !== "closed");
    const context = contexts[contexts.length - 1]!;
    await context.resume();
    const tone = context.createOscillator();
    tone.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.value = 0.4;
    tone.connect(gain).connect(context.destination);
    tone.start();
  }, hz);
}

interface Heard {
  /** Energy at the game's and at the call's frequency, 0 to about 1 (an amplitude), in the best share audio. */
  game: number;
  call: number;
  /** How many media elements on the page carry an audio track of a share, and how many audio tracks they hold. */
  elements: number;
  tracks: number;
}

/** What the viewer's page is playing out of its screen share: Goertzel energy at the two tones. */
async function heardAtViewer(page: Page): Promise<Heard> {
  return page.evaluate(
    async ({ game, call }) => {
      const media = [...document.querySelectorAll("video, audio")] as HTMLMediaElement[];
      const streams = media
        .map((element) => element.srcObject)
        .filter((source): source is MediaStream => source instanceof MediaStream && source.getAudioTracks().length > 0);
      const goertzel = (samples: Float32Array, rate: number, frequency: number) => {
        const w = (2 * Math.PI * frequency) / rate;
        const coeff = 2 * Math.cos(w);
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < samples.length; i += 1) {
          // a Hann window keeps a tone between bins from smearing into the other
          const windowed = samples[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1)));
          s0 = windowed + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        return (2 * Math.sqrt(Math.max(power, 0))) / (samples.length * 0.5);
      };
      let bestGame = 0;
      let bestCall = 0;
      let tracks = 0;
      const context = new AudioContext();
      await context.resume();
      for (const stream of streams) {
        tracks += stream.getAudioTracks().length;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 16384;
        source.connect(analyser);
        await new Promise((resolve) => setTimeout(resolve, 600));
        for (let round = 0; round < 6; round += 1) {
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          bestGame = Math.max(bestGame, goertzel(data, context.sampleRate, game));
          bestCall = Math.max(bestCall, goertzel(data, context.sampleRate, call));
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        source.disconnect();
      }
      await context.close();
      return { game: bestGame, call: bestCall, elements: streams.length, tracks };
    },
    { game: GAME_HZ, call: CALL_HZ },
  );
}

/** What the app's frame says about its audio hub: the speakers' mute and the share's tap. */
async function hubState(frame: Frame): Promise<{ silent: boolean; tapping: boolean }> {
  return frame.evaluate(() => {
    const hub = (window as unknown as Record<symbol, { silent: boolean; tapping: boolean }>)[Symbol.for("pqp.locadora.audioHub")]!;
    return { silent: hub.silent, tapping: hub.tapping };
  });
}

/** Two people in a call, the sharer with Locadora running a test pattern that plays the game's tone. */
async function setUp(browser: Browser, options: { regionCapture: boolean }) {
  const channel = await freshVoiceChannel();
  const media = REAL_CAPTURE ? { permissions: ["microphone" as const] } : {};
  const sharerContext = await browser.newContext({ baseURL: CLIENT, viewport: { width: 1280, height: 800 }, ...media });
  await sharerContext.addInitScript(instrument, { stubCapture: !REAL_CAPTURE, regionCapture: options.regionCapture });
  const viewerContext = await browser.newContext({ baseURL: CLIENT, viewport: { width: 1280, height: 800 }, ...media });
  const sharer = await signedInPage(sharerContext, SHARER);
  const viewer = await signedInPage(viewerContext, VIEWER);
  await joinCall(sharer, channel);
  await joinCall(viewer, channel);
  await startLocadora(sharer);
  const frame = await loadAndStartGame(sharer);
  await playGameTone(frame, GAME_HZ);
  // the sharer's tab also plays the call: what a tab capture would carry along if it were asked for sound
  await sharer.evaluate(async (hz) => {
    const context = new AudioContext();
    await context.resume();
    const tone = context.createOscillator();
    tone.frequency.value = hz;
    const gain = context.createGain();
    gain.gain.value = 0.3;
    tone.connect(gain).connect(context.destination);
    tone.start();
  }, CALL_HZ);
  return { sharer, viewer, frame };
}

const shareSwitch = (page: Page) => page.getByRole("switch", { name: /Share screen/ });

async function captureRequests(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __captures: Array<Record<string, unknown>> }).__captures);
}

for (const [label, regionCapture] of [
  ["the pane cropped out of the tab (Chromium)", true],
  ["the whole tab (Safari, Firefox, anything without region capture)", false],
] as const) {
  test(`a game shared into the call is heard by the viewer, and the call does not come back inside it: ${label}`, async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const { sharer, viewer } = await setUp(browser, { regionCapture });

    await shareSwitch(sharer).click();
    await expect(shareSwitch(sharer)).toBeChecked();
    await viewer.waitForTimeout(5_000);
    await viewer.screenshot({ path: testInfo.outputPath("viewer.png") });

    const heard = await heardAtViewer(viewer);
    console.warn(`[${label}] viewer heard`, JSON.stringify(heard));
    // no sound is asked of the browser: the tab's holds the call
    if (!REAL_CAPTURE) {
      const asked = await captureRequests(sharer);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.audio).toBe(false);
    }
    // the game is in the share, the call is not
    expect(heard.tracks).toBeGreaterThan(0);
    expect(heard.game).toBeGreaterThan(0.02);
    expect(heard.call).toBeLessThan(0.01);
  });
}

test("the sharer's own M mutes only their speakers, a stop ends the app's sound, and a second share has it again", async ({ browser }) => {
  test.setTimeout(300_000);
  const { sharer, viewer, frame } = await setUp(browser, { regionCapture: true });
  expect(await hubState(frame)).toEqual({ silent: false, tapping: false });

  await shareSwitch(sharer).click();
  await expect(shareSwitch(sharer)).toBeChecked();
  await expect.poll(async () => (await hubState(frame)).tapping).toBe(true);
  await viewer.waitForTimeout(4_000);
  expect((await heardAtViewer(viewer)).game).toBeGreaterThan(0.02);

  // the sound button (what M does): the sharer's speakers go quiet, and the people watching still hear the game
  await frame.locator("#stage").hover();
  await frame.locator('[data-action="sound"]').dispatchEvent("click");
  await expect.poll(async () => (await hubState(frame)).silent).toBe(true);
  await viewer.waitForTimeout(1_500);
  const whileMuted = await heardAtViewer(viewer);
  console.warn("viewer heard while the sharer was muted", JSON.stringify(whileMuted));
  expect(whileMuted.game).toBeGreaterThan(0.02);

  // stop: the app is told to stop sending and the tap is gone
  await shareSwitch(sharer).click();
  await expect(shareSwitch(sharer)).not.toBeChecked();
  await expect.poll(async () => (await hubState(frame)).tapping).toBe(false);

  // and the next share carries the sound again, with no new game started
  await frame.locator("#stage").hover();
  await frame.locator('[data-action="sound"]').dispatchEvent("click");
  await expect.poll(async () => (await hubState(frame)).silent).toBe(false);
  await shareSwitch(sharer).click();
  await expect(shareSwitch(sharer)).toBeChecked();
  await expect.poll(async () => (await hubState(frame)).tapping).toBe(true);
  await viewer.waitForTimeout(4_000);
  expect((await heardAtViewer(viewer)).game).toBeGreaterThan(0.02);
});

