// The call scenes: a second participant, and the steps a person takes in a call.
//
// The second participant is a headless Chromium (Playwright's own build, its own
// temporary profile) signed in as `dev-local-token:bob` through the
// `pqp:dev-user-suffix` mechanism of the dev bypass, so it is a genuinely
// separate account with its own seat. It is NOT measured; only the Electron
// shell is.
import { chromium, sleep } from "./electron.mjs";
import { waitForText } from "./page-actions.mjs";

/**
 * `getDisplayMedia`, answered by Chromium's fake capture device at 1920x1080.
 * Why not the real thing: in Electron the request goes to the shell's own
 * desktopCapturer handler, which needs the macOS Screen Recording grant (a
 * system dialog nobody can click unattended) and would put whatever is on the
 * owner's screen into the call. The encode, the publish and the SFU are the
 * product's own; the OS capture step is the one thing this swaps out, and the
 * README says so next to every share number.
 */
export const FAKE_DISPLAY_INIT = () => {
  const md = navigator.mediaDevices;
  md.getDisplayMedia = async () => {
    const stream = await md.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    window.__benchShare = stream.getVideoTracks()[0].getSettings();
    return stream;
  };
};

export async function installFakeDisplay(page) {
  await page.evaluate(FAKE_DISPLAY_INIT);
}

/** Start the SFU call as a person does: double-click the voice channel, wait for "Voice connected". */
export async function joinVoice(page, name = "Lobby") {
  await page.getByRole("button", { name: new RegExp(name, "i") }).first().dblclick();
  await page.getByText("Voice connected").waitFor({ timeout: 45_000 });
}

export async function leaveVoice(page) {
  const leave = page.getByRole("button", { name: "Leave", exact: true }).first();
  const disconnect = page.getByRole("button", { name: "Disconnect from voice" }).first();
  const btn = (await leave.isVisible().catch(() => false)) ? leave : disconnect;
  await btn.click({ timeout: 10_000 }).catch(() => {});
  await page.getByText("Voice connected").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

/** The microphone is open: the button offers to mute it. */
export async function micIsOn(page) {
  return page.getByRole("button", { name: "Mute microphone" }).first().isVisible().catch(() => false);
}

/** Click Share your screen, accept the first-share notice if it comes, wait for the share to be live. */
export async function startShare(page) {
  await page.getByRole("button", { name: "Share your screen" }).first().click({ timeout: 20_000 });
  // The seed acknowledges the first-share notice; this is only a safety net.
  await page
    .getByText("Got it, start streaming")
    .click({ timeout: 1_500 })
    .catch(() => {});
  await page.getByRole("button", { name: "Stop sharing your screen" }).first().waitFor({ timeout: 30_000 });
}

export async function stopShare(page) {
  await page
    .getByRole("button", { name: "Stop sharing your screen" })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => {});
}

/**
 * Bob: a headless Chromium in the same call. `share` makes him present the
 * fake 1080p display; the Electron shell under test then watches it (S6).
 */
export async function startParticipant({ stack, share = false, route, initScripts = [] }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream=fps=30", "--use-fake-ui-for-media-stream"],
  });
  const ctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  await ctx.addInitScript(() => localStorage.setItem("pqp:dev-user-suffix", "bob"));
  await ctx.addInitScript(FAKE_DISPLAY_INIT);
  for (const script of initScripts) await ctx.addInitScript(script);
  const page = await ctx.newPage();
  try {
    await page.goto(`${stack.appUrl}${route}`);
    await waitForText(page, "Lobby", 60_000).catch(() => {});
    await joinVoice(page);
    if (share) await startShare(page);
  } catch (error) {
    // No handle is returned on a failed setup, so nobody else can close this.
    await browser.close().catch(() => {});
    throw error;
  }
  return {
    page,
    async stop() {
      try {
        if (share) await stopShare(page);
        await leaveVoice(page);
        await sleep(500);
      } catch {
        // closing anyway
      }
      await browser.close().catch(() => {});
    },
  };
}
