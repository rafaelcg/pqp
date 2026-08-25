import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The WATCHER's side of a screen share, which had no surface at all.
 *
 * THE REPORT, FIRST-HAND. A screen share sent from the iOS app looked like 360p
 * on the web client watching it in the same call. There was no quality control
 * anywhere on the call for a viewer, so the viewer went to Settings, found the
 * one quality selector this product has — already reading 360p — moved it to
 * 1080p, and the picture stayed exactly as it was. Left the call, rejoined,
 * still the same.
 *
 * THE SELECTOR WAS NOT BROKEN, ITS LABEL WAS. `handleVideoQualityChange` in
 * `App.tsx` reaches `voice.setVideoQuality`, which reaches `setCameraMaxBitrate`
 * and `setScreenQuality` on the mesh manager, and every one of those writes
 * `RTCRtpSender.setParameters` on this machine's OWN senders. `maxBitrate` and
 * `scaleResolutionDownBy` are encoder parameters and live only on a sender;
 * `RTCRtpReceiver` has no counterpart to either. In a full mesh the presenter
 * encodes one stream per peer and that is what arrives, so a viewer moving that
 * selector could not possibly change what they see. The defect was a control
 * that read identically to a sender and to a watcher.
 *
 * WHAT THIS SPEC PINS, IN BOTH DIRECTIONS:
 *
 *  1. That the viewer's Settings choice really does not move the received
 *     picture, measured at the receiver with `inbound-rtp` frameWidth and
 *     frameHeight, walking Rafael's exact steps (360p then 1080p). This is the
 *     evidence, and it is a regression guard the other way round too: if a
 *     later change ever makes a viewer's rung move the incoming picture, that
 *     is a surprise worth failing on.
 *  2. That the viewer now HAS a surface on the call, that it offers no sizes
 *     (because there are none to offer), and that it names the size actually
 *     arriving. Before this change the control was hidden from anyone who was
 *     not sending video, which is how the wrong knob got reached for.
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

// Two app boots, a media handshake, and two measurement windows either side of
// a settings change.
test.setTimeout(360_000);

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
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return body;
}

/** Collect every peer connection the page opens, before the app's first line. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __pqpPCs: RTCPeerConnection[] };
    win.__pqpPCs = [];
    const Native = window.RTCPeerConnection;
    class Hooked extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        win.__pqpPCs.push(this);
      }
    }
    window.RTCPeerConnection = Hooked as unknown as typeof RTCPeerConnection;
  });
}

async function bootAs(page: Page, path: string, suffix: string): Promise<void> {
  await instrument(page);
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

async function secondClient(browser: Browser, path: string, suffix: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone", "camera"]);
  const page = await context.newPage();
  await bootAs(page, path, suffix);
  return { context, page };
}

async function seedVoiceServer(hostSuffix: string, guestSuffix: string) {
  const host = await materialiseAccount(hostSuffix);
  await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "Watching" }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "stage", type: "voice" }),
  });

  const invited = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({}),
  });
  const { invite } = (await invited.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(guestSuffix),
    body: "{}",
  });

  return { serverId: server.id, hostName: host.displayName };
}

async function joinVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: /stage/ }).first().click();
  await page.getByRole("button", { name: "Join Voice" }).click();
  await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });
}

/**
 * Paint incompressible motion over the whole page for the capture to pick up.
 *
 * Without it a headless capture of a static dark page compresses to almost
 * nothing, the encoder never comes under pressure, and every measurement in the
 * run reads the same whatever anybody chose. `pointer-events: none` so
 * Playwright can still drive the controls underneath.
 */
async function paintNoise(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    document.body.appendChild(canvas);
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(canvas.width, canvas.height);
    const paint = () => {
      const { data } = image;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (Math.random() * 256) | 0;
        data[i + 1] = (Math.random() * 256) | 0;
        data[i + 2] = (Math.random() * 256) | 0;
        data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    paint();
    setInterval(paint, 50);
  });
}

