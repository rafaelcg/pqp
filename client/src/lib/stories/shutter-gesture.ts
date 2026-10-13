import { HOLD_TO_RECORD_MS } from "./camera";

/**
 * The shutter's press, as a small state machine with no DOM in it.
 *
 * - A press that ends before `holdMs` is a TAP: one photo, on release.
 * - A press that is still down at `holdMs` starts a recording; releasing it
 *   ends the recording.
 * - While a clip started elsewhere (the record button) is running, the next
 *   press only ends it.
 * - With recording unavailable (a browser without MP4 recording) every press is
 *   a photo, immediately on release.
 *
 * `press` and `release` are idempotent per press, because a pointer, its
 * capture and the keyboard can all report the same gesture.
 */

export interface ShutterHandlers {
  onPhoto: () => void;
  onRecordStart: () => void;
  onRecordStop: () => void;
}

export interface ShutterGesture {
  press: () => void;
  release: () => void;
  /** Drop a pending hold (unmount). A recording in progress is the owner's to stop. */
  dispose: () => void;
  setState: (state: { canRecord: boolean; recording: boolean; disabled: boolean }) => void;
}

export function createShutterGesture(
  handlers: ShutterHandlers,
  options: { holdMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {},
): ShutterGesture {
  const holdMs = options.holdMs ?? HOLD_TO_RECORD_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressed = false;
  let held = false;
  let canRecord = true;
  let recording = false;
  let disabled = false;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    setState(state) {
      canRecord = state.canRecord;
      recording = state.recording;
      disabled = state.disabled;
    },
    press() {
      if (disabled || pressed) {
        return;
      }
      pressed = true;
      if (recording && !held) {
        handlers.onRecordStop();
        return;
      }
      if (!canRecord) {
        return;
      }
      timer = setTimer(() => {
        timer = null;
        held = true;
        handlers.onRecordStart();
      }, holdMs);
    },
    release() {
      if (!pressed) {
        return;
      }
      pressed = false;
      if (timer !== null) {
        cancelTimer();
        handlers.onPhoto();
        return;
      }
      if (held) {
        held = false;
        handlers.onRecordStop();
        return;
      }
      // Pressed with no hold to wait for: recording is unavailable, or the press
      // ended a clip the record button started. Only the first is a photo.
      if (!canRecord && !recording) {
        handlers.onPhoto();
      }
    },
    dispose() {
      cancelTimer();
      pressed = false;
      held = false;
    },
  };
}
