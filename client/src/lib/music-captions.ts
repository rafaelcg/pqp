import { useSyncExternalStore } from "react";

/**
 * CAPTIONS FOR THE MUSIC EMBED, PER VIEWER.
 *
 * The embed runs with `controls: 0` so nobody can pause or scrub their own
 * copy of a synced room, and that also hid YouTube's CC button and its
 * Settings > Subtitles menu. YouTube then picked a track by itself: an
 * English talk showed English captions to a pt-BR viewer, with a Portuguese
 * track sitting unused, and no way to change it or turn it off.
 *
 * This is the replacement. It is a personal setting, like volume: it never
 * goes on the socket and never changes what anybody else sees. Off is the
 * default, because a music room is mostly music and YouTube's own default
 * is what the complaint was about.
 *
 * The caption calls (`loadModule`, `getOption`, `setOption`) are not in
 * YouTube's documented IFrame API. Every one is optional and wrapped, the
 * same posture `getVideoData().isLive` has, so an embed without them is a
 * player with no captions control rather than a crash.
 */

export interface CaptionTrack {
  languageCode: string;
  /** YouTube's name for it, in YouTube's language. Only a fallback. */
  displayName: string;
  /** `asr` is a track YouTube generated from the audio. */
  kind: string;
}

export interface CaptionsTarget {
  languageCode: string;
  /** Present when YouTube translates `languageCode` into this one. */
  translationLanguage?: { languageCode: string };
}

export interface MusicCaptionsPref {
  on: boolean;
  /** The language the viewer last asked for; kept while captions are off. */
  lang: string | null;
}

export interface MusicCaptionsState extends MusicCaptionsPref {
  /** The video on screen's tracks. Null while unknown, empty for none. */
  tracks: CaptionTrack[] | null;
  /** Codes YouTube will auto-translate into. */
  translations: string[];
}

const ON_KEY = "pqp:music-captions";
const LANG_KEY = "pqp:music-captions-lang";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // per-viewer convenience only
  }
}

function readPref(): MusicCaptionsPref {
  return {
    on: readStored(ON_KEY) === "1",
    lang: readStored(LANG_KEY),
  };
}

let state: MusicCaptionsState = { ...readPref(), tracks: null, translations: [] };
const listeners = new Set<() => void>();
let apply: (() => void) | null = null;

