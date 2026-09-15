import { describe, expect, it } from "vitest";
import {
  LIVE_HLS_MODE_LL,
  LIVE_HLS_MODE_PARAM,
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

  it("carries the presenter's camera as an OPTIONAL second playlist", () => {
    // Optional is the compatibility promise. iOS and Android parse this frame
    // and know nothing about a camera; a required field would fail their parse
    // and take the whole frame — and therefore the film — with it.
    expect(liveHlsStreamSchema.parse(stream).cameraHlsUrl).toBeUndefined();
    expect(
      liveHlsStreamSchema.parse({
        ...stream,
        cameraHlsUrl:
          "/api/voice/hls-playlist/00000000-0000-4000-8000-0000000000aa/1725000000000/cam360p30?t=x",
      }).cameraHlsUrl,
    ).toContain("cam360p30");
    // An empty string is a URL nothing can play, and a PiP that renders a
    // player for it is worse than no PiP.
    expect(() =>
      liveHlsStreamSchema.parse({ ...stream, cameraHlsUrl: "" }),
    ).toThrow();
  });

  it("mode is absent by default and OPTIONAL, meaning conventional", () => {
    // `docs/plans/LL_HLS.md` L1.5: every session before this field existed
    // omits it, and a client that has never heard of LL-HLS must keep
    // treating an absent `mode` as the conventional ladder it always was.
    expect(liveHlsStreamSchema.parse(stream).mode).toBeUndefined();
  });

  it("accepts the ll mode a pqp-remux session sets", () => {
    expect(
      liveHlsStreamSchema.parse({ ...stream, mode: "ll" }).mode,
    ).toBe("ll");
  });

  it("carries partTargetMs, so a player sizes its buffer to the session, not to a guess", () => {
    expect(
      liveHlsStreamSchema.parse({ ...stream, mode: "ll", partTargetMs: 500 })
        .partTargetMs,
    ).toBe(500);
  });

  it("partTargetMs is optional and must be a positive integer when present", () => {
    // Optional: iOS and Android parse the frame and may ignore it, and a
    // conventional session has no parts at all. Positive integer: it is a
    // millisecond cadence, and a client derives its whole live-edge target
    // from it (`validPartTargetMs` in the web client re-checks the band on
    // top of this, because the client does not run the schema).
    expect(liveHlsStreamSchema.parse(stream).partTargetMs).toBeUndefined();
    expect(() =>
      liveHlsStreamSchema.parse({ ...stream, partTargetMs: 0 }),
    ).toThrow();
    expect(() =>
      liveHlsStreamSchema.parse({ ...stream, partTargetMs: -500 }),
    ).toThrow();
    expect(() =>
      liveHlsStreamSchema.parse({ ...stream, partTargetMs: 500.5 }),
    ).toThrow();
  });

  it("names the URL marker that makes the edge serve the LL master", () => {
    // Two literals the edge Worker ports rather than imports
    // (`tools/hls-edge/src/playlist-route.ts`, which deploys separately).
    // Renaming either side without the other is what this pins: the whole
    // point of the marker is that the delivery mode is STATED, and a
    // mismatched name is a statement nobody hears.
    expect(LIVE_HLS_MODE_PARAM).toBe("mode");
    expect(LIVE_HLS_MODE_LL).toBe("ll");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      liveHlsStreamSchema.parse({ ...stream, mode: "srt" }),
    ).toThrow();
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