interface Received {
  width: number | null;
  height: number | null;
  framesDecoded: number;
}

/**
 * The size that actually arrived, off `inbound-rtp`.
 *
 * The only number a viewer can perceive, and the only one that can tell 360p
 * apart from 1080p squeezed into 360p worth of bits. Read from the busiest
 * inbound video stream, so a stale dead one cannot win.
 */
async function receivedVideo(page: Page): Promise<Received> {
  return page.evaluate(async () => {
    const win = window as unknown as { __pqpPCs?: RTCPeerConnection[] };
    let best: Received & { bytes: number } = {
      width: null,
      height: null,
      framesDecoded: 0,
      bytes: 0,
    };
    for (const pc of win.__pqpPCs ?? []) {
      if (pc.connectionState === "closed") {
        continue;
      }
      const stats = await pc.getStats();
      stats.forEach((entry) => {
        const stat = entry as RTCStats & {
          kind?: string;
          bytesReceived?: number;
          frameWidth?: number;
          frameHeight?: number;
          framesDecoded?: number;
        };
        if (stat.type !== "inbound-rtp" || stat.kind !== "video") {
          return;
        }
        const bytes = stat.bytesReceived ?? 0;
        if (bytes >= best.bytes) {
          best = {
            width: stat.frameWidth ?? null,
            height: stat.frameHeight ?? null,
            framesDecoded: stat.framesDecoded ?? 0,
            bytes,
          };
        }
      });
    }
    return {
      width: best.width,
      height: best.height,
      framesDecoded: best.framesDecoded,
    };
  });
}

/**
 * Pick a rung in Settings, which is the surface the report came from.
 *
 * Dismissed with Escape rather than Save on purpose: everything outside the
 * Profile section applies as it is changed (`patchLocal` calls straight through
 * to `onAudioSettingsLive`), so this is the whole of the interaction a person
 * actually performs, Save or no Save.
 */
