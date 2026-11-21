// The scenes of docs/plans/RUST.md, B1. Each scene function launches ONE
// Electron instance in a fresh user-data directory, does what a person does,
// measures every process the shell owns, and closes everything it opened.
//
//   S1 idle on a light channel          S5 S4 while sharing a 1080p screen
//   S2 2,000 messages loaded, scrolled  S6 S4 while watching the other person's share
//   S3 back on the light channel        S7 watching a watch party
//   S4 two-person SFU call, mic on      S8 launch to first message painted
//
// S2 and S3 are one run (S3 is "after S2"). S4 to S7 last `cfg.callSeconds`
// (300, the plan's five minutes): memory is read at the end and CPU is the
// average over the window after a 30 s warm-up. Memory is also sampled every
// 30 s so a leak shows as `peakMemTotalMB` above the end value.
import {
  cpuBetween,
  freshUserDataDir,
  launchElectron,
  memoryOf,
  removeDir,
  sleep,
  snapshot,
} from "./electron.mjs";
import {
  clickSidebar,
  HEAVY_LAST_MARKER,
  LIGHT_MARKER,
  loadHistory,
  rendererStats,
  scrollSweep,
  switchTo,
  videoStats,
  waitForText,
} from "./page-actions.mjs";
import {
  installFakeDisplay,
  joinVoice,
  leaveVoice,
  micIsOn,
  startParticipant,
  startShare,
  stopShare,
} from "./call.mjs";

const lightUrl = (stack) =>
  `${stack.appUrl}/app/server/${stack.ids.serverId}/channel/${stack.ids.lightChannelId}?lang=en`;
const lightRoute = (stack) => lightUrl(stack).slice(stack.appUrl.length);

/** Launch, wait for the light channel's newest message, and return the handle plus startup timings. */
async function open(stack, { url = lightUrl(stack), marker = LIGHT_MARKER, userDataDir } = {}) {
  const dir = userDataDir ?? freshUserDataDir();
  const e = await launchElectron({ url, userDataDir: dir });
  let tContent;
  try {
    tContent = await waitForText(e.page, marker, 60_000);
  } catch (error) {
    // Never leave an instance running into the next scene.
    await e.close();
    if (!userDataDir) removeDir(dir);
    throw error;
  }
  const versions = await e.app.evaluate(({ screen, BrowserWindow }) => {
    const display = screen.getPrimaryDisplay();
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      display: { size: display.size, scaleFactor: display.scaleFactor },
      window: BrowserWindow.getAllWindows()[0]?.getBounds() ?? null,
    };
  });
  return {
    ...e,
    dir,
    versions,
    startup: { windowMs: e.tWindow - e.t0, contentMs: tContent - e.t0 },
    async dispose() {
      await e.close();
      if (!userDataDir) removeDir(dir);
    },
  };
}

/**
 * Two snapshots `seconds` apart: memory at the end, CPU across the window.
 * `snap` reads one snapshot of `app`; the native runner (native-bench.mjs)
 * passes its own reader so both stacks go through this same code.
 */
export async function measureWindow(app, seconds, snap = snapshot) {
  const a = await snap(app);
  await sleep(seconds * 1000);
  const b = await snap(app);
  return { memory: memoryOf(b), cpu: cpuBetween(a, b) };
}

/**
 * The hold the call scenes share: warm up, then sample memory every 30 s to
 * `callSeconds` and take CPU over the whole window after the warm-up.
 */
export async function holdAndMeasure(app, callSeconds, onSample = async () => {}, snap = snapshot) {
  const warm = Math.min(30, Math.floor(callSeconds / 4));
  await sleep(warm * 1000);
  const first = await snap(app);
  await onSample("start");
  let last = first;
  const peak = { totalMB: memoryOf(first).totalMB };
  const deadline = Date.now() + (callSeconds - warm) * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
    last = await snap(app);
    peak.totalMB = Math.max(peak.totalMB, memoryOf(last).totalMB);
  }
  await onSample("end");
  return { memory: memoryOf(last), cpu: cpuBetween(first, last), peakMemTotalMB: peak.totalMB };
}

// ------------------------------------------------------------------- scenes

export async function s1Idle(stack, cfg) {
  const o = await open(stack);
  try {
    await sleep(15_000);
    const m = await measureWindow(o.app, cfg.cpuWindowSeconds);
    return { S1: { ...m, extras: { renderer: await rendererStats(o.page) }, versions: o.versions } };
  } finally {
    await o.dispose();
  }
}

export async function s2s3History(stack, cfg) {
  const o = await open(stack);
  try {
    await sleep(5_000);
    const toHeavyMs = await switchTo(o.page, "off-topic", HEAVY_LAST_MARKER);
    const history = await loadHistory(o.page);
    if (!history.loaded) throw new Error("the oldest message never appeared: S2 would measure a partial history");
    const sweep = await scrollSweep(o.page);
    await sleep(3_000);
    const s2 = await measureWindow(o.app, cfg.cpuWindowSeconds);
    const s2Renderer = await rendererStats(o.page);

    const toLightMs = await switchTo(o.page, "general", LIGHT_MARKER);
    await sleep(3_000);
    const s3 = await measureWindow(o.app, cfg.cpuWindowSeconds);
    const s3Renderer = await rendererStats(o.page);
    return {
      S2: {
        ...s2,
        extras: { toHeavyMs, history, sweep, renderer: s2Renderer },
        versions: o.versions,
      },
      S3: { ...s3, extras: { toLightMs, renderer: s3Renderer }, versions: o.versions },
    };
  } finally {
    await o.dispose();
  }
}

