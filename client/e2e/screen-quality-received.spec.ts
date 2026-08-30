import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * What does the OTHER end actually receive when the quality menu moves?
 *
 * Every previous answer to this question was read off the local sender:
 * `getParameters().encodings[0].maxBitrate`, which only proves the browser
 * accepted a number we asked for. It cannot tell 360p from 1080p-squeezed-into
 * -360p-worth-of-bits, and those two look identical from the sending side and
 * completely different to the person watching. Reported as "I picked 360p and
 * it felt too good to be 360p", which is exactly the shape of a ceiling that
 * moved with no resolution behind it.
 *
 * So this measures at the RECEIVER, in a real server voice channel, with two
 * browser contexts: `inbound-rtp` `frameWidth` / `frameHeight` /
 * `framesPerSecond`, plus `bytesReceived` differenced over a fixed window for
 * a real kbps. Those four numbers are the only ones a viewer can perceive.
 *
 * THE SHARED SURFACE IS DELIBERATELY NOISY. A headless screen capture of a
 * mostly-static dark UI compresses to almost nothing, so the encoder never has
 * occasion to spend its ceiling, never comes under pressure, and never adapts:
 * every rung would measure the same and the run would "prove" the selector is
 * fine. The host page therefore paints an animated noise field over itself for
 * the duration, which is the incompressible worst case and the one where the
 * setting is supposed to bite.
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

// Two app boots, a media handshake, and five quality steps each with a settle
// window and a measurement window.
test.setTimeout(300_000);

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
    const win = window as unknown as {
      __pqpPCs: RTCPeerConnection[];
      __pqpScreenTracks: string[];
    };
    win.__pqpPCs = [];
    win.__pqpScreenTracks = [];

    const Native = window.RTCPeerConnection;
    class Hooked extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        win.__pqpPCs.push(this);
      }
    }
    window.RTCPeerConnection = Hooked as unknown as typeof RTCPeerConnection;

    const media = navigator.mediaDevices;
    const gdm = media.getDisplayMedia?.bind(media);
    if (gdm) {
      media.getDisplayMedia = async (
        constraints?: DisplayMediaStreamOptions,
      ) => {
        const stream = await gdm(constraints);
        for (const track of stream.getVideoTracks()) {
          win.__pqpScreenTracks.push(track.id);
        }
        return stream;
      };
    }
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

interface VoicePair {
  serverId: string;
  hostSuffix: string;
  guestSuffix: string;
  hostName: string;
}

async function seedVoiceServer(
  hostSuffix: string,
  guestSuffix: string,
): Promise<VoicePair> {
  const host = await materialiseAccount(hostSuffix);
  await materialiseAccount(guestSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "Received" }),
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

  return {
    serverId: server.id,
    hostSuffix,
    guestSuffix,
    hostName: host.displayName,
  };
}

async function joinVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: /stage/ }).first().click();
  await page.getByRole("button", { name: "Join Voice" }).click();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({ timeout: 20_000 });
}

async function chooseChannelQuality(page: Page, label: string): Promise<void> {
  await page
    .getByRole("button", { name: /^Video you send:/ })
    .click({ timeout: 10_000 });
  await page
    .getByRole("menuitemradio", { name: label, exact: true })
    .click({ timeout: 10_000 });
}

/**
 * Paint incompressible motion over the whole page for the capture to pick up.
 *
 * `pointer-events: none` so Playwright can still drive the controls underneath:
 * the actionability check hit-tests the click point, and an overlay that takes
 * no pointer events is not in the way.
 */
async function paintNoise(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    // Small and stretched, and repainted on a timer rather than every frame:
    // the point is incompressible change, not detail, and a CI runner that is
    // busy generating megabytes of noise is a CI runner that is not encoding.
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
  fps: number | null;
  kbps: number;
  framesDecoded: number;
}

/**
 * What arrived, over a window of real time.
 *
 * `bytesReceived` is differenced rather than read, because the counter is
 * cumulative from the start of the call: the absolute value carries every
 * earlier rung with it and would report an average of the whole session.
 */
