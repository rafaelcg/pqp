/**
 * A screen share's sound from the Windows desktop app, captured per process
 * by the shell rather than by Chromium.
 *
 * WHY. Chromium's loopback taps the speakers mixer, which contains the call,
 * and only strips this app out of it on Windows 11 (`screen-capture-audio.ts`).
 * So on Windows 10 every desktop share went out silent: sending the mixer
 * would have been the 23 Aug 2026 echo. The shell can instead ask Windows for
 * one process tree (WASAPI process loopback, `electron/lib/win-share-audio.js`):
 * the shared window's app, or everything but pqp for a screen. The call is
 * outside that capture by construction, on Windows 10 as on 11.
 *
 * THE HANDSHAKE, page side:
 *
 * 1. `ensureNativeShareAudio(serverId)` before the picker: the runtime flag
 *    (`desktop_share_audio_native`, per server) AND the shell's self-test.
 *    Flag off means the shell is never even asked, so turning it off is
 *    exactly today's behaviour. The answer rides on the share's intent
 *    (`nativeShareAudio`) into `liveScreenCaptureEnvironment`.
 * 2. `armNativeShareAudio()`, then `getDisplayMedia` with `audio: false`
 *    (`screenCaptureOptions` does that when `shellNativeShareAudio` is set).
 *    The shell's picker shows its sound box because of the arm. The arm also
 *    BUILDS THE AUDIO GRAPH (context, worklet, node, destination) and resumes
 *    it, here, in the share click's own gesture and before anything is
 *    committed to: a graph that cannot be made, or will not leave `suspended`,
 *    is found while the old path (Chromium's loopback on Windows 11) is still
 *    available, not after a picker whose options asked Chromium for no audio.
 * 3. `attachNativeShareAudio(stream)` after it resolves: the shell hands over
 *    a port of 10 ms PCM chunks, the graph from step 2 plays it into a
 *    MediaStreamAudioDestinationNode, and that track joins the share's
 *    stream exactly where Chromium's loopback track would have been. From
 *    there nothing downstream knows the difference: LiveKit publishes it as
 *    `ScreenShareAudio`, mesh sends it on the share's audio sender, and the
 *    watch party mix, egress and moderation read it like any other.
 *
 * NO SILENT SHARE. A share whose box was ticked either carries a live native
 * track or says, in the share's own notice, that it did not (and the next share
 * takes the old path). The one outcome that must not exist is video only with
 * nothing said; every stage of this file records what it did
 * (`native-share-audio-diagnostics.ts`) so the ones that still happen can be
 * read off a console paste.
 */
import workletUrl from "./native-share-audio-worklet.js?url";
import { fetchShareConfig } from "./api";
import { getDesktop, type NativeShareAudioClaim, type PqpDesktop } from "./desktop";
import {
  nativeShareAudioDiagnostics,
  noteNativeShareAudio,
  noteNativeShareAudioFailure,
  resetNativeShareAudioDiagnosticsForTests,
  startNativeShareAudioAttempt,
} from "./native-share-audio-diagnostics";
import {
  wantsNativeShareAudio,
  type ScreenCaptureEnvironment,
  type ScreenCaptureIntent,
} from "./screen-capture-audio";

type Bridge = Required<
  Pick<
    PqpDesktop,
    | "nativeShareAudioStatus"
    | "nativeShareAudioArm"
    | "nativeShareAudioClaim"
    | "nativeShareAudioStop"
  >
>;

const SAMPLE_RATE = 48000;
const PROCESSOR = "pqp-native-share-audio";
const PORT_MESSAGE = "pqp:native-share-audio-port";
/** After this a flag answer is refreshed, in the background. */
const CONFIG_TTL_MS = 60_000;
/**
 * A background lookup of the flag (a prefetch, or the refresh behind a stale
 * answer) gives the API this long before it is read as "off for now".
 */
const CONFIG_TIMEOUT_MS = 1500;
/**
 * What the share-start path itself will wait for an answer that is not
 * already known. The flag is prefetched when the person enters the call, so
 * this is only ever spent when they click share inside the first moments of
 * it, and it is short on purpose: a flag nobody has answered yet is OFF for
 * this share, which is exactly the picker they had before this existed, and
 * the answer lands in the cache for the next one. The ordinary picker is
 * never held back by a slow API.
 */
