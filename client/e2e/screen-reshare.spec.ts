import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Share, stop, share again — does the SECOND share reach the other side?
 *
 * Reported verbatim: "a transmissão estava completamente preta para ele
 * enquanto na minha visão estava normal". The asymmetry is the whole reason it
 * survived so long: the presenter renders `localScreenStream` directly and
 * never goes near a peer connection, so their own preview is always fine. Only
 * the watcher sees the black rectangle.
 *
 * The mechanism this pins is on the WATCHER's side. Screen video is the one
 * incoming stream the mesh identifies negatively ("video from this peer that is
 * not their announced camera"), the presenter's `removeTrack` only *mutes* the
 * receiver's track rather than ending it, and `classifyVideo` is first-wins
 * over insertion order — so after a stop-and-reshare the map holds
 * `{ share-1 (dead), share-2 (live) }` and the tile points at the corpse.
 *
 * Which is why NONE of the cheap assertions can be trusted here. A `<video>`
 * bound to a muted remote track still reports `readyState: 4`, still reports
 * `videoWidth > 0` (it keeps the dimensions of the stream it last decoded), is
 * still "visible", and still has a `srcObject`. Everything a normal e2e test
 * looks at says the share is fine. So this measures two things that only move
 * when frames are genuinely arriving and being painted:
 *
 *   1. `getVideoPlaybackQuality().totalVideoFrames` on the exact element the
 *      watcher is looking at, sampled across a window of real time. Per-element,
 *      so it cannot be satisfied by some other live video on the page.
 *   2. `getStats()` `framesDecoded` / `framesReceived` on the watcher's inbound
 *      video RTP, via an `RTCPeerConnection` constructor hook installed before
 *      the app boots.
 *
 * Both must advance for the second share, and the delta is compared against the
 * FIRST share on the same element — an absolute frame threshold would encode
 * whatever throughput this machine happens to manage.
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

// Two app boots, a media handshake, and four renegotiations per test, plus the
// sampling windows — which are wall-clock time this test spends deliberately.
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
 * Collect every `RTCPeerConnection` the page opens, so a test can read real
 * transport stats rather than infer them from the DOM. Must run before the app
 * script does, hence `addInitScript`.
 */
async function hookPeerConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const seen: RTCPeerConnection[] = [];
    (window as unknown as { __pqpPCs: RTCPeerConnection[] }).__pqpPCs = seen;
    // A `class ... extends` keeps `instanceof` and the prototype chain intact,
    // which a wrapping function would quietly break for anything the app does
    // with the constructor.
    class Hooked extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        seen.push(this);
      }
    }
    window.RTCPeerConnection = Hooked as unknown as typeof RTCPeerConnection;
  });
}

interface InboundVideo {
  framesDecoded: number;
  framesReceived: number;
  bytesReceived: number;
}

/** Summed inbound video RTP across every peer connection on the page. */
async function inboundVideo(page: Page): Promise<InboundVideo> {
  return page.evaluate(async () => {
    const pcs =
      (window as unknown as { __pqpPCs?: RTCPeerConnection[] }).__pqpPCs ?? [];
    const total = { framesDecoded: 0, framesReceived: 0, bytesReceived: 0 };
    for (const pc of pcs) {
      if (pc.connectionState === "closed") {
        continue;
      }
      const report = await pc.getStats();
      report.forEach((entry) => {
        const stat = entry as RTCStats & {
          kind?: string;
          framesDecoded?: number;
          framesReceived?: number;
          bytesReceived?: number;
        };
        if (stat.type !== "inbound-rtp" || stat.kind !== "video") {
          return;
        }
        total.framesDecoded += stat.framesDecoded ?? 0;
        total.framesReceived += stat.framesReceived ?? 0;
        total.bytesReceived += stat.bytesReceived ?? 0;
      });
    }
    return total;
  });
}

interface FrameSample {
  /** Frames the element painted during the window. Zero means black. */
  paintedFrames: number;
  /** True while the element is bound to a dead (muted) remote track. */
  trackMuted: boolean;
  trackReadyState: string;
  /** Stream id, so the reshare can be shown to be a DIFFERENT stream. */
  streamId: string;
  videoWidth: number;
  readyState: number;
  /** Brightest pixel in a downscaled frame grab, 0-255. 0 means truly black. */
  brightestPixel: number;
  meanPixel: number;
}

/**
 * Watch one `<video>` for `windowMs` of real time and report what it actually
 * did. `totalVideoFrames` is the count of frames the element has painted for
 * its current source, so its delta over a window is the honest answer to "is
 * this thing moving", regardless of what `readyState` or `videoWidth` claim.
 */
