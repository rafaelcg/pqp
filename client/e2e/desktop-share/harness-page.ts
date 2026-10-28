/**
 * The page the desktop share smoke test loads INSIDE the shipped desktop app.
 *
 * WHY THIS EXISTS. Desktop 0.2.8 (Electron 44.9.1, Chromium 152) went out on
 * 2026-10-27 and Windows 11 users could not start a share: "Invalid capture
 * constraints" the moment they clicked. Every test was green, because every
 * test of the share path runs against a mock of Chromium: the shell's tests
 * fake `desktopCapturer` and the callback, the client's tests fake
 * `getDisplayMedia`. A Chromium that starts rejecting the constraints this app
 * really builds is invisible to all of them.
 *
 * So this page does not describe the constraints, it BUILDS them, with the same
 * functions in the same order as the app's share button
 * (`requestScreenShare` in `App.tsx`, then `startScreenShare` in
 * `hooks/use-voice.ts`), reading the real `window.pqpDesktop` the shell's
 * preload put here, and hands them to the real `getDisplayMedia`, which the
 * shell's real `setDisplayMediaRequestHandler` answers. Only the parts that
 * need a server are pinned by the scenario instead of fetched: the per-server
 * native share audio flag (both values are run), the share guard and the game
 * capture hint (both off, as for every server today), and the HLS ladder (an
 * ordinary call, not a watch party).
 *
 * Bundled by `build.mjs` with Vite, the client's own tooling, so a change to
 * any of these modules changes what this page asks for the next time it runs.
 * Driven by `electron/test/share-smoke/`.
 */
import {
  ensureOsCanExcludeCallAudio,
  liveScreenCaptureEnvironment,
  needsShareAudioPrompt,
  offersShellSystemAudio,
  screenCaptureOptions,
  steersAtBrowserTab,
  type ScreenCaptureIntent,
  type ScreenCaptureOptions,
} from "@/lib/screen-capture-audio";
import {
  armOrFallBackToChromiumAudio,
  attachNativeShareAudio,
  discardPrimedNativeShareAudio,
  releaseNativeShareAudioFor,
} from "@/lib/native-share-audio";
import {
  armLinuxShellShareAudio,
  ensureLinuxShellShareAudio,
} from "@/lib/linux-shell-share-audio";
import { getShareCursor } from "@/lib/screen-capture-cursor";
import {
  screenCaptureMaxFrameRate,
  shareLadderMaxFrameRate,
} from "@/lib/hls-capture-rate";

/** What one run asks for. Everything else is read off the shell. */
export interface ShareScenario {
  /** The per-server `native_share_audio` flag's answer for this share. */
  nativeShareAudio: boolean;
  /**
   * A deliberate break, for the test that proves this gate can go red: these
   * members are merged over the video constraints the app built, AFTER it
   * built them. Null or absent is the app's request untouched.
   */
  breakVideo?: Record<string, unknown> | null;
}

interface ErrorReport {
  name: string;
  message: string;
  constraint: string | null;
}

export interface ShareResult {
  scenario: ShareScenario;
  /** `screenCaptureOptions`' output, exactly as handed to `getDisplayMedia`. */
  options: ScreenCaptureOptions | null;
  /** The share audio decision the app would have made. */
  shareSystemAudio: boolean;
  askedForAudio: boolean;
  nativeAudio: boolean;
  /** The shell's own answers, as the page read them. */
  shell: {
    platform: string | null;
    capabilities: Record<string, unknown> | null;
    sharePickerOffersAudio: boolean | null;
  };
  /** Audio output endpoints Chromium can see. Zero means loopback cannot run. */
  audioOutputs: number;
  /** Set when `getDisplayMedia` rejected. */
  error: ErrorReport | null;
  video: {
    readyState: string;
    settings: MediaTrackSettings;
    width: number;
    height: number;
    framesBefore: number;
    framesAfter: number;
    endedAfterStop: boolean;
  } | null;
  audio: { readyState: string; label: string; settings: MediaTrackSettings }[];
  nativeAttach: { attached: boolean; reason: string | null } | null;
  /** Milliseconds from the call to its settlement. */
  elapsedMs: number;
}

