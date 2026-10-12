import { fetchGlobalVoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * `voice_audio_self_heal` as the client learns it: `audioSelfHeal` on the
 * global `GET /api/voice/config`. Read by the voice controller every tick of
 * a call and by the audio elements before they arm a retry, so it is a
 * module-level answer rather than a hook.
 *
 * UNKNOWN IS OFF, and that is load-bearing rather than cautious. The answer is
 * also the client's only evidence that this API understands
 * `mediaQuality.audioHealth` on a call rating. The rating schema is strict, so
 * an API that predates the field would refuse the whole rating over it, and
 * the score is the part that matters. An API that never said `true` never
 * gets the field.
 *
 * Re-asked on focus and on a slow timer by `lib/config-refresh.ts`, so turning
 * it off from the dashboard reaches a call already running, at most one
 * refresh later, with no reload. A failed ask keeps the last answer.
 */
let enabled = false;
let asked = 0;
let applied = 0;

export function audioSelfHealEnabled(): boolean {
  return enabled;
}

export async function loadAudioSelfHealFlag(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const answer = await fetchGlobalVoiceConfig();
    if (mine > applied) {
      applied = mine;
      enabled = answer.audioSelfHeal === true;
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startAudioSelfHealFlag(): () => void {
  void loadAudioSelfHealFlag();
  const stop = onConfigRefresh(() => {
    void loadAudioSelfHealFlag();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    enabled = false;
  };
}

/** Test seam. */
export function setAudioSelfHealForTests(next: boolean): void {
  enabled = next;
}