const ENSURE_BUDGET_MS = 400;
/**
 * `AudioContext.resume()` can stay pending for ever when the page has no
 * user activation yet (autoplay policy), and whatever awaited it would hold
 * the share with it. A context still not running after this grace is a failed
 * graph.
 */
const RESUME_TIMEOUT_MS = 1500;
/** Loading the worklet module is a fetch of a few KB from our own origin. */
const WORKLET_TIMEOUT_MS = 3000;
/**
 * The first status call starts the shell's audio process and self-tests it,
 * which takes a few hundred milliseconds. This is the ceiling, paid once.
 */
const STATUS_TIMEOUT_MS = 4000;
const PORT_TIMEOUT_MS = 3000;
/** Stopped tracks raise no event, so the session looks at them. */
const WATCH_INTERVAL_MS = 1000;
/**
 * A context that leaves `running` mid-share (the output device changed, the
 * page was throttled) is asked to resume; after this many looks in a row
 * without it the share is treated as having lost its sound.
 */
const SUSPENDED_TICKS_LIMIT = 3;
/**
 * A graph built for a share whose picker never resolved (cancelled, or left
 * open) is closed after this, the same life as the shell's arm.
 */
const PRIMED_TTL_MS = 120_000;

/** The bridge, when this shell has one. Null in a browser and in older shells. */
export function nativeShareAudioBridge(desktop: PqpDesktop | undefined = getDesktop()): Bridge | null {
  if (!desktop || desktop.capabilities?.nativeShareAudio !== true) {
    return null;
  }
  if (
    typeof desktop.nativeShareAudioStatus !== "function" ||
    typeof desktop.nativeShareAudioArm !== "function" ||
    typeof desktop.nativeShareAudioClaim !== "function" ||
    typeof desktop.nativeShareAudioStop !== "function"
  ) {
    return null;
  }
  return desktop as Bridge;
}

const flagCache = new Map<string, { at: number; value: boolean }>();
const flagRefreshing = new Set<string>();
/** Flag plus self-test, per server, while one is being worked out. */
const readinessInFlight = new Map<string, Promise<boolean>>();
/**
 * The shell's self-test result for this page's lifetime. The shell caches it
 * too; this saves the round trip, and the wait, on every share after the
 * first. A machine that failed it does not start passing without a restart.
 */
let statusAnswer: Promise<boolean> | null = null;
/**
 * A capture that was offered and then failed on this machine (the arm, the
 * claim, the port, the audio graph, or the capture ending under the share).
 * The next share takes the path it took before this existed, which on Windows
 * 11 is Chromium's own loopback, rather than failing the same way again.
 */
let failedThisSession = false;

