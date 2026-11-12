import type { JamTrack } from "@pqp/shared";

/**
 * Which file of a track's video this browser plays. The server lists them best
 * first (`videoSources`: the worker's H.264 + AAC MP4 copy, then the recorded
 * file, WebM from Chrome), and `videoUrl` is the first of them. Chrome plays
 * both; Safari and iOS only the MP4, which is why the copy exists. A
 * `<video src>` cannot offer alternatives by itself, so the pick is made here
 * with `canPlayType` and the element is given that one URL.
 */

type CanPlay = (type: string) => string;

/**
 * The MIME type to ask `canPlayType` about. The copy is H.264 Main + AAC-LC
 * (`server/src/speech/video-transcode.ts`), so the bare `video/mp4` gets those
 * codecs named: Chromium without proprietary codecs answers `maybe` to a bare
 * `video/mp4` and then cannot play it.
 */
export function playTypeFor(contentType: string): string {
  const bare = contentType.split(";")[0]!.trim().toLowerCase();
  if (bare === "video/mp4") return 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"';
  return bare;
}

let probe: HTMLVideoElement | null | undefined;

function browserCanPlay(): CanPlay | null {
  if (probe === undefined) {
    try {
      probe = typeof document === "undefined" ? null : document.createElement("video");
    } catch {
      probe = null;
    }
  }
  const element = probe;
  return element ? (type) => element.canPlayType(type) : null;
}

/**
 * The URL to hand a `<video>`: the first listed source the browser says it
 * can play; the first one when it says no to all (let the element try and
 * fail, as before); `videoUrl` for a server that sends no list; null for no
 * video. `canPlay` is injectable for tests.
 */
export function pickJamVideoUrl(
  track: Pick<JamTrack, "videoUrl" | "videoSources">,
  canPlay: CanPlay | null = browserCanPlay(),
): string | null {
  const sources = (track.videoSources ?? []).filter((source) => source.url);
  if (sources.length === 0) return track.videoUrl;
  if (canPlay) {
    for (const source of sources) {
      let answer = "";
      try {
        answer = canPlay(playTypeFor(source.contentType));
      } catch {
        /* next */
      }
      if (answer) return source.url;
    }
  }
  return sources[0]!.url;
}
