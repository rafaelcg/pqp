import { describe, expect, it } from "vitest";
import { HlsStallWatch, channelIdFromHlsUrl, type HlsStallDecision } from "./hls-stall";

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

  describe("the fatal ladder", () => {
    it("walks recover-media-error, start-load, reload-level, then repeats", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onError({ fatal: true });
      expect(watch.tick(T0 + 100)).toBe("recover-media-error");
      expect(watch.lastReason).toBe("fatal");
      expect(watch.tick(T0 + 200)).toBe("start-load");
      expect(watch.tick(T0 + 300)).toBe("reload-level");
      // A second cycle: the first one did not clear the error.
      expect(watch.tick(T0 + 400)).toBe("recover-media-error");
      expect(watch.tick(T0 + 500)).toBe("start-load");
      expect(watch.tick(T0 + 600)).toBe("reload-level");
      // A third.
      expect(watch.tick(T0 + 700)).toBe("recover-media-error");
      expect(watch.tick(T0 + 800)).toBe("start-load");
      expect(watch.tick(T0 + 900)).toBe("reload-level");
      // Three full cycles with no recovery: only now a full rebuild.
      expect(watch.tick(T0 + 1_000)).toBe("rebuild");
    });

    it("a fatal error that clears on its own stops the ladder", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onError({ fatal: true });
      expect(watch.tick(T0 + 100)).toBe("recover-media-error");
      watch.onPlaying();
      expect(watch.tick(T0 + 200)).toBe("none");
    });

    it("a MEDIA_ERR_DECODE that recoverMediaError does not clear skips straight to rebuild", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onNativeMediaError({ decode: true });
      expect(watch.tick(T0 + 100)).toBe("recover-media-error");
      expect(watch.tick(T0 + 200)).toBe("rebuild");
    });

    it("a native media error that is not a decode failure gets the ordinary ladder", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onNativeMediaError({ decode: false });
      expect(watch.tick(T0 + 100)).toBe("recover-media-error");
      expect(watch.tick(T0 + 200)).toBe("start-load");
      expect(watch.tick(T0 + 300)).toBe("reload-level");
    });
  });

  describe("the stall ladder (buffering, no fatal error)", () => {
    it("skips recover-media-error -- there is no media error to recover from", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onWaiting(T0 + 1_000);
      expect(watch.tick(T0 + 8_000)).toBe("none");
      expect(watch.tick(T0 + 9_000)).toBe("start-load");
      expect(watch.lastReason).toBe("stall");
      expect(watch.tick(T0 + 9_500)).toBe("reload-level");
      expect(watch.tick(T0 + 10_000)).toBe("start-load");
      expect(watch.tick(T0 + 10_500)).toBe("reload-level");
      expect(watch.tick(T0 + 11_000)).toBe("start-load");
      expect(watch.tick(T0 + 11_500)).toBe("reload-level");
      // Three cycles of the shorter ladder, then a rebuild.
      expect(watch.tick(T0 + 12_000)).toBe("rebuild");
    });

    it("a playing event before the deadline cancels the stall", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onWaiting(T0);
      watch.onPlaying();
      expect(watch.tick(T0 + 20_000)).toBe("none");
    });
  });

  describe("sequence-stuck (a dead egress, live playlist)", () => {
    it("walks its own three-step in-place ladder, then only ever asks to reconnect", () => {
      // Segments are 4 s, so the sequence legitimately advances only every
      // 4 s; 20 s is comfortably above two segments of ordinary jitter.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 19_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
      expect(watch.lastReason).toBe("sequence-stuck");
      expect(watch.tick(T0 + 21_000)).toBe("restart-load");
      expect(watch.tick(T0 + 22_000)).toBe("reload-level");
      // The in-place ladder is spent; a client rebuild cannot invent
      // segments the server never wrote, so this asks to check the server
      // instead of rebuilding blind, and keeps asking for as long as the
      // egress stays stuck -- never "dead" on its own.
      expect(watch.tick(T0 + 23_000)).toBe("reconnect");
      expect(watch.tick(T0 + 24_000)).toBe("reconnect");
      expect(watch.tick(T0 + 5 * 60_000)).toBe("reconnect");
    });

    it("resolves cleanly once the sequence actually moves again", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
      // The egress watchdog restarted things and the playlist moved on.
      watch.onMediaSequence(41, T0 + 21_000);
      expect(watch.tick(T0 + 21_500)).toBe("none");
    });
  });

  describe("the dead gate", () => {
    it("declares the stream dead once repeated full-ladder cycles have not helped", () => {
      const watch = new HlsStallWatch({ maxRebuilds: 2 });
      watch.onSourceChanged(T0);
      watch.onError({ fatal: true });
      let now = T0;
      let decision: HlsStallDecision = "none";
      // Two rebuild-worthy signals are tolerated (`maxRebuilds`); the third
      // inside the window is what declares the stream dead.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (let i = 0; i < 10; i += 1) {
          now += 1_000;
          decision = watch.tick(now);
        }
        expect(decision).toBe("rebuild");
      }
      // The caller chose not to actually rebuild either time (B1.3: nothing
      // new from the server) -- the same fatal condition is still pending,
      // so a fresh ladder walk starts each time and reaches the gate again
      // ten ticks later.
      for (let i = 0; i < 10; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
      }
      expect(decision).toBe("dead");
      expect(watch.tick(now + 1_000)).toBe("dead");

      watch.reset(now + 2_000);
      now += 2_000;
      watch.onError({ fatal: true });
      for (let i = 0; i < 9; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
      }
      expect(decision).not.toBe("rebuild");
      now += 1_000;
      expect(watch.tick(now)).toBe("rebuild");
    });

    it("forgets a rebuild signal once it falls outside the window", () => {
      const watch = new HlsStallWatch({ windowMs: 20_000, maxRebuilds: 2 });
      watch.onSourceChanged(T0);
      watch.onError({ fatal: true });
      let now = T0;
      let decision: HlsStallDecision = "none";
      for (let i = 0; i < 10; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
      }
      expect(decision).toBe("rebuild");

      // The stream actually recovered in between, unlike the "dead" case
      // above, and enough time passes that the first signal ages out.
      watch.onPlaying();
      now += 25_000;
      watch.onError({ fatal: true });
      for (let i = 0; i < 10; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
      }
      expect(decision).toBe("rebuild");
    });

    it("sequence-stuck never reaches dead, however long it repeats", () => {
      const watch = new HlsStallWatch({ maxRebuilds: 1, windowMs: 10_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(1, T0);
      let now = T0;
      let decision: HlsStallDecision = "none";
      for (let i = 0; i < 40; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
      }
      expect(decision).toBe("reconnect");
      expect(decision).not.toBe("dead");
    });
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
