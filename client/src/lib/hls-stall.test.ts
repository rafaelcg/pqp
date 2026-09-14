import { describe, expect, it } from "vitest";
import { HlsStallWatch, channelIdFromHlsUrl, type HlsStallDecision } from "./hls-stall";
import { resolveHoldingScreenReason } from "./watch-holding-screen";

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
    it("walks its own three-step in-place ladder, then asks to reconnect on a backoff", () => {
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
      // instead of rebuilding blind on the same dead source.
      expect(watch.tick(T0 + 23_000)).toBe("reconnect");
      // Bounded (Farol review, PR 570): the very next tick does NOT ask
      // again -- it backs off (2 s the first time) rather than firing once
      // per tick for as long as the stall lasts.
      expect(watch.tick(T0 + 24_000)).toBe("none");
      expect(watch.tick(T0 + 24_999)).toBe("none");
      expect(watch.tick(T0 + 25_000)).toBe("reconnect");
      // The backoff doubles each time (4 s next), not a flat retry.
      expect(watch.tick(T0 + 26_000)).toBe("none");
      expect(watch.tick(T0 + 29_000)).toBe("reconnect");
    });

    it("gives up and reports dead once the reconnect budget is spent", () => {
      // A short budget so the test does not have to simulate minutes of
      // ticks: two checks, a 1 s base backoff, capped at 2 s.
      const watch = new HlsStallWatch({
        maxReconnects: 2,
        reconnectBackoffMs: 1_000,
        reconnectBackoffMaxMs: 2_000,
      });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
      expect(watch.tick(T0 + 20_100)).toBe("restart-load");
      expect(watch.tick(T0 + 20_200)).toBe("reload-level");
      expect(watch.tick(T0 + 20_300)).toBe("reconnect"); // attempt 1, 1 s backoff
      expect(watch.tick(T0 + 21_300)).toBe("reconnect"); // attempt 2, 2 s backoff (capped)
      expect(watch.tick(T0 + 22_000)).toBe("none"); // still waiting out attempt 2's backoff
      expect(watch.tick(T0 + 23_300)).toBe("dead"); // budget spent, still stuck
      // A person's own "try again" is the only way out from here.
      expect(watch.tick(T0 + 90_000)).toBe("dead");
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

    it("a genuine reattach resets the reconnect budget for the new session", () => {
      const watch = new HlsStallWatch({
        maxReconnects: 1,
        reconnectBackoffMs: 1_000,
      });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
      expect(watch.tick(T0 + 20_100)).toBe("restart-load");
      expect(watch.tick(T0 + 20_200)).toBe("reload-level");
      expect(watch.tick(T0 + 20_300)).toBe("reconnect"); // the one allowed attempt
      expect(watch.tick(T0 + 21_300)).toBe("dead"); // budget of 1 spent

      // A new session actually showed up (the player adopted it): a fresh
      // episode gets a fresh budget rather than inheriting the exhausted one.
      const T1 = T0 + 30_000;
      watch.onSourceChanged(T1);
      watch.onPlaying();
      watch.onMediaSequence(50, T1);
      expect(watch.tick(T1 + 20_000)).toBe("start-load");
      expect(watch.tick(T1 + 20_100)).toBe("restart-load");
      expect(watch.tick(T1 + 20_200)).toBe("reload-level");
      expect(watch.tick(T1 + 20_300)).toBe("reconnect");
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

    it("sequence-stuck ignores the rebuild gate but is bounded by its own reconnect budget", () => {
      // `maxRebuilds: 1` would declare a fatal/stall episode dead almost
      // immediately; sequence-stuck never rebuilds at all, so that gate
      // does not apply to it -- but it is still bounded, by
      // `maxReconnects`/backoff instead (Farol review, PR 570), not left to
      // repeat forever.
      const watch = new HlsStallWatch({
        maxRebuilds: 1,
        windowMs: 10_000,
        maxReconnects: 3,
        reconnectBackoffMs: 1_000,
        reconnectBackoffMaxMs: 1_000,
      });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(1, T0);
      let now = T0;
      let decision: HlsStallDecision = "none";
      const decisions: HlsStallDecision[] = [];
      for (let i = 0; i < 40; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
        decisions.push(decision);
      }
      // Reaches "dead" well before 40 ticks (three bounded attempts, not an
      // endless "reconnect"), and never "rebuild" -- a client rebuild
      // cannot invent segments the server never wrote.
      expect(decisions).toContain("dead");
      expect(decisions).not.toContain("rebuild");
      expect(decision).toBe("dead");
    });
  });

  describe("a VOD replay whose fragments keep failing (Farol review, PR 573)", () => {
    it("reaches the ladder's terminal decision, and the holding screen calls it unavailable rather than lingering on a spinner", () => {
      // `HlsStallWatch` has no concept of `mode`/`isVod` at all -- `isVod`
      // only changes what the PLAYER does with each decision (skip the
      // live-edge seek in the recovery step, skip the live-channel refetch
      // in `reconnect()`), never whether the ladder itself escalates. A
      // replay whose fragments never load is exactly the live case's
      // "stall" reason: repeated `onWaiting` with no `onPlaying` to cancel
      // it. This pins that the escalation reaches its bound regardless, and
      // that the terminal `"dead"` decision maps to the VOD-specific
      // "gravação não está mais disponível" copy, not a stuck spinner.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onWaiting(T0 + 1_000);
      let now = T0;
      let decision: HlsStallDecision = "none";
      const decisions: HlsStallDecision[] = [];
      // Generous headroom (60 one-second ticks); the assertions below check
      // it actually stops well short of that rather than looping forever.
      for (let i = 0; i < 60 && decision !== "dead"; i += 1) {
        now += 1_000;
        decision = watch.tick(now);
        decisions.push(decision);
      }
      expect(decision).toBe("dead");
      // Got there via at least one full rebuild cycle, not a short-circuit
      // straight to dead -- a transient failure still gets its rebuild
      // before the player gives up on it.
      expect(decisions).toContain("rebuild");
      expect(watch.lastReason).toBe("stall");

      // The terminal state a VOD player actually shows: never the live
      // "restarting"/"reconnecting" vocabulary, and never `null` (nothing
      // wrong) -- "unavailable", the retry-button state.
      expect(
        resolveHoldingScreenReason({
          phase: "dead",
          hasFrame: false,
          stallReason: watch.lastReason,
          authGraceActive: false,
          mode: "vod",
        }),
      ).toBe("unavailable");
    });
  });

  describe("configureForMode (LL-HLS, docs/plans/LL_HLS.md §5)", () => {
    it("leaves the constructed default untouched when never called -- byte-identical conventional behaviour", () => {
      // 20s (the constructed default): a sequence stuck for 19s must NOT
      // fire, and one stuck for 20s must.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      expect(watch.tick(T0 + 19_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
    });

    it("scales the sequence-stuck threshold to six parts on ll", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      // Six parts at 500ms = 3000ms -- far under the conventional 20s.
      expect(watch.tick(T0 + 2_999)).toBe("none");
      expect(watch.tick(T0 + 3_000)).toBe("start-load");
    });

    it("restores the constructed default on conventional after an ll episode", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.configureForMode("conventional");
      expect(watch.tick(T0 + 3_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("start-load");
    });

    it("defaults the part target when omitted on ll", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll");
      // 6 * 500ms (LL_HLS_DEFAULT_PART_TARGET_MS) = 3000ms.
      expect(watch.tick(T0 + 2_999)).toBe("none");
      expect(watch.tick(T0 + 3_000)).toBe("start-load");
    });

    it("does not disturb an explicitly configured sequenceStuckMs's restore value", () => {
      const watch = new HlsStallWatch({ sequenceStuckMs: 9_000 });
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.configureForMode("conventional");
      expect(watch.tick(T0 + 8_999)).toBe("none");
      expect(watch.tick(T0 + 9_000)).toBe("start-load");
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
