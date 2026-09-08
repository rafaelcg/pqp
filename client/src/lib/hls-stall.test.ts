import { describe, expect, it } from "vitest";
import { HlsStallWatch, channelIdFromHlsUrl } from "./hls-stall";

const T0 = 1_000_000;

describe("HlsStallWatch", () => {
  it("is quiet while the picture plays and the playlist advances", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    watch.onMediaSequence(10, T0);
    watch.onPlaying();
    watch.onMediaSequence(11, T0 + 2_000);
    watch.onMediaSequence(12, T0 + 4_000);
    expect(watch.tick(T0 + 5_000)).toBe("none");
    expect(watch.tick(T0 + 14_000)).toBe("none");
  });

  it("reconnects after 8 s of waiting with no playing", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    watch.onWaiting(T0 + 1_000);
    expect(watch.tick(T0 + 8_000)).toBe("none");
    expect(watch.tick(T0 + 9_000)).toBe("reconnect");
    expect(watch.lastReason).toBe("stall");
  });

  it("a playing event before the deadline cancels the stall", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    watch.onWaiting(T0);
    watch.onPlaying();
    expect(watch.tick(T0 + 20_000)).toBe("none");
  });

  it("reconnects when EXT-X-MEDIA-SEQUENCE sits still for 15 s (dead egress, live playlist)", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    watch.onPlaying();
    watch.onMediaSequence(40, T0);
    watch.onMediaSequence(40, T0 + 5_000);
    watch.onMediaSequence(40, T0 + 10_000);
    expect(watch.tick(T0 + 14_000)).toBe("none");
    expect(watch.tick(T0 + 15_000)).toBe("reconnect");
    expect(watch.lastReason).toBe("sequence-stuck");
  });

  it("reconnects on the next tick after a fatal hls.js error, ignores non-fatal ones", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    watch.onError({ fatal: false });
    expect(watch.tick(T0 + 100)).toBe("none");
    watch.onError({ fatal: true });
    expect(watch.tick(T0 + 200)).toBe("reconnect");
    expect(watch.lastReason).toBe("fatal");
    // consumed: the new source starts clean
    expect(watch.tick(T0 + 300)).toBe("none");
  });

  it("declares the stream dead after three reconnects in five minutes, then a reset starts over", () => {
    const watch = new HlsStallWatch();
    watch.onSourceChanged(T0);
    let now = T0;
    for (let i = 0; i < 3; i += 1) {
      watch.onError({ fatal: true });
      now += 10_000;
      expect(watch.tick(now)).toBe("reconnect");
    }
    watch.onError({ fatal: true });
    now += 10_000;
    expect(watch.tick(now)).toBe("dead");
    // still dead on the next tick, no fourth attempt is counted
    expect(watch.tick(now + 1_000)).toBe("dead");

    watch.reset(now + 2_000);
    watch.onError({ fatal: true });
    expect(watch.tick(now + 3_000)).toBe("reconnect");
  });

  it("forgets reconnects older than the window", () => {
    const watch = new HlsStallWatch({ windowMs: 60_000 });
    let now = T0;
    for (let i = 0; i < 3; i += 1) {
      watch.onError({ fatal: true });
      now += 1_000;
      expect(watch.tick(now)).toBe("reconnect");
    }
    watch.onError({ fatal: true });
    expect(watch.tick(now + 61_000)).toBe("reconnect");
  });
});

describe("channelIdFromHlsUrl", () => {
  it("reads the signed proxy path", () => {
    expect(
      channelIdFromHlsUrl(
        "http://localhost:3001/api/voice/hls-playlist/abc-123/1757000000000?t=x.y",
      ),
    ).toBe("abc-123");
  });

  it("reads the raw bucket URL", () => {
    expect(
      channelIdFromHlsUrl("https://live.example/pqp-live/live/abc-123/1757.m3u8"),
    ).toBe("abc-123");
  });

  it("is null for anything else", () => {
    expect(channelIdFromHlsUrl("https://example.com/x.m3u8")).toBeNull();
  });
});
