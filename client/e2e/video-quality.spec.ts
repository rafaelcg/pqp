import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Does picking a video quality change the bytes that leave this machine?
 *
 * Reported as "I picked 1080p and the share was still blurry", and the whole
 * difficulty of the question is that every cheap way of answering it lies. The
 * setting persists, the menu shows a tick next to the chosen row, the state
 * flows through three modules that all look right, and none of that is
 * evidence: the constraints are `ideal` (deliberately, so a 480p webcam still
 * works), so a browser is free to ignore them silently, and `setParameters`
 * rejections are swallowed on purpose so a refused ceiling cannot kill a call.
 * A test that asserts on React state, or on the stored setting, or on the
 * label under the button, passes with the entire encoder path disconnected.
 *
 * So this measures the encoder, on both video paths, through two windows that
 * only move when the real pipeline moves:
 *
 *   1. `RTCRtpSender.getParameters().encodings[0].maxBitrate` and
 *      `.degradationPreference` — what the browser has actually accepted, read
 *      back from the sender rather than from what we asked it for.
 *   2. `MediaStreamTrack.getSettings()` on the sending track, plus the
 *      `outbound-rtp` `frameWidth` / `frameHeight` the peer connection reports
 *      — the size genuinely being encoded, which is the number the person on
 *      the other end sees and the only one that can call a picture blurry.
 *
 * Senders are classified by hooking `getUserMedia` / `getDisplayMedia` before
 * the app boots and recording which video track ids came from which, so
 * "camera" and "screen" are never inferred from a bitrate this test is about
 * to assert on.
 *
 * The bitrate ceilings are asserted exactly, because they are the product's own
 * ladder (`lib/video-quality.ts`) and a change to them should have to change
 * this file too. The capture sizes are asserted directionally: `ideal` means a
 * webcam is allowed to approximate, and Chrome's fake device is a webcam.
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

// Two app boots, a media handshake, several renegotiations, and a settling
// window after each quality change.
test.setTimeout(180_000);

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
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return body;
}

/**
 * Everything the measurement needs, installed before the app's first line runs.
 *
 * Two hooks. `RTCPeerConnection` is collected so senders can be enumerated
 * later; `getUserMedia` / `getDisplayMedia` are wrapped so every video track
 * this page ever captures is filed under the API that produced it. The second
 * is what makes "this is the camera sender" a fact rather than a guess — the
 * alternative (reading the bitrate and deciding from its value) would make the
 * test agree with whatever the code did.
 */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __pqpPCs: RTCPeerConnection[];
      __pqpCameraTracks: string[];
      __pqpScreenTracks: string[];
      __pqpCameraRequests: unknown[];
    };
    win.__pqpPCs = [];
    win.__pqpCameraTracks = [];
    win.__pqpScreenTracks = [];
    win.__pqpCameraRequests = [];

    const Native = window.RTCPeerConnection;
    // `class ... extends` keeps `instanceof` and the prototype chain intact,
    // which a wrapping function would quietly break.
    class Hooked extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        win.__pqpPCs.push(this);
      }
    }
    window.RTCPeerConnection = Hooked as unknown as typeof RTCPeerConnection;

    const media = navigator.mediaDevices;
    const gum = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await gum(constraints);
      const video = stream.getVideoTracks();
      if (video.length > 0) {
        // Only a camera request carries video here; the mic capture is
        // audio-only and lands in neither list.
        win.__pqpCameraRequests.push(constraints?.video ?? null);
        for (const track of video) {
          win.__pqpCameraTracks.push(track.id);
        }
      }
      return stream;
    };

    const gdm = media.getDisplayMedia?.bind(media);
    if (gdm) {
      media.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
        const stream = await gdm(constraints);
        for (const track of stream.getVideoTracks()) {
          win.__pqpScreenTracks.push(track.id);
        }
        return stream;
      };
    }
  });
}

