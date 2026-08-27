import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Two people, one call, one share with sound: what does the app ask the browser
 * for, and does the share's audio still reach the other person?
 *
 * THE REPORT. A 3-star call rating, 23 Aug 2026, verbatim: "Quando alguém
 * transmite, ele repete a Call de quem esta na chamada tbm. Aí fica com eco."
 * Somebody shares their screen and everybody hears themselves come back. The
 * cause was `systemAudio: "include"` in the capture options: it asks the picker
 * to offer the machine's whole output, and the machine's whole output contains
 * the call. Every voice in the room was tapped off the render endpoint and sent
 * straight back to the person speaking.
 *
 * WHAT THIS TEST CANNOT SEE, said plainly, because a test that quietly measures
 * the wrong layer is how this repo has already produced one confident wrong
 * answer. Two things are out of reach here:
 *
 * 1. The echo itself. It is produced by WASAPI loopback, which is Windows. This
 *    suite does not run on Windows and nothing here can hear it.
 * 2. A REAL screen capture. Measured on this machine, Chrome 151: headless
 *    Chromium on macOS answers `getDisplayMedia` with `NotSupportedError` for
 *    every surface and every option set, tab included. Add
 *    `--use-fake-device-for-media-stream` (which this suite needs for the
 *    microphone anyway) and the call succeeds, but what comes back is
 *    Chromium's synthetic capture: `deviceId: "screen:-3:0"`,
 *    `displaySurface: "monitor"`, one audio track labelled "Fake audio". It
 *    reports a monitor whatever the options say, so nothing below may be read
 *    as a claim about which surface a real picker would have offered.
 *
 * The real-surface behaviour was measured by hand instead, on Chrome 151 with a
 * headed browser and a real tab capture: under `systemAudio: "exclude"` a tab
 * capture still hands over a `Tab audio` track, `displaySurface: "browser"`,
 * with `echoCancellation` still false and `restrictOwnAudio` honoured. That is
 * the fact the default rests on, and `src/lib/screen-capture-audio.test.ts`
 * pins the request that produces it.
 *
 * WHAT THIS TEST DOES SEE, and it is the part worth having:
 *
 * - the options the shipped code really hands `getDisplayMedia`, recorded from
 *   the page rather than asserted against a unit-level stub;
 * - that a capture carrying audio still publishes it and it still arrives at
 *   the other person's inbound RTP, so the fix did not silence screen audio on
 *   the way through;
 * - that a capture which comes back as a monitor carrying sound makes the app
 *   say so, out loud, to the one person who cannot hear the echo they would be
 *   causing.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.use({
  launchOptions: {
    args: [
      // Also what makes `getDisplayMedia` answer at all here: without it a
      // headless macOS Chromium refuses every surface with NotSupportedError.
      // What it hands over is a synthetic monitor with a "Fake audio" track,
      // never a real one. See the header.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone", "camera"],
});

// Two app boots, a call handshake, two captures and a renegotiation apiece.
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
    callerSuffix,
    calleeSuffix,
    callerName: caller.displayName,
  };
}

/**
 * Record every options object the app hands to `getDisplayMedia`.
 *
 * `addInitScript`, so it is in place before the app's first line runs. This is
 * the point of the whole file: the assertion is made against what the shipped
 * code really asked the browser for, not against a stub standing in for it.
 */
async function recordDisplayMediaOptions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const native = media.getDisplayMedia.bind(media);
    const calls: unknown[] = [];
    (window as unknown as { __pqpDisplayMedia: unknown[] }).__pqpDisplayMedia =
      calls;
    media.getDisplayMedia = (options?: DisplayMediaStreamOptions) => {
      calls.push(JSON.parse(JSON.stringify(options ?? null)));
      return native(options);
    };
  });
}

interface CaptureRequest {
  audio?: unknown;
  systemAudio?: string;
  selfBrowserSurface?: string;
}

async function captureRequests(page: Page): Promise<CaptureRequest[]> {
  return page.evaluate(
    () =>
      ((window as unknown as { __pqpDisplayMedia?: CaptureRequest[] })
        .__pqpDisplayMedia ?? []) as CaptureRequest[],
  );
}

/** Collect the page's peer connections so inbound RTP can be read for real. */
async function hookPeerConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const seen: RTCPeerConnection[] = [];
    (window as unknown as { __pqpPCs: RTCPeerConnection[] }).__pqpPCs = seen;
    class Hooked extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        seen.push(this);
      }
    }
    window.RTCPeerConnection = Hooked as unknown as typeof RTCPeerConnection;
  });
}

