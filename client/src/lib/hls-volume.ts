/**
 * The watch-mode viewer's own volume for the broadcast, remembered between
 * streams and between sessions.
 *
 * WHY IT EXISTS. In a WebRTC call you can turn one person down
 * (`peer-audio-menu.tsx`). An HLS viewer had nothing: the `<video>` carries no
 * `controls` attribute, so the only sound affordance on the whole cinema
 * stage was the "Toca pra ligar o som" button that appears after an autoplay
 * refusal, and a watch party you cannot turn down is one you have to leave.
 *
 * The preference is per viewer and per browser, like the collapsed-category
 * state: nothing here is worth a round trip, and one person turning the film
 * down must not turn it down for the room.
 *
 * Muted is stored ALONGSIDE the level rather than as `volume: 0`, so
 * unmuting returns to the level the person had picked, the same rule the
 * per-peer sliders follow.
 */

const STORAGE_KEY = "pqp:hls-volume";

export interface HlsVolumePref {
  /** 0 to 1. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_HLS_VOLUME: HlsVolumePref = { volume: 1, muted: false };

export function clampVolume(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_HLS_VOLUME.volume;
  }
  return Math.min(1, Math.max(0, numeric));
}

/** Tolerant on purpose: a corrupt or half-written entry is not worth an error. */
export function parseHlsVolume(raw: string | null): HlsVolumePref {
  if (!raw) {
    return DEFAULT_HLS_VOLUME;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_HLS_VOLUME;
  }
  if (!parsed || typeof parsed !== "object") {
    return DEFAULT_HLS_VOLUME;
  }
  const record = parsed as Record<string, unknown>;
  return {
    volume: clampVolume(record.volume),
    muted: record.muted === true,
  };
}

export function readHlsVolume(): HlsVolumePref {
  try {
    return parseHlsVolume(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled. The default is a working player.
    return DEFAULT_HLS_VOLUME;
  }
}

export function writeHlsVolume(pref: HlsVolumePref): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ volume: clampVolume(pref.volume), muted: pref.muted }),
    );
  } catch {
    // Nothing to do: the control still works for this session.
  }
}

/**
 * What the element should actually be set to, given the person's preference
 * and whether the browser forced a muted start.
 *
 * The two must not fight. An autoplay refusal mutes the element without the
 * person asking, and that is temporary: it must not be written to their
 * preference, and pressing either unmute affordance has to clear both halves,
 * or the button would appear to do nothing.
 */
export function effectiveMuted(input: {
  pref: HlsVolumePref;
  autoplayMuted: boolean;
}): boolean {
  return input.pref.muted || input.autoplayMuted;
}

/** Dragging the slider up off zero is itself an unmute. */
export function applySliderChange(next: number): HlsVolumePref {
  const volume = clampVolume(next);
  return { volume, muted: volume === 0 };
}

/** The mute button: remember the level so unmuting comes back to it. */
export function applyMuteToggle(
  pref: HlsVolumePref,
  restore: number,
): HlsVolumePref {
  if (pref.muted || pref.volume === 0) {
    const volume = pref.volume > 0 ? pref.volume : clampVolume(restore) || 1;
    return { volume, muted: false };
  }
  return { volume: pref.volume, muted: true };
}