export function resetNativeShareAudioForTests(): void {
  flagCache.clear();
  flagRefreshing.clear();
  readinessInFlight.clear();
  statusAnswer = null;
  failedThisSession = false;
  discardPrimedNativeShareAudio();
  resetNativeShareAudioDiagnosticsForTests();
  if (active) {
    teardown(active, false);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function askFlag(key: string, serverId: string | null): Promise<boolean | null> {
  const value = await withTimeout(
    fetchShareConfig(serverId).then((config) => config.desktopShareAudioNative === true),
    CONFIG_TIMEOUT_MS,
    null,
  );
  if (value !== null) {
    flagCache.set(key, { at: Date.now(), value });
  }
  return value;
}

/**
 * The flag for this server. A cached answer is used at once even when old,
 * and refreshed behind it, so only the first share for a server ever waits
 * on the API, and never longer than `CONFIG_TIMEOUT_MS`.
 */
async function flagFor(serverId: string | null): Promise<boolean> {
  const key = serverId ?? "";
  const cached = flagCache.get(key);
  if (cached) {
    if (Date.now() - cached.at >= CONFIG_TTL_MS && !flagRefreshing.has(key)) {
      flagRefreshing.add(key);
      void askFlag(key, serverId).finally(() => flagRefreshing.delete(key));
    }
    return cached.value;
  }
  // Unanswered is off for this share and asked again for the next one.
  return (await askFlag(key, serverId)) === true;
}

function shellCanCapture(bridge: Bridge): Promise<boolean> {
  if (!statusAnswer) {
    statusAnswer = withTimeout(bridge.nativeShareAudioStatus(), STATUS_TIMEOUT_MS, null).then(
      (status) => {
        if (!status) {
          // No answer is not a verdict: ask again next share.
          statusAnswer = null;
          noteNativeShareAudio({ shell: "no-answer" });
          return false;
        }
        if (!status.available) {
          // The one line that answers "why no sound on this PC" from a console.
          console.warn(
            "[share-audio] native capture unavailable:",
            `${status.reason ?? "?"} build ${status.build} hr ${status.hr ?? "n/a"}`,
          );
          noteNativeShareAudio({ shell: `unavailable:${status.reason ?? "?"}` });
        } else {
          noteNativeShareAudio({ shell: "ok" });
        }
        return status.available === true;
      },
    );
  }
  return statusAnswer;
}

/**
 * The flag, then the shell's self-test, for one server. One lookup per server
 * at a time: a prefetch and a share that start together share one request.
 * Never rejects.
 */
function readinessFor(bridge: Bridge, serverId: string | null): Promise<boolean> {
  const key = serverId ?? "";
  let pending = readinessInFlight.get(key);
  if (!pending) {
    pending = flagFor(serverId)
      .then((on) => {
        noteNativeShareAudio({ flag: on });
        return on ? shellCanCapture(bridge) : false;
      })
      .catch(() => false)
      .finally(() => {
        readinessInFlight.delete(key);
      });
    readinessInFlight.set(key, pending);
  }
  return pending;
}

/**
 * Warm the answer for `ensureNativeShareAudio` off the share-start path: call
 * it when the person enters a call or a watch party for `serverId` (null for
 * a DM call). It fetches the per-server flag and, only when the flag is on,
 * runs the shell's self-test, so by the time they click "share screen" both
 * are cached and the picker opens at once. Fire and forget; a browser, an
 * older shell and a session that already failed are all a no-op, so the web
 * client never makes the request.
 */
export function prefetchNativeShareAudio(serverId?: string | null): void {
  const bridge = nativeShareAudioBridge();
  if (!bridge || failedThisSession) {
    return;
  }
  void readinessFor(bridge, serverId ?? null);
}

/**
 * Decide, before the picker opens, whether THIS share's sound comes from the
 * shell. `serverId` is the server the call is in (null for a DM call), so a
 * per-server override can turn it on for one community first. The answer is
 * returned, never stored: the caller carries it on the share's intent
 * (`ScreenCaptureIntent.nativeShareAudio`), so two shares being set up for
 * two servers cannot read each other's flag.
 *
 * NEVER SLOWS THE ORDINARY PICKER. A server whose flag is known to be off
 * answers at once, from the cache, however old it is (the refresh runs
 * behind it). A server nobody has asked about yet gets `ENSURE_BUDGET_MS`
 * and no more: past that the share takes the old path and the answer, when
 * it comes, is there for the next one.
 */
export async function ensureNativeShareAudio(serverId?: string | null): Promise<boolean> {
  const bridge = nativeShareAudioBridge();
  if (!bridge || failedThisSession) {
    return false;
  }
  const id = serverId ?? null;
  const cached = flagCache.get(id ?? "");
  if (cached && !cached.value) {
    // Off, and known: no waiting of any kind. Refresh if it is stale.
    noteNativeShareAudio({ flag: false });
    void flagFor(id);
    return false;
  }
  return withTimeout(readinessFor(bridge, id), ENSURE_BUDGET_MS, false);
}

/**
 * Arm the shell for this share, or fall back to the old path for it. One
 * place for both share paths (the call's share button and the watch party's
 * setup picker), so neither can forget the half that matters: an arm the
 * shell refused must rebuild the capture options WITHOUT native audio,
 * because options built for it ask Chromium for no audio at all, and on
 * Windows 11 that is sound the share used to have.
 *
 * `nativeAudio` says whether the caller attaches the shell's capture after
 * `getDisplayMedia`; `env` is the environment its options are built from.
 * When it is true the caller owes one of two things: `attachNativeShareAudio`
 * once the picker resolves, or `discardPrimedNativeShareAudio` if it does not.
 */
export async function armOrFallBackToChromiumAudio(
  shareSystemAudio: boolean,
  env: ScreenCaptureEnvironment,
  intent: ScreenCaptureIntent = {},
): Promise<{ nativeAudio: boolean; env: ScreenCaptureEnvironment }> {
  if (!wantsNativeShareAudio(shareSystemAudio, env, intent)) {
    return { nativeAudio: false, env };
  }
  if (await armNativeShareAudio()) {
    return { nativeAudio: true, env };
  }
  return { nativeAudio: false, env: { ...env, shellNativeShareAudio: false } };
}

// ---------------------------------------------------------------- the graph

interface Graph {
  context: AudioContext;
  node: AudioWorkletNode;
  track: MediaStreamTrack;
}

type GraphResult = { graph: Graph; failure: null } | { graph: null; failure: string };

function disposeGraph(graph: Graph): void {
  try {
    graph.node.port.postMessage({ type: "close" });
    graph.node.disconnect();
  } catch {
    // The graph is already gone with its context.
  }
  try {
    graph.track.stop();
  } catch {
    // Already stopped.
  }
  void graph.context.close().catch(() => {});
}

/**
 * Context, worklet, node, destination: everything but the PCM port. Null (with
 * the reason) when WebAudio refuses any step or the context will not run.
 * Bounded at every wait, and closes what it opened on every failure.
 */
async function buildGraph(): Promise<GraphResult> {
  const failed = (failure: string, context?: AudioContext): GraphResult => {
    if (context) {
      void context.close().catch(() => {});
    }
    return { graph: null, failure };
  };
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  } catch {
    return failed("no-audio-context");
  }
  noteNativeShareAudio({ contextState: context.state, sampleRate: context.sampleRate });
  // The shell sends 48 kHz and nothing here resamples. A context that could
  // not honour the rate would play the film at the wrong speed.
  if (context.sampleRate !== SAMPLE_RATE) {
    return failed(`sample-rate-${context.sampleRate}`, context);
  }
  try {
    const loaded = await withTimeout(
      context.audioWorklet.addModule(workletUrl).then(() => true),
      WORKLET_TIMEOUT_MS,
      false,
    );
    if (!loaded) {
      return failed("worklet-not-loaded", context);
    }
    const node = new AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    // Not connected to `context.destination`: the presenter already hears the
    // real thing from the real app, and a second copy through us would be an
    // echo on their own speakers. The destination node pulls on its own.
    const destination = context.createMediaStreamDestination();
    node.connect(destination);
    if (context.state !== "running") {
      // In the share click's own gesture, which is what the autoplay policy
      // asks for. Bounded, and a rejection is not an answer either: what
      // decides is the state read after it.
      await withTimeout(context.resume(), RESUME_TIMEOUT_MS, undefined);
    }
    noteNativeShareAudio({ contextState: context.state });
    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      return failed("no-track", context);
    }
    // A suspended context renders nothing (resume() rejected, hung, or
    // resolved into a state that is still not running): a track from it would
    // be a silent share that reports itself as attached.
    if (context.state !== "running") {
      console.warn(`[share-audio] native audio context is ${context.state} after resume; not using it`);
      return failed(`suspended:${context.state}`, context);
    }
    return { graph: { context, node, track }, failure: null };
  } catch (err) {
    console.warn("[share-audio] audio graph failed", err);
    return failed(`worklet:${err instanceof Error ? err.name : "error"}`, context);
  }
}

