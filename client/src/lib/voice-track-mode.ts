/**
 * "Voz: junto com o filme / separada".
 *
 * Whether a watch party's screen mix folds the presenter's microphone into
 * the film's own audio track ("junto", the only shape before
 * `LIVE_HLS_VOICE_TRACK`) or keeps the two apart, so the voice rides its own
 * rung instead — beside the camera when there is one, alone when there is
 * not (`packages/shared/src/live-hls.ts`, `cameraHasVoiceAudio`). See
 * `docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`.
 *
 * Per browser, like `lib/mic-in-stream.ts`'s "Meu mic vai no stream" switch
 * this one sits beside: it only changes anything once that switch is on,
 * which is why the default is "junto" — the previous, only-ever behaviour —
 * rather than something a returning host has to notice and set back.
 */
const STORAGE_KEY = "pqp:voice-track-mode";

export type VoiceTrackMode = "junto" | "separada";

export function getVoiceTrackMode(): VoiceTrackMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "separada" ? "separada" : "junto";
  } catch {
    return "junto";
  }
}

export function saveVoiceTrackMode(mode: VoiceTrackMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage denied: the choice holds for this session.
  }
}