declare global {
  interface Window {
    pqpShareSmoke: {
      ready: boolean;
      start(scenario: ShareScenario): void;
      /** `pending` while the share is still waiting, on the picker or the capture. */
      result(): ShareResult | { pending: true; elapsedMs: number };
    };
  }
}

function report(err: unknown): ErrorReport {
  const e = err as { name?: unknown; message?: unknown; constraint?: unknown };
  return {
    name: typeof e?.name === "string" ? e.name : typeof err,
    message: typeof e?.message === "string" ? e.message : String(err),
    constraint: typeof e?.constraint === "string" ? e.constraint : null,
  };
}

function snapshotCapabilities(): Record<string, unknown> | null {
  const caps = (window as unknown as { pqpDesktop?: { capabilities?: object } })
    .pqpDesktop?.capabilities;
  return caps ? { ...caps } : null;
}

/**
 * Frames the capture has delivered. A track can be `live` with nothing behind
 * it (a capturer that started and then never produced), which is why this is
 * counted at all.
 *
 * Two counters, the larger wins: the track's own `stats.totalFrames`, which
 * counts what the capturer produced whether or not anything draws it, and a
 * `<video>` in view counting presented frames the way a person would see them.
 */
function frameCounter(stream: MediaStream): {
  video: HTMLVideoElement;
  count: () => number;
} {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText =
    "position:fixed;left:8px;top:8px;width:160px;height:90px;z-index:10;background:#000";
  video.srcObject = stream;
  document.body.append(video);
  let presented = 0;
  const tick = () => {
    presented += 1;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
  void video.play().catch(() => {});
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
    stats?: { totalFrames?: number };
  };
  const produced = () => {
    try {
      return track.stats?.totalFrames ?? 0;
    } catch {
      return 0;
    }
  };
  return { video, count: () => Math.max(presented, produced()) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runShare(scenario: ShareScenario): Promise<ShareResult> {
  const desktop = (window as unknown as {
    pqpDesktop?: { platform?: string; sharePickerOffersAudio?: boolean };
  }).pqpDesktop;
  let audioOutputs = 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioOutputs = devices.filter((d) => d.kind === "audiooutput").length;
  } catch {
    audioOutputs = 0;
  }

  // ---- requestScreenShare (App.tsx), with the server's answers pinned.
  await ensureOsCanExcludeCallAudio();
  await ensureLinuxShellShareAudio();
  const maxFrameRate = screenCaptureMaxFrameRate({
    preference: "auto",
    hlsLadderMax: shareLadderMaxFrameRate({
      feedsHls: false,
      hlsEnabled: null,
      ladder: null,
    }),
  });
  const shareIntent: ScreenCaptureIntent = {
    maxFrameRate,
    nativeShareAudio: scenario.nativeShareAudio,
    shareHighMotionGuard: false,
    shareGameCaptureHint: false,
  };
  const promptEnv = liveScreenCaptureEnvironment(shareIntent);
  const tabSteer = steersAtBrowserTab(promptEnv, shareIntent);
  // A shell whose picker cannot ask puts the app's own "share the sound?"
  // dialog up first; this run answers yes, the answer with something to break.
  const shareSystemAudio = needsShareAudioPrompt(promptEnv) && !tabSteer
    ? true
    : tabSteer
      ? false
      : promptEnv.sharePickerOffersAudio && offersShellSystemAudio(promptEnv);

  // ---- startScreenShare (hooks/use-voice.ts), up to and including the call.
  await Promise.all([ensureOsCanExcludeCallAudio(), ensureLinuxShellShareAudio()]);
  const hideCursor = getShareCursor() === "hide";
  const captureIntent = { ...shareIntent, hideCursor };
  let captureEnv = liveScreenCaptureEnvironment(shareIntent);
  const armed = await armOrFallBackToChromiumAudio(
    shareSystemAudio,
    captureEnv,
    captureIntent,
  );
  captureEnv = armed.env;
  const options = screenCaptureOptions(shareSystemAudio, captureEnv, captureIntent);
  const askedForAudio = options.audio !== false;
  if (captureEnv.shellLinuxShareAudio && askedForAudio) {
    await armLinuxShellShareAudio();
  }
  if (scenario.breakVideo) {
    options.video = {
      ...(typeof options.video === "object" ? options.video : {}),
      ...scenario.breakVideo,
    } as typeof options.video;
  }

  const base: Omit<ShareResult, "error" | "video" | "audio" | "nativeAttach" | "elapsedMs"> = {
    scenario,
    options: JSON.parse(JSON.stringify(options)),
    shareSystemAudio,
    askedForAudio,
    nativeAudio: armed.nativeAudio,
    shell: {
      platform: desktop?.platform ?? null,
      capabilities: snapshotCapabilities(),
      sharePickerOffersAudio:
        typeof desktop?.sharePickerOffersAudio === "boolean"
          ? desktop.sharePickerOffersAudio
          : null,
    },
    audioOutputs,
  };

  const started = performance.now();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    discardPrimedNativeShareAudio();
    return {
      ...base,
      error: report(err),
      video: null,
      audio: [],
      nativeAttach: null,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
  const elapsedMs = Math.round(performance.now() - started);

  let nativeAttach: ShareResult["nativeAttach"] = null;
  if (armed.nativeAudio) {
    const attach = await attachNativeShareAudio(stream);
    nativeAttach = { attached: attach.attached, reason: attach.reason };
  }

  const track = stream.getVideoTracks()[0];
  let video: ShareResult["video"] = null;
  if (track) {
    const counter = frameCounter(stream);
    // Give the first frame a moment, then count for a second: "frames
    // advance" means the second number is larger than the first.
    const deadline = performance.now() + 5000;
    while (counter.count() === 0 && performance.now() < deadline) {
      await sleep(100);
    }
    const framesBefore = counter.count();
    await sleep(1200);
    const framesAfter = counter.count();
    const settings = track.getSettings();
    const readyState = track.readyState;
    const width = counter.video.videoWidth || settings.width || 0;
    const height = counter.video.videoHeight || settings.height || 0;
    const audio = stream.getAudioTracks().map((t) => ({
      readyState: t.readyState,
      label: t.label,
      settings: t.getSettings(),
    }));
    const tracks = stream.getTracks();
    for (const t of tracks) {
      t.stop();
    }
    releaseNativeShareAudioFor(tracks);
    counter.video.srcObject = null;
    counter.video.remove();
    video = {
      readyState,
      settings,
      width,
      height,
      framesBefore,
      framesAfter,
      endedAfterStop: tracks.every((t) => t.readyState === "ended"),
    };
    return { ...base, error: null, video, audio, nativeAttach, elapsedMs };
  }
  for (const t of stream.getTracks()) {
    t.stop();
  }
  return { ...base, error: null, video: null, audio: [], nativeAttach, elapsedMs };
}

let settled: ShareResult | null = null;
let startedAt = 0;

window.pqpShareSmoke = {
  ready: true,
  start(scenario) {
    settled = null;
    startedAt = performance.now();
    void runShare(scenario).then(
      (result) => {
        settled = result;
        return result;
      },
      (err) => {
        // Anything thrown outside the capture is the harness, not the share,
        // and it is reported as such rather than swallowed.
        settled = {
          scenario,
          options: null,
          shareSystemAudio: false,
          askedForAudio: false,
          nativeAudio: false,
          shell: { platform: null, capabilities: null, sharePickerOffersAudio: null },
          audioOutputs: 0,
          error: { ...report(err), name: `harness:${report(err).name}` },
          video: null,
          audio: [],
          nativeAttach: null,
          elapsedMs: 0,
        };
        return settled;
      },
    );
  },
  result() {
    if (settled) {
      return settled;
    }
    return { pending: true, elapsedMs: Math.round(performance.now() - startedAt) };
  },
};

// Something on screen that changes every frame. A capturer is free to deliver
// nothing while the screen is still (macOS's does exactly that), so without
// motion "frames advance" would be a fact about the desktop, not the share.
const spinner = document.getElementById("motion");
let angle = 0;
function animate() {
  angle = (angle + 7) % 360;
  if (spinner) {
    spinner.style.transform = `rotate(${angle}deg)`;
    spinner.textContent = String(Math.round(performance.now()));
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