/** The graph built at arm time, waiting for its share. One at a time. */
let primed: { graph: Graph; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Close the graph an arm built for a share that did not happen: the picker was
 * cancelled, or the share failed before its capture could be attached. Safe to
 * call when nothing is primed.
 */
export function discardPrimedNativeShareAudio(): void {
  if (!primed) {
    return;
  }
  const held = primed;
  primed = null;
  clearTimeout(held.timer);
  disposeGraph(held.graph);
}

/**
 * Offer the sound box on the next picker. Call right before `getDisplayMedia`,
 * from the share click. False means the caller must NOT take the native path
 * for this share (its options asked Chromium for no audio): rebuild them
 * without it.
 *
 * The graph is built FIRST, so a machine that cannot play the shell's PCM is
 * found here, where falling back costs nothing, and the shell is only armed
 * for a share that will be able to carry its sound.
 */
export async function armNativeShareAudio(): Promise<boolean> {
  const bridge = nativeShareAudioBridge();
  if (!bridge) {
    return false;
  }
  startNativeShareAudioAttempt();
  discardPrimedNativeShareAudio();
  const built = await buildGraph();
  if (!built.graph) {
    noteNativeShareAudio({ graph: `fail:${built.failure}`, armed: false });
    noteNativeShareAudioFailure("graph", built.failure);
    console.warn("[share-audio] native share sound not used: audio graph failed before the picker:", built.failure);
    // A context that would not leave `suspended` may run on the next click
    // (a gesture, a focused window); a graph that cannot be made at all will
    // not start passing without a restart.
    if (!built.failure.startsWith("suspended")) {
      failedThisSession = true;
    }
    return false;
  }
  noteNativeShareAudio({ graph: "ok" });
  let armed = false;
  try {
    armed = (await bridge.nativeShareAudioArm()) === true;
  } catch {
    armed = false;
  }
  noteNativeShareAudio({ armed });
  if (!armed) {
    disposeGraph(built.graph);
    noteNativeShareAudioFailure("arm", "the shell refused to arm");
    failedThisSession = true;
    return false;
  }
  primed = {
    graph: built.graph,
    timer: setTimeout(discardPrimedNativeShareAudio, PRIMED_TTL_MS),
  };
  return true;
}

// ------------------------------------------------------------ the session

interface ActiveSession {
  sessionId: string;
  track: MediaStreamTrack;
  context: AudioContext;
  node: AudioWorkletNode;
  timer: ReturnType<typeof setInterval>;
  /** Unsubscribes from the shell's "capture ended on its own" event. */
  offEnded?: () => void;
  onEnded?: (info: { reason: string }) => void;
}

let active: ActiveSession | null = null;

function teardown(session: ActiveSession, stopShell: boolean): void {
  if (active === session) {
    active = null;
  }
  clearInterval(session.timer);
  try {
    session.offEnded?.();
  } catch {
    // The listener is already gone.
  }
  try {
    session.track.stop();
  } catch {
    // Already stopped.
  }
  try {
    session.node.port.postMessage({ type: "close" });
    session.node.disconnect();
  } catch {
    // The graph is already gone with its context.
  }
  void session.context.close().catch(() => {});
  if (stopShell) {
    void nativeShareAudioBridge()?.nativeShareAudioStop(session.sessionId).catch(() => {});
  }
}

/**
 * The capture under a live share is gone (it ended on its own, or its audio
 * graph stopped running): stop the track, remember it so the next share takes
 * the old path, and tell the share's owner so the presenter is told.
 */
function captureLost(session: ActiveSession, reason: string, stopShell: boolean): void {
  if (active !== session) {
    return;
  }
  console.warn(`[share-audio] native capture lost under a live share: ${reason}`);
  noteNativeShareAudio({ endedReason: reason });
  noteNativeShareAudioFailure("ended", reason);
  failedThisSession = true;
  const { onEnded } = session;
  teardown(session, stopShell);
  try {
    onEnded?.({ reason });
  } catch {
    // The owner's handler is not ours to fail on.
  }
}

/**
 * The share these tracks belonged to is over. Only the session whose track is
 * among them is stopped, so the end of an old share never silences a new one.
 */
export function releaseNativeShareAudioFor(tracks: readonly MediaStreamTrack[]): void {
  if (active && tracks.includes(active.track)) {
    teardown(active, true);
  }
}

function subscribeToCaptureEnded(
  bridge: Bridge,
  onEnded: (sessionId: string, reason: string) => void,
): (() => void) | undefined {
  const desktop = bridge as PqpDesktop;
  if (typeof desktop.onNativeShareAudioEnded !== "function") {
    // A shell from before this event: the watch on the video track still
    // ends the session with the share.
    return undefined;
  }
  try {
    return desktop.onNativeShareAudioEnded((event) => onEnded(event.sessionId, event.reason));
  } catch {
    return undefined;
  }
}

/**
 * Ports posted by the preload, collected from BEFORE the claim is sent: the
 * preload posts the port before the claim resolves, and a listener added
 * after could miss it.
 */
function collectPorts() {
  const ports = new Map<string, MessagePort>();
  const waiters = new Map<string, (port: MessagePort) => void>();
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; sessionId?: unknown } | null;
    const port = event.ports?.[0];
    if (!port || data?.type !== PORT_MESSAGE || typeof data.sessionId !== "string") {
      return;
    }
    const waiter = waiters.get(data.sessionId);
    if (waiter) {
      waiters.delete(data.sessionId);
      waiter(port);
    } else {
      ports.set(data.sessionId, port);
    }
  };
  window.addEventListener("message", onMessage);
  return {
    take(sessionId: string): Promise<MessagePort | null> {
      const ready = ports.get(sessionId);
      if (ready) {
        ports.delete(sessionId);
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(sessionId);
          resolve(null);
        }, PORT_TIMEOUT_MS);
        waiters.set(sessionId, (port) => {
          clearTimeout(timer);
          resolve(port);
        });
      });
    },
    dispose() {
      window.removeEventListener("message", onMessage);
      for (const port of ports.values()) {
        port.close();
      }
      ports.clear();
    },
  };
}