async function sampleVideo(
  video: Locator,
  windowMs: number,
): Promise<FrameSample> {
  return video.evaluate(async (element, ms) => {
    const el = element as HTMLVideoElement;
    const quality = () => el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const before = quality();
    await new Promise((resolve) => setTimeout(resolve, ms as number));
    const after = quality();
    const stream = el.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()[0] ?? null;

    // Draw the current frame small and look for any non-black pixel. A frozen
    // last-frame would still be bright, so this on its own is not sufficient —
    // it is here to catch the "painting, but painting black" case the frame
    // counter alone cannot distinguish.
    let brightest = -1;
    let mean = -1;
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.min(el.videoWidth, 160));
      canvas.height = Math.max(1, Math.min(el.videoHeight, 120));
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(el, 0, 0, canvas.width, canvas.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let max = 0;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        max = Math.max(max, luma);
        sum += luma;
      }
      brightest = max;
      mean = sum / (data.length / 4);
    }

    return {
      paintedFrames: after - before,
      trackMuted: track?.muted ?? true,
      trackReadyState: track?.readyState ?? "none",
      streamId: stream?.id ?? "",
      videoWidth: el.videoWidth,
      readyState: el.readyState,
      brightestPixel: brightest,
      meanPixel: mean,
    };
  }, windowMs);
}

/**
 * Wait for the element to decode its first frame, but do NOT fail if it never
 * does — that is one of the outcomes under test, and it deserves to be reported
 * by the frame measurement below rather than by a setup poll timing out.
 */
async function settle(video: Locator, timeout: number): Promise<void> {
  await expect(video).toBeVisible({ timeout });
  try {
    await expect
      .poll(
        () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth > 0),
        { timeout },
      )
      .toBe(true);
  } catch {
    // Deliberately swallowed: `sampleVideo` reports what actually happened.
  }
}

/** How long each frame-counting window runs. Long enough to be unambiguous. */
const SAMPLE_MS = 4_000;

/**
 * Bring the call controls back.
 *
 * The stage fades its control bar to `pointer-events-none opacity-0` after a
 * few idle seconds, and every sampling window in this test is several idle
 * seconds by construction — so without this the "stop sharing" click times out
 * against the video that is now on top of the button. A pointer move is what a
 * person does here too.
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

/**
 * Assert a sample describes a live picture. Kept as one place so the DM and
 * the voice-channel test cannot drift into asserting different things.
 */
function expectLive(sample: FrameSample, label: string) {
  expect(sample.paintedFrames, `${label}: frames painted`).toBeGreaterThan(0);
  expect(sample.trackMuted, `${label}: remote track muted`).toBe(false);
  expect(sample.trackReadyState, `${label}: track state`).toBe("live");
  expect(sample.brightestPixel, `${label}: brightest pixel`).toBeGreaterThan(8);
}

// ------------------------------------------------------------------ DM call

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

async function bootAs(page: Page, path: string, suffix: string): Promise<void> {
  // `RESHARE_DEBUG=1` forwards both pages' consoles into the run. A media test
  // that fails does so silently — no exception, just no picture — so the
  // browser's own log is usually the only thing that says why.
  if (process.env.RESHARE_DEBUG) {
    page.on("console", (message) => {
      // eslint-disable-next-line no-console
      console.log(`[${suffix}:${message.type()}]`, message.text());
    });
    page.on("pageerror", (error) => {
      // eslint-disable-next-line no-console
      console.log(`[${suffix}:pageerror]`, error.message);
    });
  }
  await hookPeerConnections(page);
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

test("a DM call's SECOND screen share renders on the other side", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("reshare-dm-a", "reshare-dm-b");
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

    // The stage video for a screen share is the `object-contain` one; camera
    // tiles render `object-cover`.
    const share = watcher.page.locator(
      '[data-testid="call-stage"] video.object-contain',
    );
    const presenting = watcher.page.getByText(
      `${pair.callerName} is presenting`,
    );

    // ---- first share -------------------------------------------------
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(presenting).toBeVisible({ timeout: 20_000 });
    await settle(share, 20_000);

    const rtpBeforeFirst = await inboundVideo(watcher.page);
    const first = await sampleVideo(share, SAMPLE_MS);
    const rtpAfterFirst = await inboundVideo(watcher.page);
    // eslint-disable-next-line no-console
    console.log("[reshare] first share:", JSON.stringify(first));
    expectLive(first, "first share");
    expect(
      rtpAfterFirst.framesDecoded - rtpBeforeFirst.framesDecoded,
      "first share: framesDecoded",
    ).toBeGreaterThan(0);

    // ---- stop --------------------------------------------------------
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click();
    await expect(presenting).not.toBeVisible({ timeout: 20_000 });

    // ---- second share ------------------------------------------------
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(presenting).toBeVisible({ timeout: 20_000 });
    await settle(share, 20_000);

    const rtpBeforeSecond = await inboundVideo(watcher.page);
    const second = await sampleVideo(share, SAMPLE_MS);
    const rtpAfterSecond = await inboundVideo(watcher.page);
    // eslint-disable-next-line no-console
    console.log("[reshare] second share:", JSON.stringify(second));
    expectLive(second, "second share");
    expect(
      rtpAfterSecond.framesDecoded - rtpBeforeSecond.framesDecoded,
      "second share: framesDecoded",
    ).toBeGreaterThan(0);

    // A fresh `getDisplayMedia` capture is a fresh stream. If the watcher is
    // still bound to the first one, it is holding the corpse — which is the
    // bug, even in the unlikely event that something else kept it painting.
    expect(second.streamId, "second share is a new stream").not.toBe(
      first.streamId,
    );

    // Relative to the first share on the same element, so this says nothing
    // about how fast this machine is.
    expect(
      second.paintedFrames,
      "second share paints at a comparable rate to the first",
    ).toBeGreaterThan(first.paintedFrames / 4);
  } finally {
    await watcher.context.close();
  }
});

