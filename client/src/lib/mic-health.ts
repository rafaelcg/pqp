/**
 * Notice when the microphone a call is publishing has quietly stopped, so the
 * call can reopen it instead of sending silence until somebody rejoins.
 *
 * WHY THIS EXISTS. The published microphone is not the capture track. It is
 * the output of a WebAudio graph (`createMicPipeline` in `use-voice.ts`): the
 * raw `getUserMedia` track feeds a source node, through the suppressor and the
 * gain, into a `MediaStreamAudioDestinationNode`, and THAT node's track is the
 * one on every mesh sender and the SFU publication. Two things can kill the
 * sound without touching the published track at all:
 *
 *  - the raw capture ENDS: a Bluetooth headset sleeps or drops to another
 *    profile, a USB headset hiccups, the OS default device changes, the OS
 *    revokes the device. The source node then reads silence for ever;
 *  - the AudioContext stops RUNNING (`suspended`). The destination node is
 *    clocked by the context's render thread, so a context that is not
 *    rendering produces nothing.
 *
 * In both cases the published track stays `live` and `enabled`, the mute
 * button says unmuted, the other people in the call are still heard, and the
 * person's own voice reaches nobody. Nothing in the client listened for
 * either, so the only cure was the one a user reported on 2026-10-10: "toda
 * hora minha voz nao sai e tenho que sair e reconectar" (my voice keeps not
 * coming out and I have to leave and reconnect). Rejoining builds a new
 * pipeline, which is exactly what `swapPipeline` already does mid-call for a
 * device change, without leaving.
 *
 * `track.stop()` (our own teardown) does not fire `ended`, per the spec, and a
 * context WE close goes to `closed`, which is ignored here. So the only events
 * that reach `onFault` are ones nobody in this app asked for.
 *
 * Pure apart from the listeners it adds, and it tolerates objects without
 * `addEventListener` (older engines, test doubles), in which case it watches
 * nothing rather than throwing.
 */

export type MicFault = "capture-ended" | "context-stalled";

export interface WatchableMicTrack {
  readyState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface WatchableMicContext {
  state: string;
  resume?: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * How long a `resume()` may take before a context that is still not running
 * counts as stalled. Chrome can leave `resume()` pending for ever on a page it
 * will not let make sound (see `native-share-audio.ts`), so this is bounded.
 */
export const MIC_CONTEXT_RESUME_TIMEOUT_MS = 2_000;

/**
 * Watch one pipeline. Calls `onFault` at most once, then stops watching: the
 * caller replaces the pipeline, and the replacement gets a watcher of its own.
 * Returns a dispose function; safe to call more than once.
 */
export function watchMicHealth(
  target: { tracks: WatchableMicTrack[]; context: WatchableMicContext },
  onFault: (fault: MicFault) => void,
  options: {
    resumeTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
  } = {},
): () => void {
  const resumeTimeoutMs = options.resumeTimeoutMs ?? MIC_CONTEXT_RESUME_TIMEOUT_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const { tracks, context } = target;
  let done = false;
  let resumeTimer: unknown = null;

  const fault = (kind: MicFault) => {
    if (done) {
      return;
    }
    dispose();
    onFault(kind);
  };

  const onTrackEnded = () => fault("capture-ended");

  const onContextState = () => {
    if (done || context.state !== "suspended") {
      // `running` is healthy; `closed` is our own teardown; `interrupted`
      // (WebKit: a phone call, Siri) is undone by the engine itself when the
      // interruption ends, and reopening the mic during one would fail anyway.
      return;
    }
    if (typeof context.resume !== "function") {
      fault("context-stalled");
      return;
    }
    if (resumeTimer !== null) {
      return;
    }
    let settled = false;
    const check = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (resumeTimer !== null) {
        clearTimer(resumeTimer);
        resumeTimer = null;
      }
      if (!done && context.state !== "running" && context.state !== "closed") {
        fault("context-stalled");
      }
    };
    resumeTimer = setTimer(check, resumeTimeoutMs);
    context.resume().then(check, check);
  };

  function dispose() {
    if (done) {
      return;
    }
    done = true;
    if (resumeTimer !== null) {
      clearTimer(resumeTimer);
      resumeTimer = null;
    }
    for (const track of tracks) {
      track.removeEventListener?.("ended", onTrackEnded);
    }
    context.removeEventListener?.("statechange", onContextState);
  }

  for (const track of tracks) {
    if (typeof track.addEventListener === "function") {
      track.addEventListener("ended", onTrackEnded);
    }
  }
  if (typeof context.addEventListener === "function") {
    context.addEventListener("statechange", onContextState);
  }

  // Already dead by the time anyone looked: the capture can end between
  // `getUserMedia` resolving and this watcher being attached.
  if (tracks.some((track) => track.readyState === "ended")) {
    queueMicrotask(() => fault("capture-ended"));
  } else if (context.state === "suspended") {
    onContextState();
  }

  return dispose;
}

/**
 * A ceiling on automatic reopens, so a device that dies again the moment it
 * is opened, or a context the browser will not let run, cannot turn into a
 * `getUserMedia` loop with the recording indicator flickering. Three in ten
 * minutes is more than any real recovery needs; past it the call is left as
 * it was before this existed, and the event says so.
 */
export function createMicRecoveryBudget(max = 3, windowMs = 10 * 60_000) {
  let stamps: number[] = [];
  return {
    take(now: number): boolean {
      stamps = stamps.filter((at) => now - at < windowMs);
      if (stamps.length >= max) {
        return false;
      }
      stamps.push(now);
      return true;
    },
    reset() {
      stamps = [];
    },
  };
}