async function chooseInSettings(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Voice & Video", exact: true }).click();
  // Located by its own options rather than by its label. A wrapping `<label>`
  // contributes the embedded control's value to its accessible name, so
  // `getByLabel("Video you send", { exact: true })` matches nothing and waits
  // out the whole test timeout.
  const select = page.getByRole("dialog").locator('select:has(option[value="1080p"])');
  await select.selectOption({ label });
  await expect(select).toHaveValue(label);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/** After a rung is picked, long enough for a change to have shown up. */
const SETTLE_MS = 15_000;

/**
 * Wait until the incoming picture has stopped growing, and say what it settled
 * at.
 *
 * THIS IS THE WHOLE METHODOLOGY OF THIS SPEC AND IT IS NOT OPTIONAL. A first
 * attempt simply settled for nine seconds between rungs and measured, and it
 * "proved" that a viewer choosing 1080p made the picture bigger: 480x270, then
 * 640x360, then 1280x720, in exactly the order the rungs were clicked. Every
 * one of those steps was WebRTC's own start-small-and-climb ramp, which takes
 * around thirty seconds on a fresh screen share and would have produced the
 * same three numbers with nobody touching anything. A fixed sleep cannot tell a
 * ramp from an effect, and reading it as an effect is precisely the mistake
 * this whole piece of work exists to correct.
 *
 * So the baseline is taken only once the size has been identical across several
 * consecutive samples. After that the encoder is at its plateau, and anything
 * that moves the picture moved it for a reason.
 */
async function waitForSteadyVideo(
  page: Page,
  { stableSamples = 5, intervalMs = 3_000, timeoutMs = 120_000 } = {},
): Promise<Received> {
  const deadline = Date.now() + timeoutMs;
  let last: Received | null = null;
  let repeats = 0;
  while (Date.now() < deadline) {
    const current = await receivedVideo(page);
    if (
      current.width !== null &&
      current.framesDecoded > 0 &&
      last !== null &&
      current.width === last.width &&
      current.height === last.height
    ) {
      repeats += 1;
      if (repeats >= stableSamples) {
        return current;
      }
    } else {
      repeats = 0;
    }
    last = current;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(
    `the incoming picture never settled; last seen ${last?.width}x${last?.height}`,
  );
}

test("a watcher is shown the size arriving, and cannot change it", async ({
  page,
  browser,
}) => {
  const { serverId, hostName } = await seedVoiceServer("vq-rx-a", "vq-rx-b");
  const watcher = await secondClient(
    browser,
    `/app/servers/${serverId}`,
    "vq-rx-b",
  );

  try {
    await bootAs(page, `/app/servers/${serverId}`, "vq-rx-a");
    await joinVoice(page);
    await joinVoice(watcher.page);

    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click({ timeout: 10_000 });
    await expect(
      watcher.page.getByText(`${hostName} is presenting`),
    ).toBeVisible({ timeout: 30_000 });
    await paintNoise(page);

    // --- the evidence -----------------------------------------------------
    // Baseline first, and only once the encoder has stopped climbing. See
    // `waitForSteadyVideo` for why a fixed sleep here produces a false result.
    const steady = await waitForSteadyVideo(watcher.page);
    expect(
      steady.framesDecoded,
      "frames are arriving at the watcher",
    ).toBeGreaterThan(0);

    // Rafael's exact steps: find the selector, move it down, move it up, and
    // look at the picture each time. Down first on purpose. A ramp can only
    // make the picture bigger, so a *drop* here could not be anything but the
    // rung, which makes 360p the direction where a real effect would be
    // impossible to mistake for the encoder warming up.
    await chooseInSettings(watcher.page, "360p");
    await watcher.page.waitForTimeout(SETTLE_MS);
    const at360 = await receivedVideo(watcher.page);
    await chooseInSettings(watcher.page, "1080p");
    await watcher.page.waitForTimeout(SETTLE_MS);
    const at1080 = await receivedVideo(watcher.page);

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "RECEIVED SCREEN SHARE, as the WATCHER moves their own quality rung",
        `  settled  ${steady.width}x${steady.height}`,
        `  360p     ${at360.width}x${at360.height}`,
        `  1080p    ${at1080.width}x${at1080.height}`,
        "",
      ].join("\n"),
    );

    // The whole point. A viewer's rung is a sender-side encoder parameter and
    // this machine is not the sender, so nothing about the incoming picture may
    // move. Asserted against the settled baseline rather than a fixed size,
    // because the size itself is the sender's business.
    expect(
      { width: at360.width, height: at360.height },
      "picking 360p as a watcher does not shrink what arrives",
    ).toEqual({ width: steady.width, height: steady.height });
    expect(
      { width: at1080.width, height: at1080.height },
      "picking 1080p as a watcher does not enlarge what arrives",
    ).toEqual({ width: steady.width, height: steady.height });

    // --- the surface ------------------------------------------------------
    // The watcher is sending no video at all, so before this change the call
    // carried no video control for them whatsoever, and Settings was the only
    // thing to reach for. This is the control that should have been there.
    const control = watcher.page.getByRole("button", {
      name: "Video you are receiving",
    });
    await expect(control).toBeVisible({ timeout: 10_000 });
    await control.click();

    const menu = watcher.page.getByRole("menu", {
      name: "Video you are receiving",
    });
    await expect(menu).toBeVisible();

    // NO SIZES. A rung offered to somebody who cannot act on it is the bug in
    // its original form: it reads as a control and does nothing.
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);

    // The size actually arriving, named, with the presenter's name on it and
    // the sentence that says whose choice it is.
    // Matched against the size read a moment ago rather than a fixed one: the
    // presenter's encoder is entitled to move, and the claim being tested is
    // that the readout agrees with `inbound-rtp`, not that any given size wins.
    const escaped = hostName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(
      menu.getByText(
        new RegExp(`${escaped}.*${at1080.width}x${at1080.height}`),
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByText(/The sender picks that size/)).toBeVisible();
  } finally {
    await watcher.context.close();
  }
});