async function callScene(stack, cfg, { id, share = false, watch = false }) {
  let bob = null;
  const o = await open(stack);
  try {
    bob = await startParticipant({ stack, share: watch, route: lightRoute(stack) });
    await joinVoice(o.page);
    const mic = await micIsOn(o.page);
    if (!mic) throw new Error("the microphone is not on in the call");
    const extras = { micOn: 1 };
    if (share) {
      await installFakeDisplay(o.page);
      await startShare(o.page);
    }
    if (watch) {
      await o.page.waitForFunction(
        () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused),
        null,
        { timeout: 60_000, polling: 250 },
      );
    }
    let v0 = null;
    let bobV0 = null;
    const result = await holdAndMeasure(o.app, cfg.callSeconds, async (phase) => {
      if (watch) {
        const v = await videoStats(o.page);
        if (phase === "start") v0 = v;
        else extras.video = frameDelta(v0, v);
      }
      if (share) {
        const v = await videoStats(bob.page);
        if (phase === "start") bobV0 = v;
        else extras.receivedByOtherPerson = { ...(v ?? {}), ...frameDelta(bobV0, v) };
        if (phase === "end") extras.captured = await o.page.evaluate(() => window.__benchShare ?? null);
      }
    });
    if (share) await stopShare(o.page);
    await leaveVoice(o.page);
    return { [id]: { ...result, extras, versions: o.versions } };
  } finally {
    await bob?.stop();
    await o.dispose();
  }
}

function frameDelta(a, b) {
  if (!a || !b) return {};
  const total = (b.totalFrames ?? 0) - (a.totalFrames ?? 0);
  const dropped = (b.droppedFrames ?? 0) - (a.droppedFrames ?? 0);
  const secs = Math.max(1, b.currentTime - a.currentTime);
  return {
    width: b.width,
    height: b.height,
    framesShown: total,
    framesDropped: dropped,
    fps: Math.round((total / secs) * 10) / 10,
  };
}

export const s4Call = (stack, cfg) => callScene(stack, cfg, { id: "S4" });
export const s5Share = (stack, cfg) => callScene(stack, cfg, { id: "S5", share: true });
export const s6Watch = (stack, cfg) => callScene(stack, cfg, { id: "S6", watch: true });

export async function s7Party(stack, cfg) {
  // The only scene with an encoder beside it, started for this run and stopped
  // (its session ended) afterwards. The wait for the API to see it happens
  // before the shell launches, so it is never inside a measurement.
  const source = await stack.startPartySource();
  let o = null;
  try {
    o = await open(stack);
    await clickSidebar(o.page, "watch-party");
    await o.page.waitForFunction(
      () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused && v.currentTime > 0),
      null,
      { timeout: 90_000, polling: 250 },
    );
    let v0 = null;
    const extras = {};
    const result = await holdAndMeasure(o.app, cfg.callSeconds, async (phase) => {
      const v = await videoStats(o.page);
      if (phase === "start") v0 = v;
      else extras.video = frameDelta(v0, v);
    });
    return { S7: { ...result, extras, versions: o.versions } };
  } finally {
    await o?.dispose();
    await source.stop();
  }
}

/** Cold launch in a fresh profile, then a warm launch in the same one. */
export async function s8Startup(stack, cfg) {
  const dir = freshUserDataDir();
  try {
    const cold = await open(stack, { userDataDir: dir });
    await sleep(3_000);
    const coldMem = memoryOf(await snapshot(cold.app));
    const versions = cold.versions;
    const coldStartup = cold.startup;
    await cold.dispose();
    await sleep(2_000);

    const warm = await open(stack, { userDataDir: dir });
    await sleep(3_000);
    const warmMem = memoryOf(await snapshot(warm.app));
    const warmStartup = warm.startup;
    await warm.dispose();
    void cfg;
    return {
      S8: {
        memory: coldMem,
        extras: {
          cold: coldStartup,
          warm: { ...warmStartup, memTotalMB: warmMem.totalMB },
        },
        versions,
      },
    };
  } finally {
    removeDir(dir);
  }
}

/** Run order inside one round. A group yields the scene ids it measures. */
export const SCENE_GROUPS = [
  { ids: ["S8"], run: s8Startup, needs: [] },
  { ids: ["S1"], run: s1Idle, needs: [] },
  { ids: ["S2", "S3"], run: s2s3History, needs: [] },
  { ids: ["S4"], run: s4Call, needs: ["livekit"] },
  { ids: ["S5"], run: s5Share, needs: ["livekit"] },
  { ids: ["S6"], run: s6Watch, needs: ["livekit"] },
  { ids: ["S7"], run: s7Party, needs: [] },
];

export const SCENE_NAMES = {
  S1: "idle on a light channel",
  S2: "2,000 messages loaded and scrolled",
  S3: "back on the light channel after S2",
  S4: "two-person SFU call, mic on",
  S5: "S4 while sharing a 1080p screen",
  S6: "S4 while watching the other person's share",
  S7: "watching a watch party",
  S8: "launch to first message painted",
};