interface SenderReport {
  role: "camera" | "screen" | "unknown";
  trackId: string;
  /** `getSettings()` on the track the sender is actually sending. */
  width: number | null;
  height: number | null;
  frameRate: number | null;
  contentHint: string;
  /** Read back from the sender, not from what we asked for. */
  maxBitrate: number | null;
  maxFramerate: number | null;
  degradationPreference: string | null;
  /** What the peer connection says it is encoding, when it has encoded any. */
  rtpWidth: number | null;
  rtpHeight: number | null;
  framesEncoded: number | null;
  bytesSent: number | null;
  /**
   * The rate the encoder is currently aiming at: `min(bandwidth estimate,
   * ceiling)`, recomputed several times a second. This is where a ceiling stops
   * being a number on a parameters object and starts being bytes.
   */
  targetBitrate: number | null;
}

/**
 * Every outgoing video sender on the page, with what the encoder was told and
 * what the track is actually producing.
 *
 * Deliberately reports *all* of them rather than the one the caller wants: a
 * quality change that moves the camera and forgets the screen is one of the
 * two failures this file exists to catch, and it is only visible side by side.
 */
async function videoSenders(page: Page): Promise<SenderReport[]> {
  return page.evaluate(async () => {
    const win = window as unknown as {
      __pqpPCs?: RTCPeerConnection[];
      __pqpCameraTracks?: string[];
      __pqpScreenTracks?: string[];
    };
    const cameras = new Set(win.__pqpCameraTracks ?? []);
    const screens = new Set(win.__pqpScreenTracks ?? []);
    const reports: SenderReport[] = [];

    for (const pc of win.__pqpPCs ?? []) {
      if (pc.connectionState === "closed") {
        continue;
      }
      const stats = await pc.getStats();
      /** ssrc-less lookup: outbound video RTP keyed by the sender's track id. */
      const outbound = new Map<
        string,
        {
          frameWidth?: number;
          frameHeight?: number;
          framesEncoded?: number;
          bytesSent?: number;
          targetBitrate?: number;
          trackIdentifier?: string;
        }
      >();
      const mediaSources = new Map<string, string>();
      stats.forEach((entry) => {
        const stat = entry as RTCStats & {
          kind?: string;
          trackIdentifier?: string;
          mediaSourceId?: string;
        };
        if (stat.type === "media-source" && stat.kind === "video") {
          mediaSources.set(stat.id, stat.trackIdentifier ?? "");
        }
      });
      stats.forEach((entry) => {
        const stat = entry as RTCStats & {
          kind?: string;
          mediaSourceId?: string;
          frameWidth?: number;
          frameHeight?: number;
          framesEncoded?: number;
          bytesSent?: number;
          targetBitrate?: number;
        };
        if (stat.type !== "outbound-rtp" || stat.kind !== "video") {
          return;
        }
        const trackId = mediaSources.get(stat.mediaSourceId ?? "") ?? "";
        if (!trackId) {
          return;
        }
        outbound.set(trackId, {
          frameWidth: stat.frameWidth,
          frameHeight: stat.frameHeight,
          framesEncoded: stat.framesEncoded,
          bytesSent: stat.bytesSent,
          targetBitrate: stat.targetBitrate,
        });
      });

      for (const sender of pc.getSenders()) {
        const track = sender.track;
        if (!track || track.kind !== "video") {
          continue;
        }
        const settings = track.getSettings();
        const params = sender.getParameters();
        const encoding = params.encodings?.[0];
        const rtp = outbound.get(track.id);
        reports.push({
          role: cameras.has(track.id)
            ? "camera"
            : screens.has(track.id)
              ? "screen"
              : "unknown",
          trackId: track.id,
          width: settings.width ?? null,
          height: settings.height ?? null,
          frameRate: settings.frameRate ?? null,
          contentHint: track.contentHint ?? "",
          maxBitrate: encoding?.maxBitrate ?? null,
          maxFramerate: encoding?.maxFramerate ?? null,
          degradationPreference: params.degradationPreference ?? null,
          rtpWidth: rtp?.frameWidth ?? null,
          rtpHeight: rtp?.frameHeight ?? null,
          framesEncoded: rtp?.framesEncoded ?? null,
          bytesSent: rtp?.bytesSent ?? null,
          targetBitrate: rtp?.targetBitrate ?? null,
        });
      }
    }
    return reports;
  });
}

