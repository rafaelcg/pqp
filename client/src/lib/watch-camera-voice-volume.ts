/**
 * The viewer's volume for the camera/voice PiP's OWN audio.
 *
 * Only meaningful in `LIVE_HLS_VOICE_TRACK`'s "separada" mode
 * (`cameraHasVoiceAudio`): every camera before that flag is muted by design,
 * with no volume to remember. A separate preference from the film's own —
 * `HlsWatchPlayer`'s volume slider controls `hlsUrl`, this one controls
 * `cameraHlsUrl` — because a viewer who wants the voice loud and the film's
 * own (silent, per `docs/WATCH_PARTY.md`, "What the stream carries") quiet
 * has no film volume to share it with anyway, and a future deployment where
 * `hlsUrl` itself carries sound must not have the two pinned together by
 * construction.
 *
 * Per browser, like every other watch-party audio preference in this
 * directory (`stream-mix-levels.ts`, `screen-preview-pref.ts`).
 */
const STORAGE_KEY = "pqp:watch-camera-voice-volume";

/** 0 (silent) to 1 (full), same range `HTMLMediaElement.volume` takes. */
export const DEFAULT_VOICE_PIP_VOLUME = 1;

export function getVoicePipVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_VOICE_PIP_VOLUME;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOICE_PIP_VOLUME;
  } catch {
    return DEFAULT_VOICE_PIP_VOLUME;
  }
}

export function saveVoicePipVolume(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.min(1, Math.max(0, value))));
  } catch {
    // Storage denied: the choice holds for this session.
  }
}