/**
 * What the worklet says about the PCM it is playing: once when the first chunk
 * arrives (the native track is delivering) and about once a second after.
 */
function listenToWorklet(node: AudioWorkletNode, context: AudioContext): void {
  let firstLogged = false;
  node.port.onmessage = (event: MessageEvent) => {
    const message = event.data as
      | { type?: string; chunks?: number; frames?: number; peak?: number; underflows?: number }
      | null;
    if (!message) {
      return;
    }
    if (message.type === "first" && !firstLogged) {
      firstLogged = true;
      noteNativeShareAudio({ chunks: Math.max(1, nativeShareAudioDiagnostics().chunks) });
      // eslint-disable-next-line no-console
      console.info(`[share-audio] native track is delivering samples (context ${context.state})`);
    } else if (message.type === "stats") {
      noteNativeShareAudio({
        chunks: message.chunks ?? 0,
        frames: message.frames ?? 0,
        peak: message.peak ?? 0,
        underflows: message.underflows ?? 0,
      });
    }
  };
}

export interface NativeShareAudioAttach {
  attached: boolean;
  /** Why not, for the log. `none` is the ordinary "box not ticked". */
  reason: string | null;
  target: NativeShareAudioClaim["target"] | null;
}

export interface NativeShareAudioAttachOptions {
  /**
   * The capture under the share ended later on its own (the stream failed, the
   * device went away, the audio process died, the graph stopped running). The
   * track has been stopped; the owner says so to the presenter.
   */
  onEnded?: (info: { reason: string }) => void;
}