/**
 * One sender of a role, waited for rather than sampled once.
 *
 * `setParameters` is asynchronous and a quality change is applied to the track
 * and to the encoder independently, so reading immediately after the click
 * catches a half-applied state that is not a bug. Polling until the ceiling is
 * the expected one (or the timeout expires, which fails on the returned value)
 * is what makes the assertion about the outcome rather than about the timing.
 */
async function senderFor(
  page: Page,
  role: "camera" | "screen",
  expectedMaxBitrate?: number,
): Promise<SenderReport> {
  let last: SenderReport | undefined;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const reports = await videoSenders(page);
    const match = reports.find((report) => report.role === role);
    if (match) {
      last = match;
      if (
        expectedMaxBitrate === undefined ||
        match.maxBitrate === expectedMaxBitrate
      ) {
        return match;
      }
    }
    if (Date.now() > deadline) {
      if (last) {
        return last;
      }
      throw new Error(
        `no ${role} sender found; saw ${JSON.stringify(reports)}`,
      );
    }
    await page.waitForTimeout(500);
  }
}

/** Wait until the encoder has actually produced frames at the current size. */
async function settleEncoder(
  page: Page,
  role: "camera" | "screen",
): Promise<void> {
  const before = await senderFor(page, role);
  await expect
    .poll(
      async () => {
        const now = await senderFor(page, role);
        return (now.framesEncoded ?? 0) - (before.framesEncoded ?? 0);
      },
      { timeout: 20_000, message: `${role}: frames encoded after the change` },
    )
    .toBeGreaterThan(0);
}

