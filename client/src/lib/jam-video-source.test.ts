import type { JamTrack } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { pickJamVideoUrl, playTypeFor } from "./jam-video-source";

const MP4 = { url: "https://bucket/jam/s/t.ios.mp4?sig", contentType: "video/mp4", bytes: 10 };
const WEBM = { url: "https://bucket/jam/s/t.webm?sig", contentType: "video/webm", bytes: 20 };

const track = (over: Partial<Pick<JamTrack, "videoUrl" | "videoSources">>) => ({
  videoUrl: MP4.url,
  videoSources: [MP4, WEBM],
  ...over,
});

/** What `canPlayType` says on each kind of browser, to the types `playTypeFor` asks about. */
const chrome = (type: string) => (type.startsWith("video/webm") || type.startsWith("video/mp4") ? "probably" : "");
const safari = (type: string) => (type.startsWith("video/mp4") ? "probably" : "");
const webmOnly = (type: string) => (type.startsWith("video/webm") ? "maybe" : "");

describe("pickJamVideoUrl", () => {
  it("gives Safari and iOS the MP4 copy, which is what it exists for", () => {
    expect(pickJamVideoUrl(track({}), safari)).toBe(MP4.url);
  });

  it("gives Chrome the first listed file it can play, the copy", () => {
    expect(pickJamVideoUrl(track({}), chrome)).toBe(MP4.url);
  });

  it("falls to the recorded file in a browser without H.264 (Chromium builds)", () => {
    expect(pickJamVideoUrl(track({}), webmOnly)).toBe(WEBM.url);
  });

  it("before the copy exists the list has the recorded file only, and Safari is handed it anyway (nothing else to try)", () => {
    expect(pickJamVideoUrl(track({ videoUrl: WEBM.url, videoSources: [WEBM] }), safari)).toBe(WEBM.url);
  });

  it("hands the first file over when the browser says no to all, as it always did", () => {
    expect(pickJamVideoUrl(track({}), () => "")).toBe(MP4.url);
  });

  it("reads videoUrl alone from a server that sends no list, and null for no video", () => {
    expect(pickJamVideoUrl({ videoUrl: WEBM.url }, chrome)).toBe(WEBM.url);
    expect(pickJamVideoUrl({ videoUrl: null, videoSources: [] }, chrome)).toBeNull();
    expect(pickJamVideoUrl({ videoUrl: null }, chrome)).toBeNull();
  });

  it("survives a canPlayType that throws", () => {
    const throwing = (type: string) => {
      if (type.startsWith("video/mp4")) throw new Error("nope");
      return "probably";
    };
    expect(pickJamVideoUrl(track({}), throwing)).toBe(WEBM.url);
  });

  it("names the codecs of the copy when it asks, and nothing else about a WebM", () => {
    expect(playTypeFor("video/mp4")).toBe('video/mp4; codecs="avc1.4D401E, mp4a.40.2"');
    expect(playTypeFor("video/webm;codecs=vp9,opus")).toBe("video/webm");
  });
});
