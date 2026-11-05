import { useSyncExternalStore } from "react";
import { fetchGlobalVoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Whether the transcript is windowed: only the rows near the viewport mounted,
 * and a row's hover toolbar built when the pointer or focus first reaches it.
 *
 * The runtime flag `message_list_windowing` (global, on by default), learned as
 * `messageListWindowing` on the global `GET /api/voice/config`. See
 * `docs/FEATURE_FLAGS.md` and `docs/MESSAGE_LIST_WINDOWING.md`.
 *
 * ON UNLESS THE SERVER SAYS OFF. Unknown (not asked yet, an older API that
 * sends no field, a failed first ask) reads as on, the opposite of
 * `clean_voice_default`: this is the shipped behaviour, and starting every tab
 * on the old list for the length of one request would mount a whole channel
 * only to tear it down. Only an explicit `false` is the kill switch. A failed
 * ask after an answer keeps the answer.
 *
 * Flipping it moves a tab that is already open on the next config refresh
 * (focus, or the slow timer): the list switches rendering strategy in place,
 * with no reload.
 */
let windowingOn = true;
let asked = 0;
let applied = 0;
const listeners = new Set<() => void>();

function setWindowing(next: boolean): void {
  if (next === windowingOn) {
    return;
  }
  windowingOn = next;
  for (const listener of listeners) {
    listener();
  }
}

/** The answer right now. */
export function messageListWindowingOn(): boolean {
  return windowingOn;
}

export async function loadMessageListWindowingFlag(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const answer = await fetchGlobalVoiceConfig();
    if (mine > applied) {
      applied = mine;
      setWindowing(answer.messageListWindowing !== false);
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startMessageListWindowingFlag(): () => void {
  void loadMessageListWindowingFlag();
  const stop = onConfigRefresh(() => {
    void loadMessageListWindowingFlag();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    setWindowing(true);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The flag as React state; re-renders when it moves. */
export function useMessageListWindowing(): boolean {
  return useSyncExternalStore(
    subscribe,
    messageListWindowingOn,
    messageListWindowingOn,
  );
}

/** Test seam. */
export function setMessageListWindowingForTests(on: boolean): void {
  setWindowing(on);
}