async function bootAs(page: Page, path: string, suffix: string): Promise<void> {
  if (process.env.QUALITY_DEBUG) {
    page.on("console", (message) => {
      // eslint-disable-next-line no-console
      console.log(`[${suffix}:${message.type()}]`, message.text());
    });
  }
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

interface CallPair {
  conversationId: string;
  callerSuffix: string;
  calleeSuffix: string;
}

async function seedConversation(
  callerSuffix: string,
  calleeSuffix: string,
): Promise<CallPair> {
  await materialiseAccount(callerSuffix);
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
  return { conversationId: conversation.channelId, callerSuffix, calleeSuffix };
}

/**
 * Bring the call controls back before clicking one.
 *
 * The stage fades its bar to `pointer-events-none` after three idle seconds,
 * and `.click()` has no default timeout, so a click on a faded control waits
 * forever instead of failing. A pointer move is what a person does here too.
 */
async function wakeControls(page: Page): Promise<void> {
  const stage = page.getByTestId("call-stage");
  const box = await stage.boundingBox();
  if (!box) {
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 + 4);
  await expect(
    page.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible({ timeout: 5_000 });
}

/** Pick a rung from the in-call menu, through the same clicks a person makes. */
async function chooseQuality(page: Page, label: string): Promise<void> {
  await wakeControls(page);
  await page
    .getByRole("button", { name: /^Camera and screen quality:/ })
    .click({ timeout: 10_000 });
  await page
    .getByRole("menuitemradio", { name: label, exact: true })
    .click({ timeout: 10_000 });
}

/**
 * Assert the rate the encoder is actually aiming at, not the one it was told.
 *
 * `targetBitrate` is `min(bandwidth estimate, ceiling)`, so it is the one place
 * where a ceiling that was accepted by `setParameters` and then ignored would
 * show. Chrome holds a little headroom under the ceiling (it reports about five
 * sixths of it on a loopback link, where the estimate is never the binding
 * term), so the bound is a band rather than an equality.
 *
 * NOT ASSERTED HERE: bytes on the wire, or the encoded frame size. Chrome's
 * fake camera is a rolling pattern that compresses to nothing, so the encoder
 * never has occasion to spend its allowance and the ramp-up leaves the encoded
 * frame at 320x180 whatever the capture is. Measuring either would be measuring
 * the fake device. What the ceiling *permits*, and that the encoder took the
 * permission, is the honest limit of what a headless run can prove.
 *
 * THE BAND IS POLLED AS ONE CONDITION, not as a lower bound followed by an
 * upper one. Moving from 4 Mbps to 600 kbps takes the encoder a moment, and a
 * poll that only waits for "above half the new ceiling" is satisfied instantly
 * by the *old* value on the way down — then the upper bound fails against a
 * number the test never actually waited for.
 */
async function expectTargetBitrate(
  page: Page,
  role: "camera" | "screen",
  ceiling: number,
  label: string,
): Promise<void> {
  const floor = ceiling * 0.5;
  let last = 0;
  await expect
    .poll(
      async () => {
        last = (await senderFor(page, role)).targetBitrate ?? 0;
        return last > floor && last <= ceiling;
      },
      {
        timeout: 20_000,
        message: `${label}: encoder target settles inside (${floor}, ${ceiling}]`,
      },
    )
    .toBe(true);
  // Repeated as plain assertions so a later regression names the number rather
  // than reporting `false`.
  expect(last, `${label}: encoder target above the floor`).toBeGreaterThan(
    floor,
  );
  expect(last, `${label}: encoder target under the ceiling`).toBeLessThanOrEqual(
    ceiling,
  );
}

const PIXELS = (report: SenderReport) =>
  (report.width ?? 0) * (report.height ?? 0);

test("a DM call's camera encoder follows the quality menu", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("vq-cam-a", "vq-cam-b");
  const watcher = await secondClient(
    browser,
    `/app/dm/${pair.conversationId}`,
    pair.calleeSuffix,
  );

  try {
    await bootAs(page, `/app/dm/${pair.conversationId}`, pair.callerSuffix);
    await page
      .getByRole("button", { name: "Start video call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await watcher.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    // ---- the default, which is `auto` = 720p ---------------------------
    const auto = await senderFor(page, "camera", 1_500_000);
    // eslint-disable-next-line no-console
    console.log("[quality] camera auto:", JSON.stringify(auto));
    expect(auto.maxBitrate, "auto: camera ceiling").toBe(1_500_000);
    expect(auto.degradationPreference, "auto: degradation").toBe(
      "maintain-framerate",
    );
    expect(auto.contentHint, "auto: content hint").toBe("motion");
    // The bug this whole feature was written for: an unconstrained
    // `getUserMedia` resolves to 640x480 in every browser.
    expect(PIXELS(auto), "auto: capture is past the old 480p ceiling").toBeGreaterThan(
      640 * 480,
    );
    await settleEncoder(page, "camera");

    // ---- down to the bottom rung ---------------------------------------
    await chooseQuality(page, "360p");
    const low = await senderFor(page, "camera", 400_000);
    // eslint-disable-next-line no-console
    console.log("[quality] camera 360p:", JSON.stringify(low));
    expect(low.maxBitrate, "360p: camera ceiling").toBe(400_000);
    expect(low.trackId, "360p: same track, no re-capture").toBe(auto.trackId);
    expect(PIXELS(low), "360p: capture shrank").toBeLessThan(PIXELS(auto));
    await settleEncoder(page, "camera");

    // ---- and back up to the top ----------------------------------------
    await chooseQuality(page, "1080p");
    const high = await senderFor(page, "camera", 2_500_000);
    // eslint-disable-next-line no-console
    console.log("[quality] camera 1080p:", JSON.stringify(high));
    expect(high.maxBitrate, "1080p: camera ceiling").toBe(2_500_000);
    expect(high.trackId, "1080p: same track, no re-capture").toBe(auto.trackId);
    expect(PIXELS(high), "1080p: capture grew back").toBeGreaterThan(
      PIXELS(low),
    );
    await settleEncoder(page, "camera");

    await expectTargetBitrate(page, "camera", 2_500_000, "1080p");

    // Back down once more, because the direction that matters to the person who
    // asked for this is the one that *saves* their uplink. A ceiling the
    // encoder ignores on the way down is the whole failure mode.
    await chooseQuality(page, "360p");
    await settleEncoder(page, "camera");
    await expectTargetBitrate(page, "camera", 400_000, "back to 360p");
  } finally {
    await watcher.context.close();
  }
});

test("a DM call's screen encoder follows the quality menu", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("vq-scr-a", "vq-scr-b");
  const watcher = await secondClient(
    browser,
    `/app/dm/${pair.conversationId}`,
    pair.calleeSuffix,
  );

  try {
    await bootAs(page, `/app/dm/${pair.conversationId}`, pair.callerSuffix);
    await page
      .getByRole("button", { name: "Start voice call", exact: true })
      .click();
    await expect(page.getByTestId("call-stage")).toBeVisible({
      timeout: 20_000,
    });
    await watcher.page
      .getByRole("button", { name: "Accept" })
      .click({ timeout: 20_000 });

    await wakeControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click({ timeout: 10_000 });

    // One remote peer, so the mesh budget (5 Mbps / 1) does not bind and the
    // chosen ceiling is what governs. See `meshScreenBitrate`.
    const auto = await senderFor(page, "screen", 3_000_000);
    // eslint-disable-next-line no-console
    console.log("[quality] screen auto:", JSON.stringify(auto));
    expect(auto.maxBitrate, "auto: screen ceiling").toBe(3_000_000);
    expect(auto.degradationPreference, "auto: degradation").toBe(
      "maintain-framerate",
    );
    await settleEncoder(page, "screen");
    await expectTargetBitrate(page, "screen", 3_000_000, "auto");

    await chooseQuality(page, "1080p");
    const high = await senderFor(page, "screen", 4_000_000);
    // eslint-disable-next-line no-console
    console.log("[quality] screen 1080p:", JSON.stringify(high));
    expect(high.maxBitrate, "1080p: screen ceiling").toBe(4_000_000);
    expect(high.trackId, "1080p: the capture is not restarted").toBe(
      auto.trackId,
    );
    await expectTargetBitrate(page, "screen", 4_000_000, "1080p");

    await chooseQuality(page, "360p");
    const low = await senderFor(page, "screen", 600_000);
    // eslint-disable-next-line no-console
    console.log("[quality] screen 360p:", JSON.stringify(low));
    expect(low.maxBitrate, "360p: screen ceiling").toBe(600_000);
    // Capture size is deliberately NOT on this ladder: a screen grabbed small
    // has lost the pixels permanently. The bitrate is the reversible lever.
    expect(low.width, "360p: capture size is unchanged").toBe(auto.width);
    expect(low.height, "360p: capture size is unchanged").toBe(auto.height);
    await expectTargetBitrate(page, "screen", 600_000, "360p");
  } finally {
    await watcher.context.close();
  }
});

// -------------------------------------------------------- server voice channel

/**
 * Watch one `<video>` for a window of real time and report what it did.
 *
 * The same measurement `screen-reshare.spec.ts` makes, and for the same reason:
 * a `<video>` bound to a dead track still reports `readyState: 4`, still has an
 * `srcObject`, still reports `videoWidth > 0` (it keeps the last decoded
 * dimensions) and is still "visible". `videoWidth > 0` cannot fail here, so it
 * proves nothing. `totalVideoFrames` only advances when frames are genuinely
 * being painted, and the pixel sample catches the case it cannot: painting, but
 * painting black.
 */
async function sampleVideo(video: Locator, windowMs: number) {
  return video.evaluate(async (element, ms) => {
    const el = element as HTMLVideoElement;
    const quality = () => el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const before = quality();
    await new Promise((resolve) => setTimeout(resolve, ms as number));
    const after = quality();
    const track = (el.srcObject as MediaStream | null)?.getVideoTracks()[0];

    let brightest = -1;
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.min(el.videoWidth, 160));
      canvas.height = Math.max(1, Math.min(el.videoHeight, 120));
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(el, 0, 0, canvas.width, canvas.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        max = Math.max(max, (data[i]! + data[i + 1]! + data[i + 2]!) / 3);
      }
      brightest = max;
    }

    return {
      paintedFrames: after - before,
      trackMuted: track?.muted ?? true,
      trackReadyState: track?.readyState ?? "none",
      videoWidth: el.videoWidth,
      brightestPixel: brightest,
    };
  }, windowMs);
}