/**
 * After `getDisplayMedia` resolved: put the shell's capture on `stream` as
 * its audio track, if the person ticked the box and the capture started.
 *
 * `attached: false` with a reason other than `none` is a share the person
 * wanted sound on and will not have: the caller must say so.
 */
export async function attachNativeShareAudio(
  stream: MediaStream,
  options: NativeShareAudioAttachOptions = {},
): Promise<NativeShareAudioAttach> {
  const bridge = nativeShareAudioBridge();
  if (!bridge) {
    discardPrimedNativeShareAudio();
    return { attached: false, reason: "no-bridge", target: null };
  }
  // A leftover from the last share is torn down here, but its shell session
  // was already replaced when this share's picker opened: stopping it by id
  // now would be a no-op at best, so it is not asked to.
  if (active) {
    teardown(active, false);
  }
  const ports = collectPorts();
  // SUBSCRIBED BEFORE THE CLAIM. The shell can report the capture's end at any
  // moment after it starts, including while this function is still loading the
  // graph; an event with no listener is gone. Ends are collected here by
  // session and judged once the session's id is known.
  const endedBeforeAttach = new Map<string, string>();
  let live: ActiveSession | null = null;
  const offEnded = subscribeToCaptureEnded(bridge, (endedId, reason) => {
    if (live && live.sessionId === endedId) {
      // The shell already stopped it and closed its end.
      captureLost(live, reason, false);
    } else {
      endedBeforeAttach.set(endedId, reason);
    }
  });
  let succeeded = false;
  try {
    let claim: NativeShareAudioClaim;
    try {
      claim = await bridge.nativeShareAudioClaim();
    } catch {
      failedThisSession = true;
      noteNativeShareAudio({ claim: "ipc-error", attached: false });
      noteNativeShareAudioFailure("claim", "the claim call failed");
      discardPrimedNativeShareAudio();
      return { attached: false, reason: "ipc", target: null };
    }
    if (!claim.active || !claim.sessionId) {
      // "none" is the box left unticked, the ordinary case. Anything else is
      // this machine failing a capture it offered: the next share goes back
      // to the old path instead of repeating it.
      discardPrimedNativeShareAudio();
      if (claim.reason && claim.reason !== "none") {
        console.warn("[share-audio] no native capture:", claim.reason, claim.stage ?? "", claim.hr ?? "");
        failedThisSession = true;
        const detail = `${claim.reason}/${claim.stage ?? "-"}/${claim.hr ?? "-"}`;
        noteNativeShareAudio({ claim: `failed:${detail}`, attached: false });
        noteNativeShareAudioFailure("claim", detail);
      } else {
        noteNativeShareAudio({ claim: "none", attached: false });
      }
      return { attached: false, reason: claim.reason ?? "none", target: null };
    }
    const sessionId = claim.sessionId;
    noteNativeShareAudio({ claim: "active" });
    const port = await ports.take(sessionId);
    noteNativeShareAudio({ port: port !== null });
    if (!port) {
      void bridge.nativeShareAudioStop(sessionId).catch(() => {});
      discardPrimedNativeShareAudio();
      failedThisSession = true;
      noteNativeShareAudio({ attached: false });
      noteNativeShareAudioFailure("port", "the PCM port never arrived");
      return { attached: false, reason: "port", target: null };
    }
    // The graph the arm built, already running in the click's gesture; one
    // built now only when there is none (an arm that did not come through here).
    let graph: Graph | null = null;
    if (primed) {
      graph = primed.graph;
      clearTimeout(primed.timer);
      primed = null;
    } else {
      const built = await buildGraph();
      graph = built.graph;
      if (!graph) {
        noteNativeShareAudioFailure("graph", built.failure ?? "unknown");
      }
    }
    if (!graph) {
      port.close();
      void bridge.nativeShareAudioStop(sessionId).catch(() => {});
      failedThisSession = true;
      noteNativeShareAudio({ attached: false });
      return { attached: false, reason: "audio-graph", target: null };
    }
    if (graph.context.state !== "running") {
      // Suspended between the arm and now (the window lost focus, the device
      // changed): resume once, inside the same bound, and judge the state.
      console.warn(`[share-audio] native audio context is ${graph.context.state} at share start`);
      await withTimeout(graph.context.resume(), RESUME_TIMEOUT_MS, undefined);
      noteNativeShareAudio({ contextState: graph.context.state });
    }
    if (graph.context.state !== "running") {
      disposeGraph(graph);
      port.close();
      void bridge.nativeShareAudioStop(sessionId).catch(() => {});
      noteNativeShareAudio({ attached: false });
      noteNativeShareAudioFailure("graph", `suspended:${graph.context.state}`);
      failedThisSession = true;
      return { attached: false, reason: "audio-graph", target: null };
    }
    listenToWorklet(graph.node, graph.context);
    graph.node.port.postMessage({ type: "port", port }, [port]);
    // It ended while the graph was being got ready: nothing is delivering, and
    // nothing will tell this session later, so it is judged now.
    const endedEarly = endedBeforeAttach.get(sessionId);
    if (endedEarly !== undefined) {
      disposeGraph(graph);
      console.warn(`[share-audio] native capture ended before it could be attached: ${endedEarly}`);
      noteNativeShareAudio({ attached: false, endedReason: endedEarly });
      noteNativeShareAudioFailure("ended", endedEarly);
      failedThisSession = true;
      return { attached: false, reason: "ended", target: null };
    }
    const video = stream.getVideoTracks()[0] ?? null;
    let suspendedTicks = 0;
    const session: ActiveSession = {
      sessionId,
      track: graph.track,
      context: graph.context,
      node: graph.node,
      onEnded: options.onEnded,
      timer: setInterval(() => {
        if (active !== session) {
          clearInterval(session.timer);
          return;
        }
        if (session.track.readyState === "ended" || video?.readyState === "ended") {
          teardown(session, true);
          return;
        }
        if (session.context.state === "running") {
          suspendedTicks = 0;
          return;
        }
        suspendedTicks += 1;
        if (suspendedTicks === 1) {
          console.warn(`[share-audio] native audio context is ${session.context.state} during the share`);
          void session.context.resume().catch(() => {});
        } else if (suspendedTicks >= SUSPENDED_TICKS_LIMIT) {
          captureLost(session, `context-${session.context.state}`, true);
        }
      }, WATCH_INTERVAL_MS),
    };
    live = session;
    session.offEnded = offEnded;
    active = session;
    succeeded = true;
    stream.addTrack(graph.track);
    noteNativeShareAudio({ attached: true });
    // eslint-disable-next-line no-console
    console.info(
      `[share-audio] native share sound attached (${claim.target?.mode ?? "?"} ${claim.target?.exe ?? ""}, context ${graph.context.state} @ ${graph.context.sampleRate})`,
    );
    return { attached: true, reason: null, target: claim.target ?? null };
  } finally {
    ports.dispose();
    if (!succeeded) {
      try {
        offEnded?.();
      } catch {
        // Already unsubscribed.
      }
    }
  }
}
