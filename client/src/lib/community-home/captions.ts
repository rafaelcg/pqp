import {
  normalizeCommunityHomeLang,
  type CommunityHomeCaptionTrack,
} from "@pqp/shared";

/**
 * Automatic subtitles on a Baú video: which track to show, whether to show it
 * by default, what to call it. Pure apart from the remembered choice, so the
 * player (`community-home-media.tsx`) only wires elements.
 *
 * The rule: subtitles start ON when the video is in another language than the
 * reader's (that is who they are for), OFF when it is the reader's own. Once a
 * person presses the CC button, that choice wins on every video after it, in
 * this browser.
 */

export const COMMUNITY_HOME_CAPTIONS_PREF_KEY = "pqp:community-home-captions";

export type CaptionsPreference = "on" | "off";

let memory: CaptionsPreference | null = null;

export function readCaptionsPreference(): CaptionsPreference | null {
  try {
    const stored = window.localStorage.getItem(COMMUNITY_HOME_CAPTIONS_PREF_KEY);
    if (stored === "on" || stored === "off") return stored;
  } catch {
    // Storage blocked: the in-memory value below still answers for this tab.
  }
  return memory;
}

export function writeCaptionsPreference(value: CaptionsPreference): void {
  memory = value;
  try {
    window.localStorage.setItem(COMMUNITY_HOME_CAPTIONS_PREF_KEY, value);
  } catch {
    // Storage blocked: remembered for this tab only.
  }
}

/** Tests only. */
export function resetCaptionsPreferenceForTests(): void {
  memory = null;
}

/** `pt-BR` and `pt` are one language here, like the post translations. */
function baseLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return normalizeCommunityHomeLang(lang) ?? lang.trim().toLowerCase().split(/[-_]/)[0] ?? null;
}

export function captionsOnByDefault(
  sourceLang: string,
  readerLocale: string,
  stored: CaptionsPreference | null = readCaptionsPreference(),
): boolean {
  if (stored) return stored === "on";
  const source = baseLang(sourceLang);
  // A track whose language Whisper could not tell is not assumed to be ours.
  if (!source || source === "und") return true;
  return source !== baseLang(readerLocale);
}

/** The reader's own language when there is a track in it, else what was said. */
export function pickCaptionTrack<T extends Pick<CommunityHomeCaptionTrack, "lang" | "source">>(
  tracks: readonly T[],
  readerLocale: string,
): T | null {
  const reader = baseLang(readerLocale);
  return (
    tracks.find((track) => baseLang(track.lang) === reader) ??
    tracks.find((track) => track.source) ??
    tracks[0] ??
    null
  );
}

/** "Português", "English": the language in the reader's own UI language. */
export function captionLanguageName(lang: string, uiLocale: string): string | null {
  if (!lang || lang === "und") return null;
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: "language" }).of(lang);
    if (!name || name === lang) return null;
    return name.charAt(0).toLocaleUpperCase(uiLocale) + name.slice(1);
  } catch {
    return null;
  }
}

/** A `blob:` URL per track: a `<track>` cannot send the Authorization header the API needs. */
export function captionTrackUrl(vtt: string): string {
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}
