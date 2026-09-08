import { describe, expect, it } from "vitest";
import {
  liveHlsStreamSchema,
  playlistLooksLive,
  voiceStreamMessageSchema,
} from "./live-hls.js";

const stream = {
  hlsUrl: "https://live.example.test/live/room/1/live.m3u8",
  startedAt: 1_725_000_000_000,
  presenterPeerId: "peer-1",
  delaySeconds: 10,
};

describe("voice-stream is an optional addition to the wire", () => {
  it("accepts a live playlist", () => {
    const parsed = voiceStreamMessageSchema.parse({
      type: "voice-stream",
      channelId: "00000000-0000-4000-8000-0000000000aa",
      stream,
    });
    expect(parsed.stream?.hlsUrl).toBe(stream.hlsUrl);
  });

  it("accepts a stop", () => {
    const parsed = voiceStreamMessageSchema.parse({
      type: "voice-stream",
      channelId: "00000000-0000-4000-8000-0000000000aa",
      stream: null,
    });
    expect(parsed.stream).toBeNull();
  });

  it("rejects an empty playlist URL", () => {
    expect(() =>
      liveHlsStreamSchema.parse({
        ...stream,
        hlsUrl: "",
      }),
    ).toThrow();
  });

  it("accepts an API-relative path, not just a full URL", () => {
    // `LIVE_HLS_SIGNED_URLS=true` (the default) hands the client a path to
    // the signed playlist proxy rather than the raw bucket URL -- the
    // client prefixes it with its own API base URL. See
    // `client/src/lib/hls-playback.ts#resolveHlsUrl`.
    const parsed = liveHlsStreamSchema.parse({
      ...stream,
      hlsUrl: "/api/voice/hls-playlist/00000000-0000-4000-8000-0000000000aa/1725000000000",
    });
    expect(parsed.hlsUrl).toBe(
      "/api/voice/hls-playlist/00000000-0000-4000-8000-0000000000aa/1725000000000",
    );
  });
});

describe("playlistLooksLive", () => {
  it("accepts a sliding live window", () => {
    expect(
      playlistLooksLive(
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\n1.ts\n",
      ),
    ).toBe(true);
  });

  it("accepts a MASTER playlist, which has no #EXTINF at all", () => {
    // The failure this exists for: a master is a list of variants and
    // nothing else, so an #EXTINF-only test says "not live" about every
    // ladder stream forever and the stage keeps WebRTC while re-polling
    // once a second. Seen on the local stack, not in a unit test.
    expect(
      playlistLooksLive(
        "#EXTM3U\n#EXT-X-VERSION:3\n" +
          '#EXT-X-STREAM-INF:BANDWIDTH=2217200,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2"\n' +
          "/api/voice/hls-playlist/c/1/720p30\n",
      ),
    ).toBe(true);
  });

  it("rejects a finished share and an empty file", () => {
    expect(
      playlistLooksLive(
        "#EXTM3U\n#EXTINF:2.000,\n1.ts\n#EXT-X-ENDLIST\n",
      ),
    ).toBe(false);
    expect(playlistLooksLive("#EXTM3U\n")).toBe(false);
    // A master with no variants in it is not a stream either.
    expect(playlistLooksLive("#EXTM3U\n#EXT-X-VERSION:3\n")).toBe(false);
  });
});
