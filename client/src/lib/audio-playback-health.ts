import { audioSelfHealEnabled } from "@/lib/audio-self-heal-flag";

/**
 * The `<audio>` elements that play a call (`voice-audio-sinks.tsx`), and
 * whether they are actually playing.
 *
 * WHY THIS EXISTS. Those elements used to call `play()` and swallow the
 * rejection with a comment saying autoplay refusals were rare because joining
 * is itself a click. Three things make them not rare:
 *
 * - A call RESUMED rather than joined. After a reload or a deploy the call
 *   comes back on its own, with no click, and every element is born into a
 *   page that has not been touched. Chrome and Safari both refuse `play()`
 *   with `NotAllowedError` there, and the call is silent while every
 *   indicator says it is live.
 * - A person who joins late. Their element is created when they arrive, long
 *   after our click, and a mobile browser judges each element on its own.
 * - A phone pausing media by itself: an audio route change (headphones out, a
 *   Bluetooth handover) or an interruption on iOS pauses the element and
 *   nothing resumes it.
 *
 * All three leave the same mark, an element holding a stream and `paused`,
 * which is what `stuckPlaybackCount` counts and the voice controller turns
 * into a `playbackBlocked` fault. The repairs are here too: play again, and
 * on a refusal, play again on the very next press anywhere on the page,
 * which is the gesture the browser was waiting for.
 *
 * With `voice_audio_self_heal` off this only does what the component did
 * before: one `play()`, refusal ignored.
 */

interface Entry {
  peerId: string;
  onPause: () => void;
}

const entries = new Map<HTMLMediaElement, Entry>();
let gestureArmed = false;

function hasStream(el: HTMLMediaElement): boolean {
  return el.srcObject !== null && el.srcObject !== undefined;
}

/** Play one element. Resolves true when it is playing afterwards. */
export async function playElement(el: HTMLMediaElement): Promise<boolean> {
  if (!hasStream(el)) {
    return true;
  }
  try {
    await el.play();
    return !el.paused;
  } catch (err) {
    if (audioSelfHealEnabled() && err instanceof Error && err.name === "NotAllowedError") {
      armGestureRetry();
    }
    return false;
  }
}

/**
 * Follow one element for as long as it is mounted. A pause nobody asked for
 * (we never pause these: deafen and volume are `muted` and `volume`) is
 * answered with a play.
 */
export function trackPlaybackElement(el: HTMLMediaElement, peerId: string): () => void {
  const onPause = () => {
    if (!audioSelfHealEnabled() || !hasStream(el)) {
      return;
    }
    void playElement(el);
  };
  el.addEventListener("pause", onPause);
  entries.set(el, { peerId, onPause });
  return () => {
    el.removeEventListener("pause", onPause);
    entries.delete(el);
  };
}

/** Elements that hold a stream and are not playing it. */
export function stuckPlaybackCount(): number {
  let stuck = 0;
  for (const el of entries.keys()) {
    if (hasStream(el) && el.paused) {
      stuck += 1;
    }
  }
  return stuck;
}

/**
 * Play every stuck element. Run from a click, this is the gesture the browser
 * wanted. Resolves true when nothing is left stuck.
 */
export async function replayAllPlayback(): Promise<boolean> {
  await Promise.all([...entries.keys()].map((el) => (el.paused ? playElement(el) : true)));
  return stuckPlaybackCount() === 0;
}

/**
 * Point every element at the system default output. For a chosen speaker or
 * headset that is gone: `setSinkId` on a missing device rejects and leaves
 * the element where it was, so this is the way back to sound.
 */
export async function resetPlaybackSinks(): Promise<void> {
  await Promise.all(
    [...entries.keys()].map(async (el) => {
      const media = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof media.setSinkId !== "function") {
        return;
      }
      try {
        await media.setSinkId("");
      } catch {
        // Nothing better to point it at.
      }
    }),
  );
}

let outputMissingEvents = 0;
let handledMissingOutput: string | null = null;

/**
 * Is the speaker or headset the person chose still there? When it is gone,
 * every element goes back to the default output and the event is counted for
 * the call (`takeOutputMissingEvents`). Once per disappearance: the same
 * missing id is not handled twice until it has come back.
 *
 * Says nothing when it cannot tell: before a microphone permission a browser
 * lists outputs without ids, and an empty list is no evidence of anything.
 */
export async function checkOutputDevice(deviceId: string): Promise<void> {
  if (
    !audioSelfHealEnabled() ||
    !deviceId ||
    deviceId === "default" ||
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.enumerateDevices !== "function"
  ) {
    return;
  }
  let outputs: MediaDeviceInfo[];
  try {
    outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audiooutput",
    );
  } catch {
    return;
  }
  if (outputs.length === 0 || outputs.every((device) => !device.deviceId)) {
    return;
  }
  if (outputs.some((device) => device.deviceId === deviceId)) {
    if (handledMissingOutput === deviceId) {
      handledMissingOutput = null;
    }
    return;
  }
  if (handledMissingOutput === deviceId) {
    return;
  }
  handledMissingOutput = deviceId;
  outputMissingEvents += 1;
  await resetPlaybackSinks();
}

/** Missing outputs found (and already repaired) since the last call to this. */
export function takeOutputMissingEvents(): number {
  const taken = outputMissingEvents;
  outputMissingEvents = 0;
  return taken;
}

/**
 * Retry every stuck element on the next press or key anywhere, once. The
 * browser refused because the page had not been touched; the first touch is
 * the moment it will say yes.
 */
function armGestureRetry(): void {
  if (gestureArmed || typeof document === "undefined") {
    return;
  }
  gestureArmed = true;
  const retry = () => {
    gestureArmed = false;
    document.removeEventListener("pointerdown", retry, true);
    document.removeEventListener("keydown", retry, true);
    void replayAllPlayback();
  };
  document.addEventListener("pointerdown", retry, true);
  document.addEventListener("keydown", retry, true);
}

/** Test seam. */
export function resetAudioPlaybackHealthForTests(): void {
  for (const [el, entry] of entries) {
    el.removeEventListener("pause", entry.onPause);
  }
  entries.clear();
  gestureArmed = false;
  outputMissingEvents = 0;
  handledMissingOutput = null;
}