type FrameSample = Awaited<ReturnType<typeof sampleVideo>>;

function expectLive(sample: FrameSample, label: string) {
  expect(sample.paintedFrames, `${label}: frames painted`).toBeGreaterThan(0);
  expect(sample.trackMuted, `${label}: track muted`).toBe(false);
  expect(sample.trackReadyState, `${label}: track state`).toBe("live");
  expect(sample.brightestPixel, `${label}: brightest pixel`).toBeGreaterThan(8);
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
    body: JSON.stringify({ name: "Quality" }),
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
  await expect(page.getByText("Live")).toBeVisible({ timeout: 20_000 });
}

/**
 * The voice channel's own quality menu. Unlike the conversation call's, the
 * panel it lives in never fades, so there is nothing to wake first.
 */
async function chooseChannelQuality(page: Page, label: string): Promise<void> {
  await page
    .getByRole("button", { name: /^Camera and screen quality:/ })
    .click({ timeout: 10_000 });
  await page
    .getByRole("menuitemradio", { name: label, exact: true })
    .click({ timeout: 10_000 });
}

/** How long each frame-counting window runs. Long enough to be unambiguous. */
const SAMPLE_MS = 4_000;

test("a camera in a server voice channel reaches the other member", async ({
  page,
  browser,
}) => {
  const pair = await seedVoiceServer("vq-vc-a", "vq-vc-b");
  const watcher = await secondClient(
    browser,
    `/app/servers/${pair.serverId}`,
    pair.guestSuffix,
  );

  try {
    await bootAs(page, `/app/servers/${pair.serverId}`, pair.hostSuffix);
    await joinVoice(page);
    await joinVoice(watcher.page);

    // ---- camera on ------------------------------------------------------
    await page
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click({ timeout: 10_000 });

    const remoteTile = watcher.page.getByLabel(`${pair.hostName}'s camera`);
    await expect(remoteTile).toBeVisible({ timeout: 30_000 });
    const remote = await sampleVideo(remoteTile, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[quality] channel camera, watcher:", JSON.stringify(remote));
    expectLive(remote, "channel camera");

    // The presenter's own preview renders `localCameraStream` directly and
    // never touches a peer connection, so it is worth almost nothing as
    // evidence — but a missing one is still a bug in this panel.
    await expect(page.getByLabel("Your camera")).toBeVisible();

    // ---- and a screen share alongside it --------------------------------
    // Discord's rule, and the reason this panel got a camera at all: the two
    // are independent tiles, not two settings of one video slot.
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click({ timeout: 10_000 });
    await expect(
      watcher.page.getByText(`${pair.hostName} is presenting`),
    ).toBeVisible({ timeout: 30_000 });

    const stillLive = await sampleVideo(remoteTile, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[quality] camera during share:", JSON.stringify(stillLive));
    expectLive(stillLive, "camera during share");

    // ---- the control this channel never had -----------------------------
    await chooseChannelQuality(page, "360p");
    const camera = await senderFor(page, "camera", 400_000);
    const screen = await senderFor(page, "screen", 600_000);
    // eslint-disable-next-line no-console
    console.log(
      "[quality] channel senders:",
      JSON.stringify({ camera, screen }),
    );
    expect(camera.maxBitrate, "360p: channel camera ceiling").toBe(400_000);
    expect(screen.maxBitrate, "360p: channel screen ceiling").toBe(600_000);
    expect(camera.width, "360p: channel camera capture shrank").toBe(640);

    // Still a picture at the other end after the change: the whole promise of
    // re-shaping the live track rather than re-capturing it.
    const afterChange = await sampleVideo(remoteTile, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[quality] camera after 360p:", JSON.stringify(afterChange));
    expectLive(afterChange, "camera after the quality change");

    // ---- camera off, share untouched ------------------------------------
    await page
      .getByRole("button", { name: "Turn camera off", exact: true })
      .click({ timeout: 10_000 });
    await expect(remoteTile).toBeHidden({ timeout: 20_000 });
    await expect(
      watcher.page.getByText(`${pair.hostName} is presenting`),
    ).toBeVisible();
  } finally {
    await watcher.context.close();
  }
});