function emit(next: MusicCaptionsState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getMusicCaptions(): MusicCaptionsState {
  return state;
}

export function subscribeMusicCaptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMusicCaptions(): MusicCaptionsState {
  return useSyncExternalStore(subscribeMusicCaptions, getMusicCaptions, getMusicCaptions);
}

/** The embed registers how to put the current preference on its player. */
export function setMusicCaptionsApply(next: (() => void) | null): void {
  apply = next;
}

/** Turn captions on in `lang`, or off with `null`. Saved, then applied. */
export function setMusicCaptions(lang: string | null): void {
  const on = lang !== null;
  const next = { ...state, on, lang: lang ?? state.lang };
  writeStored(ON_KEY, on ? "1" : "0");
  writeStored(LANG_KEY, next.lang);
  emit(next);
  apply?.();
}

export function publishMusicCaptionTracks(
  tracks: CaptionTrack[] | null,
  translations: string[] = [],
): void {
  emit({ ...state, tracks, translations });
}

export function resetMusicCaptionsForTests(): void {
  listeners.clear();
  apply = null;
  state = { ...readPref(), tracks: null, translations: [] };
}

function primary(code: string): string {
  return code.toLowerCase().split("-")[0] ?? "";
}

/** Exact code first, then the same language in another region; people over ASR. */
function findTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | undefined {
  const wanted = lang.toLowerCase();
  const human = (track: CaptionTrack) => track.kind !== "asr";
  const exact = tracks.filter((track) => track.languageCode.toLowerCase() === wanted);
  const sameLanguage = tracks.filter((track) => primary(track.languageCode) === primary(lang));
  return (
    exact.find(human) ??
    exact[0] ??
    sameLanguage.find(human) ??
    sameLanguage[0]
  );
}

function findTranslation(translations: string[], lang: string): string | undefined {
  const wanted = lang.toLowerCase();
  return (
    translations.find((code) => code.toLowerCase() === wanted) ??
    translations.find((code) => code.toLowerCase() === primary(lang)) ??
    translations.find((code) => primary(code) === primary(lang))
  );
}

/**
 * What to put on the player for a viewer who wants `lang`.
 *
 * The video's own track in that language when it has one, then YouTube's
 * translation into it, then the video's original track rather than
 * nothing: a viewer who turned captions on wants captions.
 */
export function resolveCaptionsTarget(
  tracks: CaptionTrack[],
  translations: string[],
  lang: string,
): CaptionsTarget | null {
  if (tracks.length === 0) {
    return null;
  }
  const own = findTrack(tracks, lang);
  if (own) {
    return { languageCode: own.languageCode };
  }
  const source = tracks.find((track) => track.kind !== "asr") ?? tracks[0]!;
  const into = findTranslation(translations, lang);
  if (into) {
    return {
      languageCode: source.languageCode,
      translationLanguage: { languageCode: into },
    };
  }
  return { languageCode: source.languageCode };
}

/** The undocumented corner of the player this module talks to. */
export interface CaptionsPlayer {
  loadModule?: (name: string) => void;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

function asTracks(raw: unknown): CaptionTrack[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const tracks: CaptionTrack[] = [];
  for (const item of raw) {
    const code = (item as { languageCode?: unknown })?.languageCode;
    if (typeof code !== "string" || code === "") {
      continue;
    }
    const kind = String((item as { kind?: unknown }).kind ?? "");
    const key = `${code}|${kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tracks.push({
      languageCode: code,
      displayName: String((item as { displayName?: unknown }).displayName ?? code),
      kind,
    });
  }
  return tracks;
}

function asCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => (item as { languageCode?: unknown })?.languageCode)
    .filter((code): code is string => typeof code === "string" && code !== "");
}

export function readCaptionTracks(
  player: CaptionsPlayer,
): { tracks: CaptionTrack[]; translations: string[] } {
  try {
    player.loadModule?.("captions");
    return {
      tracks: asTracks(player.getOption?.("captions", "tracklist")),
      translations: asCodes(player.getOption?.("captions", "translationLanguages")),
    };
  } catch {
    return { tracks: [], translations: [] };
  }
}

/**
 * Put `pref` on the player. Off is an empty track, which hides captions and,
 * unlike `unloadModule`, keeps the track list readable for the menu.
 */
export function applyCaptionsPref(
  player: CaptionsPlayer,
  pref: MusicCaptionsPref,
  tracks: CaptionTrack[],
  translations: string[],
  uiLocale: string,
): boolean {
  const target = pref.on
    ? resolveCaptionsTarget(tracks, translations, pref.lang ?? uiLocale)
    : null;
  try {
    player.setOption?.("captions", "track", target ?? {});
    return true;
  } catch {
    return false;
  }
}

export const CAPTIONS_READ_ATTEMPTS = 6;
export const CAPTIONS_READ_INTERVAL_MS = 1_000;

/**
 * Read the new video's tracks and apply the viewer's choice.
 *
 * The track list arrives some time after PLAYING, and never for a video
 * with no captions, so this asks a bounded number of times rather than
 * waiting for an event that may not come. Returns the cancel.
 */
export function startMusicCaptionsSync(
  player: CaptionsPlayer,
  uiLocale: () => string,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): () => void {
  let handle: unknown = null;
  let cancelled = false;
  publishMusicCaptionTracks(null);
  const attempt = (left: number) => {
    if (cancelled) {
      return;
    }
    const { tracks, translations } = readCaptionTracks(player);
    if (tracks.length === 0 && left > 1) {
      // Hidden while unknown: YouTube's own default would otherwise show
      // in the gap before the list arrives.
      applyCaptionsPref(player, { on: false, lang: null }, [], [], uiLocale());
      handle = timers.set(() => attempt(left - 1), CAPTIONS_READ_INTERVAL_MS);
      return;
    }
    publishMusicCaptionTracks(tracks, translations);
    applyCaptionsPref(player, getMusicCaptions(), tracks, translations, uiLocale());
  };
  attempt(CAPTIONS_READ_ATTEMPTS);
  return () => {
    cancelled = true;
    if (handle !== null) {
      timers.clear(handle);
    }
  };
}

export interface CaptionsChoice {
  id: string;
  label: string;
  /** What `setMusicCaptions` gets; null is off. */
  lang: string | null;
  checked: boolean;
}

/**
 * The menu: Off, then the viewer's own language (a track, or YouTube's
 * translation into it), then every other track the video has.
 */
export function musicCaptionsChoices(input: {
  state: MusicCaptionsState;
  uiLocale: string;
  offLabel: string;
  autoTranslatedLabel: (language: string) => string;
  generatedLabel: (language: string) => string;
  languageName: (code: string, fallback: string) => string;
}): CaptionsChoice[] {
  const { state: s, uiLocale } = input;
  const tracks = s.tracks ?? [];
  const active = s.on
    ? resolveCaptionsTarget(tracks, s.translations, s.lang ?? uiLocale)
    : null;
  const choices: CaptionsChoice[] = [
    { id: "off", label: input.offLabel, lang: null, checked: !s.on },
  ];
  // A translation row for the UI language and, when it differs, for the
  // language the viewer last picked: a saved English on a video with no
  // English track is translated into English, and must show as a ticked row.
  const wanted = [uiLocale, s.lang].filter(
    (lang, index, all): lang is string =>
      lang !== null && all.findIndex((other) => other !== null && primary(other) === primary(lang)) === index,
  );
  for (const lang of wanted) {
    const translateInto = findTrack(tracks, lang)
      ? undefined
      : findTranslation(s.translations, lang);
    if (!translateInto) {
      continue;
    }
    choices.push({
      id: `translate:${translateInto}`,
      label: input.autoTranslatedLabel(input.languageName(lang, lang)),
      lang,
      checked: active?.translationLanguage?.languageCode === translateInto,
    });
  }
  const mine = (track: CaptionTrack) => primary(track.languageCode) === primary(uiLocale);
  // The choice is a language, and `findTrack` takes a person's track over a
  // generated one, so a generated track is only a row of its own when its
  // language has no person's track to pick instead.
  const listed = tracks.filter(
    (track) =>
      track.kind !== "asr" ||
      !tracks.some(
        (other) => other.languageCode === track.languageCode && other.kind !== "asr",
      ),
  );
  const ordered = [...listed.filter(mine), ...listed.filter((track) => !mine(track))];
  for (const track of ordered) {
    const name = input.languageName(track.languageCode, track.displayName);
    const checked =
      active !== null &&
      !active.translationLanguage &&
      active.languageCode === track.languageCode;
    choices.push({
      id: `track:${track.languageCode}:${track.kind}`,
      label: track.kind === "asr" ? input.generatedLabel(name) : name,
      lang: track.languageCode,
      checked,
    });
  }
  return choices;
}

/** `pt-BR` reads "português (Brasil)" in Portuguese, not YouTube's English. */
export function captionLanguageName(uiLocale: string, code: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: "language" }).of(code);
    if (name && name !== code) {
      return name.charAt(0).toLocaleUpperCase(uiLocale) + name.slice(1);
    }
  } catch {
    // an unknown code or an engine without DisplayNames
  }
  return fallback;
}