/**
 * How many distinct inbound audio streams are arriving, and how many are
 * carrying bytes.
 *
 * Two is the number that matters. One is the presenter's microphone, which is
 * there from the moment the call connects. The second only appears when the
 * share's own audio is published and renegotiated, so it is the honest answer
 * to "did the tab's sound reach the other person" rather than a DOM state that
 * would read the same either way.
 */
async function inboundAudio(
  page: Page,
): Promise<{ tracks: number; withBytes: number }> {
  return page.evaluate(async () => {
    const pcs =
      (window as unknown as { __pqpPCs?: RTCPeerConnection[] }).__pqpPCs ?? [];
    let tracks = 0;
    let withBytes = 0;
    for (const pc of pcs) {
      if (pc.connectionState === "closed") {
        continue;
      }
      const report = await pc.getStats();
      report.forEach((entry) => {
        const stat = entry as RTCStats & {
          kind?: string;
          bytesReceived?: number;
        };
        if (stat.type !== "inbound-rtp" || stat.kind !== "audio") {
          return;
        }
        tracks += 1;
        if ((stat.bytesReceived ?? 0) > 0) {
          withBytes += 1;
        }
      });
    }
    return { tracks, withBytes };
  });
}

async function bootAs(page: Page, path: string, suffix: string): Promise<void> {
  await hookPeerConnections(page);
  await recordDisplayMediaOptions(page);
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

/**
 * Bring the call controls back.
 *
 * The stage fades its control bar after a few idle seconds, and the waits in
 * this test are several idle seconds by construction. A pointer move is what a
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
  ).toBeVisible({ timeout: 10_000 });
}

test("a share does not ask for the machine's audio, and says so when a whole screen carries it", async ({
  page,
  browser,
}) => {
  const pair = await seedConversation("sysaudio-a", "sysaudio-b");
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

    // The microphone alone, before any share exists. Anchors the count below,
    // so "two streams" cannot be satisfied by whatever the call already had.
    await expect
      .poll(async () => (await inboundAudio(watcher.page)).withBytes, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    const micOnly = await inboundAudio(watcher.page);

    // ---- default press: no system audio asked for ------------------------
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();

    await expect
      .poll(async () => (await captureRequests(page)).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const first = (await captureRequests(page))[0]!;

    // The bug, pinned against the real app. `include` is what put the call
    // back into the call.
    expect(first.systemAudio).toBe("exclude");
    // Audio is still REQUESTED. `systemAudio: "exclude"` is scoped to monitor
    // surfaces, so this is what keeps a tab share carrying the tab's sound;
    // dropping the audio constraint entirely would silence the good path too.
    expect(first.audio).not.toBe(false);
    expect(first.audio).toBeTruthy();
    // Sharing our own tab would put the call's picture back into the call.
    expect(first.selfBrowserSurface).toBe("exclude");

    await expect(
      watcher.page.getByText(`${pair.callerName} is presenting`),
    ).toBeVisible({ timeout: 30_000 });

    // ---- and the share's own sound still reaches the other person ---------
    // The fix must not cost the working case. A second inbound audio stream,
    // carrying bytes, is the share's audio and nothing else: the microphone
    // was already counted above. This is what would break if "do not ask for
    // system audio" had been implemented as "do not ask for audio".
    await expect
      .poll(async () => (await inboundAudio(watcher.page)).withBytes, {
        timeout: 45_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(micOnly.withBytes);

    // ---- and the presenter is told, while it is happening -----------------
    // The capture came back as a monitor with an audio track, which is the one
    // shape that can put the room's own voices back into the room. The
    // presenter's machine is playing what they shared, so they are the only
    // person who cannot hear it, and a sentence at the picker they have
    // already dismissed would be a sentence nobody reads.
    await expect(
      page.getByText(
        "You are sending this computer's sound. Everyone in the call hears themselves back.",
      ),
    ).toBeVisible({ timeout: 20_000 });

    // ---- opting in is what asks for it -----------------------------------
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Stop sharing your screen", exact: true })
      .click();
    await wakeControls(page);
    await page
      .getByRole("button", {
        name: "Send this computer's sound with the share",
        exact: true,
      })
      .click();
    await wakeControls(page);
    await page
      .getByRole("button", { name: "Share your screen", exact: true })
      .click();

    await expect
      .poll(async () => (await captureRequests(page)).length, {
        timeout: 20_000,
      })
      .toBe(2);
    const second = (await captureRequests(page))[1]!;
    expect(second.systemAudio).toBe("include");
  } finally {
    await watcher.context.close();
  }
});