async function receivedVideo(page: Page, windowMs: number): Promise<Received> {
  return page.evaluate(async (ms) => {
    const win = window as unknown as { __pqpPCs?: RTCPeerConnection[] };
    interface Row {
      id: string;
      bytes: number;
      timestamp: number;
      width: number | null;
      height: number | null;
      fps: number | null;
      framesDecoded: number;
    }
    const read = async (): Promise<Row[]> => {
      const rows: Row[] = [];
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
            framesPerSecond?: number;
            framesDecoded?: number;
          };
          if (stat.type !== "inbound-rtp" || stat.kind !== "video") {
            return;
          }
          rows.push({
            id: stat.id,
            bytes: stat.bytesReceived ?? 0,
            timestamp: stat.timestamp,
            width: stat.frameWidth ?? null,
            height: stat.frameHeight ?? null,
            fps: stat.framesPerSecond ?? null,
            framesDecoded: stat.framesDecoded ?? 0,
          });
        });
      }
      return rows;
    };

    const before = await read();
    await new Promise((resolve) => setTimeout(resolve, ms as number));
    const after = await read();

    // The busiest inbound stream is the share; with the camera off it is the
    // only one, and picking by traffic keeps a stale, dead stream from winning.
    let best: Received = {
      width: null,
      height: null,
      fps: null,
      kbps: 0,
      framesDecoded: 0,
    };
    for (const row of after) {
      const start = before.find((candidate) => candidate.id === row.id);
      if (!start) {
        continue;
      }
      const seconds = (row.timestamp - start.timestamp) / 1000;
      const kbps =
        seconds > 0 ? ((row.bytes - start.bytes) * 8) / seconds / 1000 : 0;
      if (kbps >= best.kbps) {
        best = {
          width: row.width,
          height: row.height,
          fps: row.fps,
          kbps: Math.round(kbps),
          framesDecoded: row.framesDecoded - start.framesDecoded,
        };
      }
    }
    return best;
  }, windowMs);
}

/** What the sender says it captured and was told to send. */
async function screenSender(page: Page) {
  return page.evaluate(async () => {
    const win = window as unknown as {
      __pqpPCs?: RTCPeerConnection[];
      __pqpScreenTracks?: string[];
    };
    const screens = new Set(win.__pqpScreenTracks ?? []);
    for (const pc of win.__pqpPCs ?? []) {
      if (pc.connectionState === "closed") {
        continue;
      }
      for (const sender of pc.getSenders()) {
        const track = sender.track;
        if (!track || track.kind !== "video" || !screens.has(track.id)) {
          continue;
        }
        const settings = track.getSettings();
        const params = sender.getParameters();
        const encoding = params.encodings?.[0];
        return {
          captureWidth: settings.width ?? null,
          captureHeight: settings.height ?? null,
          captureFps: settings.frameRate ?? null,
          maxBitrate: encoding?.maxBitrate ?? null,
          scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? null,
          degradationPreference: params.degradationPreference ?? null,
        };
      }
    }
    return null;
  });
}

/** Long enough for the encoder to have settled on the new rung. */
const SETTLE_MS = 9_000;
/** Long enough that the kbps is a rate and not a burst. */
const SAMPLE_MS = 6_000;

const RUNGS = ["Auto", "1080p", "720p", "480p", "360p"] as const;

/** The size each label promises, as short-side pixels. `Auto` promises nothing. */
const PROMISED_HEIGHT: Record<string, number | null> = {
  Auto: null,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
  "360p": 360,
};

test("a voice channel screen share arrives at the size the menu names", async ({
  page,
  browser,
}) => {
  const pair = await seedVoiceServer("sq-rx-a", "sq-rx-b");
  const watcher = await secondClient(
    browser,
    `/app/servers/${pair.serverId}`,
    pair.guestSuffix,
  );

  try {
    await bootAs(page, `/app/servers/${pair.serverId}`, pair.hostSuffix);
    await joinVoice(page);
    await joinVoice(watcher.page);

    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click({ timeout: 10_000 });
    await expect(
      watcher.page.getByText(`${pair.hostName} is presenting`),
    ).toBeVisible({ timeout: 30_000 });
    await paintNoise(page);

    const table: string[] = [];
    const measured: Record<string, Received> = {};

    for (const rung of RUNGS) {
      if (rung !== "Auto") {
        await chooseChannelQuality(page, rung);
      }
      await page.waitForTimeout(SETTLE_MS);
      const received = await receivedVideo(watcher.page, SAMPLE_MS);
      const sender = await screenSender(page);
      measured[rung] = received;
      table.push(
        [
          rung.padEnd(6),
          `${received.width}x${received.height}`.padEnd(11),
          `${Math.round(received.fps ?? 0)} fps`.padEnd(8),
          `${received.kbps} kbps`.padEnd(12),
          `capture ${sender?.captureWidth}x${sender?.captureHeight}`.padEnd(20),
          `ceiling ${sender?.maxBitrate}`.padEnd(18),
          `scale ${sender?.scaleResolutionDownBy}`,
        ].join(" | "),
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      ["", "RECEIVED SCREEN SHARE, per menu option", ...table, ""].join("\n"),
    );

    for (const rung of RUNGS) {
      const received = measured[rung]!;
      expect(received.framesDecoded, `${rung}: frames arrived`).toBeGreaterThan(
        0,
      );
      const promised = PROMISED_HEIGHT[rung];
      if (promised === null || promised === undefined) {
        continue;
      }
      // A menu that says 360p must produce 360p. One rung of slack (the
      // encoder may sit a step below under pressure, which is honest) but
      // never above: arriving LARGER than the label is the bug.
      expect(
        received.height,
        `${rung}: received height is not above what the label promises`,
      ).toBeLessThanOrEqual(promised);
    }
  } finally {
    await watcher.context.close();
  }
});
