/**
 * WHICH FILE A LISTENER DOWNLOADS FOR A STEM.
 *
 * The server offers, for a stem it has made an Opus listening copy of AND with
 * its runtime flag `jam_audio_copy` on, a list on the track: `audioSources`,
 * the copy first and the original (the FLAC, `audioUrl`) last
 * (`jamAudioSourceSchema`, `docs/JAM_ENGINE.md` "The listening copy"). With the
 * flag off, or no copy yet, or a failed one, the track has no `audioSources` and
 * this module plans exactly one file: the original, which is today's behaviour.
 * The client needs no rebuild to flip any of it: the choice is in the data.
 *
 * Three rules, all of them about never making a listener worse off:
 *
 *   1. ONLY LISTENING asks (`syncJamStems(..., { listen: true })`). The studio
 *      records against the original and never passes it, so a stem is a FLAC
 *      there whatever the track carries.
 *   2. NEVER BLOCK PLAYBACK ON A COPY. A copy that 404s, or whose bytes this
 *      browser cannot decode, falls back to the next file in the plan for THAT
 *      stem (`planListenSources` always ends with the original), and a decode
 *      failure is remembered for the rest of the session so the next stems do not
 *      each pay a wasted download (`noteListenCopyFailure`).
 *   3. DO NOT TRY WHAT THE BROWSER SAYS IT CANNOT PLAY. `canPlayType` is only
 *      a hint (a "maybe" can still fail to decode, which rule 2 covers), but an
 *      empty answer for Opus in Ogg, as on a Safari before it learned the
 *      container, means FLAC straight away with no wasted bytes.
 *
 * The copy is a different decoder path for the same sound: its onsets land where
 * the FLAC's do (`server/src/speech/audio-copy.ts`: the encoder's delay is
 * declared in the file and checked on every copy), and `client/e2e/jam/formats.spec.ts`
 * measures it in the browsers' own `decodeAudioData`.
 */

import type { JamAudioSource } from "@pqp/shared";

export type Rendition = "copy" | "original";

export interface PlannedSource {
  url: string;
  rendition: Rendition;
}

/** What the choice reads of a track: the original's URL and, maybe, the list. */
export interface ListenTrack {
  audioUrl: string;
  audioSources?: readonly JamAudioSource[] | undefined;
}

/** The copy's own type: Opus in Ogg. The only copy the worker makes today. */
const COPY_MEDIA_TYPE = 'audio/ogg; codecs="opus"';

let probed: boolean | null = null;

/**
 * Whether this browser claims it can play Opus in Ogg. Asked once. A browser
 * with no `Audio` (a test, a worker) says no, which is the safe answer: the
 * original.
 */
export function browserPlaysListenCopy(): boolean {
  if (probed === null) {
    try {
      probed = typeof Audio !== "undefined" && new Audio().canPlayType(COPY_MEDIA_TYPE) !== "";
    } catch {
      probed = false;
    }
  }
  return probed;
}

/** What a failure of a copy tells about the rest of the session. */
let copiesDisabled = false;

/** Whether a decode failure already ruled copies out for this page. */
export function listenCopiesDisabled(): boolean {
  return copiesDisabled;
}

/**
 * A copy failed to load. A HTTP answer or a dropped connection says something
 * about THAT file only (an expired link, a 404 for a copy deleted a moment ago)
 * and changes nothing. A DECODE error says this browser cannot read the copy at
 * all, so no further stem tries it for the rest of the page's life.
 */
export function noteListenCopyFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/^jam: fetch \d+/.test(message) || name === "AbortError" || name === "TypeError") {
    return;
  }
  copiesDisabled = true;
}

/** Tests only. */
export function resetListenCopyForTests(probe: boolean | null = null): void {
  probed = probe;
  copiesDisabled = false;
}

function isOpusCopy(source: unknown): source is JamAudioSource {
  if (typeof source !== "object" || source === null) return false;
  const one = source as Partial<JamAudioSource>;
  return (
    typeof one.url === "string" &&
    one.url !== "" &&
    one.codec === "opus" &&
    typeof one.contentType === "string" &&
    one.contentType.toLowerCase() === "audio/ogg"
  );
}

/**
 * The files to try for one stem, in order, and never empty: the Opus copy when
 * `listen` is asked, the track offers one, and this browser has not ruled copies
 * out, then the original. Anything unexpected in `audioSources` (a newer server's
 * other codec, a malformed entry) is ignored, so the plan degrades to the
 * original instead of throwing.
 */
export function planListenSources(
  track: ListenTrack,
  options: { listen: boolean; supported?: boolean },
): PlannedSource[] {
  const original: PlannedSource = { url: track.audioUrl, rendition: "original" };
  if (!options.listen || copiesDisabled || !Array.isArray(track.audioSources)) {
    return [original];
  }
  if (!(options.supported ?? browserPlaysListenCopy())) {
    return [original];
  }
  const copy = (track.audioSources as readonly unknown[]).find(isOpusCopy);
  return copy ? [{ url: copy.url, rendition: "copy" }, original] : [original];
}