// -------------------------------------------------------- server voice channel

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
    body: JSON.stringify({ name: "Reshare" }),
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

test("a voice channel's SECOND screen share renders for the other member", async ({
  page,
  browser,
}) => {
  const pair = await seedVoiceServer("reshare-vc-a", "reshare-vc-b");
  const watcher = await secondClient(
    browser,
    `/app/servers/${pair.serverId}`,
    pair.guestSuffix,
  );

  try {
    await bootAs(page, `/app/servers/${pair.serverId}`, pair.hostSuffix);
    await joinVoice(page);
    await joinVoice(watcher.page);

    const presenting = watcher.page.getByText(
      `${pair.hostName} is presenting`,
    );
    // The watcher's only `object-contain` video is the share; voice tiles have
    // no camera on in this test.
    const share = watcher.page.locator("video.object-contain").first();

    // ---- first share -------------------------------------------------
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(presenting).toBeVisible({ timeout: 30_000 });
    await settle(share, 20_000);

    const first = await sampleVideo(share, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[reshare] voice first share:", JSON.stringify(first));
    expectLive(first, "voice first share");

    // ---- stop --------------------------------------------------------
    await page.getByRole("button", { name: "Stop sharing" }).first().click();
    await expect(presenting).not.toBeVisible({ timeout: 20_000 });

    // ---- second share ------------------------------------------------
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(presenting).toBeVisible({ timeout: 30_000 });
    await settle(share, 20_000);

    const rtpBefore = await inboundVideo(watcher.page);
    const second = await sampleVideo(share, SAMPLE_MS);
    const rtpAfter = await inboundVideo(watcher.page);
    // eslint-disable-next-line no-console
    console.log("[reshare] voice second share:", JSON.stringify(second));
    expectLive(second, "voice second share");
    expect(
      rtpAfter.framesDecoded - rtpBefore.framesDecoded,
      "voice second share: framesDecoded",
    ).toBeGreaterThan(0);
    expect(second.streamId, "voice second share is a new stream").not.toBe(
      first.streamId,
    );
  } finally {
    await watcher.context.close();
  }
});

// ------------------------------------------------------------ rapid reshare

/**
 * The same sequence with no pause between stopping and starting again.
 *
 * The fix hangs off the roster's `sharingScreen` flag going true -> false, so
 * it is worth knowing whether a presenter who restarts inside one roster tick
 * can skip that edge entirely — that is the shape a "the fix does not cover my
 * case" report would take. Nothing here waits for the watcher's UI to catch up
 * between the two clicks.
 */
test("a share restarted immediately, with no pause, still reaches the watcher", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("reshare-fast-a", "reshare-fast-b");
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

    const share = watcher.page.locator(
      '[data-testid="call-stage"] video.object-contain',
    );
    const presenting = watcher.page.getByText(
      `${pair.callerName} is presenting`,
    );

    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(presenting).toBeVisible({ timeout: 20_000 });
    await settle(share, 20_000);
    const first = await sampleVideo(share, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[reshare] fast first share:", JSON.stringify(first));
    expectLive(first, "fast first share");

    // Stop and restart back to back. Only the presenter's own button state is
    // waited on; the watcher is given no chance to observe the gap.
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Stop sharing your screen",
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });

    await expect(presenting).toBeVisible({ timeout: 20_000 });
    await settle(share, 20_000);
    const second = await sampleVideo(share, SAMPLE_MS);
    // eslint-disable-next-line no-console
    console.log("[reshare] fast second share:", JSON.stringify(second));
    expectLive(second, "fast second share");
    expect(second.streamId, "fast second share is a new stream").not.toBe(
      first.streamId,
    );
  } finally {
    await watcher.context.close();
  }
});
