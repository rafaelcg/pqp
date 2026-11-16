import { fetchGlobalVoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * `voice_calm_detector` as the client learns it: `calmDetector` on the global
 * `GET /api/voice/config`. Read by the voice controller on every step of its
 * speaking loop, so it is a module-level answer rather than a hook.
 *
 * Off (or unknown) is the loop this client always had: a
 * `requestAnimationFrame` callback at the display's refresh rate that reads
 * every peer's analyser. On, the same loop runs on a timer at 20 Hz, 4 Hz when
 * the window is hidden, and the transmit gate keeps its own fast clock
 * (`lib/speaking-clock.ts`). See `docs/FEATURE_FLAGS.md`.
 *
 * UNKNOWN IS OFF: an API that predates the flag sends no field, a failed ask
 * keeps the last answer, and the page behaves as it did until it hears `true`.
 * The config is asked at start-up and again on focus and on a slow timer
 * (`lib/config-refresh.ts`), so flipping it from the dashboard reaches a call
 * already running, at most one refresh later, with no reload.
 */
let enabled = false;
let asked = 0;
let applied = 0;

export function calmDetectorEnabled(): boolean {
  return enabled;
}

export async function loadCalmDetectorFlag(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const answer = await fetchGlobalVoiceConfig();
    if (mine > applied) {
      applied = mine;
      enabled = answer.calmDetector === true;
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startCalmDetectorFlag(): () => void {
  void loadCalmDetectorFlag();
  const stop = onConfigRefresh(() => {
    void loadCalmDetectorFlag();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    enabled = false;
  };
}

/** Test seam. */
export function setCalmDetectorForTests(next: boolean): void {
  enabled = next;
}
