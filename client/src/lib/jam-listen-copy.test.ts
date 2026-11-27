import { beforeEach, describe, expect, it } from "vitest";
import type { JamAudioSource } from "@pqp/shared";
import {
  listenCopiesDisabled,
  noteListenCopyFailure,
  planListenSources,
  resetListenCopyForTests,
} from "./jam-listen-copy";

const copy: JamAudioSource = { url: "https://media.test/a.listen.ogg?s=1", contentType: "audio/ogg", codec: "opus", bytes: 900 };
const original: JamAudioSource = { url: "https://media.test/a.flac?s=1", contentType: "audio/flac", bytes: 5000 };
const track = { audioUrl: original.url, audioSources: [copy, original] };

beforeEach(() => resetListenCopyForTests(true));

describe("which file a listener downloads", () => {
  it("is the Opus copy first and the original last when listening and the track offers one", () => {
    expect(planListenSources(track, { listen: true, supported: true })).toEqual([
      { url: copy.url, rendition: "copy" },
      { url: original.url, rendition: "original" },
    ]);
  });

  it("is the original alone when not listening: the studio and every caller that does not ask", () => {
    expect(planListenSources(track, { listen: false, supported: true })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
  });

  it("is the original alone when the server offers no list (flag off, no copy yet, a failed copy)", () => {
    expect(planListenSources({ audioUrl: original.url }, { listen: true, supported: true })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
    expect(planListenSources({ audioUrl: original.url, audioSources: [] }, { listen: true, supported: true })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
  });

  it("is the original alone when the browser says it cannot play Opus in Ogg: no wasted bytes", () => {
    expect(planListenSources(track, { listen: true, supported: false })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
    resetListenCopyForTests(false);
    expect(planListenSources(track, { listen: true })).toEqual([{ url: original.url, rendition: "original" }]);
  });

  it("ignores what it does not understand and still ends with the original: another codec, a malformed entry, a non-list", () => {
    const odd = [
      null,
      { url: 3, contentType: "audio/ogg", codec: "opus", bytes: 1 },
      { url: "https://x/y.m4a", contentType: "audio/mp4", codec: "aac", bytes: 1 },
      { url: "", contentType: "audio/ogg", codec: "opus", bytes: 1 },
    ] as unknown as JamAudioSource[];
    expect(planListenSources({ audioUrl: original.url, audioSources: odd }, { listen: true, supported: true })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
    expect(
      planListenSources({ audioUrl: original.url, audioSources: "nope" as unknown as JamAudioSource[] }, { listen: true, supported: true }),
    ).toEqual([{ url: original.url, rendition: "original" }]);
  });

  it("a decode failure rules copies out for the rest of the page, a failed fetch does not", () => {
    noteListenCopyFailure(new Error("jam: fetch 404"));
    noteListenCopyFailure(new TypeError("Failed to fetch"));
    noteListenCopyFailure(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(listenCopiesDisabled()).toBe(false);
    expect(planListenSources(track, { listen: true, supported: true })[0]!.rendition).toBe("copy");

    noteListenCopyFailure(Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" }));
    expect(listenCopiesDisabled()).toBe(true);
    expect(planListenSources(track, { listen: true, supported: true })).toEqual([
      { url: original.url, rendition: "original" },
    ]);
  });
});
