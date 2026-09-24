import { describe, expect, it } from "vitest";
import {
  HLS_WATCH_PLAYER_STALL_MS,
  HlsStallWatch,
  NATIVE_LIVE_STALL_MS,
  channelIdFromHlsUrl,
  livePlaylistProgress,
  type HlsStallDecision,
} from "./hls-stall";
import { resolveHoldingScreenReason } from "./watch-holding-screen";
import { LL_HLS_STARTUP_GRACE_MS } from "./hls-live-edge";

const T0 = 1_000_000;
/** The LL startup grace, which every part-rule assertion has to clear. */
const GRACE = LL_HLS_STARTUP_GRACE_MS;

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

  describe("the watch player's stallMs", () => {
    it("gives a merely-slow source longer than the class default before reload-level fires", () => {
      // 2026-09-14: a CPU-saturated egress fell behind for stretches short
      // enough to self-recover, and the class default (8 s) escalated to
      // `HlsStallWatch`'s heavier `reload-level` step before it had the
      // chance -- the visible "stream repeats itself for a few seconds"
      // report. `HLS_WATCH_PLAYER_STALL_MS` is what `hls-watch-player.tsx`
      // actually constructs the watchdog with; this pins that it is wider
      // than the class default rather than accidentally matching it, and
      // that a stall which resolves inside that widened window never
      // reaches the ladder at all.
      const now = T0 + HLS_WATCH_PLAYER_STALL_MS - 1;
      const defaultWatch = new HlsStallWatch();
      defaultWatch.onSourceChanged(T0);
      defaultWatch.onWaiting(T0);
      expect(defaultWatch.tick(now)).not.toBe("none");

      const widened = new HlsStallWatch({ stallMs: HLS_WATCH_PLAYER_STALL_MS });
      widened.onSourceChanged(T0);
      widened.onWaiting(T0);
      expect(widened.tick(now)).toBe("none");

      // Recovers cleanly once playback resumes inside the wider window --
      // no leftover ladder state to trip a later, unrelated stall.
      widened.onPlaying();
      expect(widened.tick(now + 1)).toBe("none");
    });
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
    it("conventional: holds once then reconnects — never the start-load ladder (restart dead window)", () => {
      // 2026-09-15: during an egress restart the in-place start-load /
      // restart-load / reload-level ladder hammered a dying playlist at
      // ~1 Hz and re-downloaded the last segment into a 1–2 s loop. The
      // server is already restarting; the client only needs to hold and
      // poll for a fresh master. This must fail without the hold path.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 19_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("hold");
      expect(watch.lastReason).toBe("sequence-stuck");
      // Second tick: reconnect, not another in-place recovery step.
      expect(watch.tick(T0 + 21_000)).toBe("reconnect");
      // Bounded (Farol review, PR 570): the very next tick does NOT ask
      // again -- it backs off (2 s the first time) rather than firing once
      // per tick for as long as the stall lasts.
      expect(watch.tick(T0 + 22_000)).toBe("none");
      expect(watch.tick(T0 + 22_999)).toBe("none");
      expect(watch.tick(T0 + 23_000)).toBe("reconnect");
      // Never walks the hammering ladder during a conventional hold.
      const decisions: HlsStallDecision[] = [];
      const storm = new HlsStallWatch();
      storm.onSourceChanged(T0);
      storm.onPlaying();
      storm.onMediaSequence(40, T0);
      for (let t = T0 + 20_000; t <= T0 + 40_000; t += 1_000) {
        decisions.push(storm.tick(t));
      }
      expect(decisions).toContain("hold");
      expect(decisions).toContain("reconnect");
      expect(decisions).not.toContain("start-load");
      expect(decisions).not.toContain("restart-load");
      expect(decisions).not.toContain("reload-level");
      expect(decisions).not.toContain("rebuild");
    });

    it("ll: still walks the three-step in-place ladder, then reconnects on a backoff", () => {
      // PR 650: do not fold the conventional hold into LL. LL keeps the
      // older ladder; only conventional skips it for the restart window.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      watch.configureForMode("ll", 500);
      // NO part has ever advanced, which is what a genuinely dead LL feed
      // looks like and is the only state the backstop speaks in since
      // 2026-09-16: a part arriving is proof the stream is alive, so this
      // rule stays quiet while they do (see `partsAdvancing`). The claim
      // under test is unchanged -- LL keeps the in-place ladder rather than
      // the conventional hold -- and the pre-manifest threshold is 12 s.
      expect(watch.tick(T0 + 11_999)).toBe("none");
      expect(watch.tick(T0 + 12_000)).toBe("start-load");
      expect(watch.lastReason).toBe("sequence-stuck");
      expect(watch.tick(T0 + 13_000)).toBe("restart-load");
      expect(watch.tick(T0 + 14_000)).toBe("reload-level");
      expect(watch.tick(T0 + 15_000)).toBe("reconnect");
      expect(watch.tick(T0 + 16_000)).toBe("none");
    });

    it("playlist-gone holds immediately without waiting out sequenceStuckMs", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      // A 404 on the master arrives well before the 20 s sequence-stuck
      // threshold — that is the restart dead window's leading edge.
      watch.onPlaylistGone();
      expect(watch.tick(T0 + 500)).toBe("hold");
      expect(watch.lastReason).toBe("playlist-gone");
      expect(watch.tick(T0 + 1_500)).toBe("reconnect");
      // Still no hammering ladder.
      expect(watch.tick(T0 + 2_500)).toBe("none");
      const decisions: HlsStallDecision[] = [];
      for (let t = T0 + 3_500; t <= T0 + 20_000; t += 1_000) {
        decisions.push(watch.tick(t));
      }
      expect(decisions).not.toContain("start-load");
      expect(decisions).not.toContain("restart-load");
      expect(decisions).not.toContain("reload-level");
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
      expect(watch.tick(T0 + 20_000)).toBe("hold");
      expect(watch.tick(T0 + 20_100)).toBe("reconnect"); // attempt 1, 1 s backoff
      expect(watch.tick(T0 + 21_100)).toBe("reconnect"); // attempt 2, 2 s backoff (capped)
      expect(watch.tick(T0 + 22_000)).toBe("none"); // still waiting out attempt 2's backoff
      expect(watch.tick(T0 + 23_100)).toBe("dead"); // budget spent, still stuck
      // A person's own "try again" is the only way out from here.
      expect(watch.tick(T0 + 90_000)).toBe("dead");
    });

    it("a window that is still growing is progress, not a dead egress", () => {
      // The proxy widens the egress's five-segment window from what each
      // process has seen, so for the first 15 segments (60 s at 4 s) of a
      // session, and again after an API restart, EXT-X-MEDIA-SEQUENCE
      // (`startSN`) sits still while segments keep being appended. Fed
      // `startSN`, the watchdog held every viewer "for restart" at the
      // start of every party (2026-09-16). `livePlaylistProgress` is what
      // the player feeds instead: the newest segment number.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      for (let i = 0; i <= 8; i++) {
        watch.onMediaSequence(
          livePlaylistProgress({ startSN: 0, endSN: 4 + i }),
          T0 + i * 4_000,
        );
        expect(watch.tick(T0 + i * 4_000 + 500)).toBe("none");
      }
      // 32 s in, startSN has been 0 the whole time and nothing fired.
      expect(watch.lastReason).toBeNull();
    });

    it("a playlist whose newest segment stops is still a dead egress", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(livePlaylistProgress({ startSN: 0, endSN: 9 }), T0);
      // startSN even moves here (an old window entry aged out) and it must
      // not count: only the newest segment is progress.
      watch.onMediaSequence(
        livePlaylistProgress({ startSN: 1, endSN: 9 }),
        T0 + 4_000,
      );
      expect(watch.tick(T0 + 20_000)).toBe("hold");
      expect(watch.lastReason).toBe("sequence-stuck");
    });

    it("resolves cleanly once the sequence actually moves again", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 20_000)).toBe("hold");
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
      expect(watch.tick(T0 + 20_000)).toBe("hold");
      expect(watch.tick(T0 + 20_100)).toBe("reconnect"); // the one allowed attempt
      expect(watch.tick(T0 + 21_100)).toBe("dead"); // budget of 1 spent

      // A new session actually showed up (the player adopted it): a fresh
      // episode gets a fresh budget rather than inheriting the exhausted one.
      const T1 = T0 + 30_000;
      watch.onSourceChanged(T1);
      watch.onPlaying();
      watch.onMediaSequence(50, T1);
      expect(watch.tick(T1 + 20_000)).toBe("hold");
      expect(watch.tick(T1 + 20_100)).toBe("reconnect");
    });

    it("a stale playing during playlist-gone does not clear the hold (Farol, PR 654)", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onPlaylistGone();
      expect(watch.tick(T0 + 100)).toBe("hold");
      expect(watch.isHoldingForRestart).toBe(true);
      // Buffered media after stopLoad.
      watch.onPlaying();
      expect(watch.isHoldingForRestart).toBe(true);
      expect(watch.tick(T0 + 200)).toBe("reconnect");
    });

    it("playlist-gone clears on a real re-attach, then a later episode can hold again", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onPlaylistGone();
      expect(watch.tick(T0 + 100)).toBe("hold");
      watch.onSourceChanged(T0 + 150);
      watch.onPlaying();
      expect(watch.isHoldingForRestart).toBe(false);
      expect(watch.tick(T0 + 200)).toBe("none");
      watch.onPlaylistGone();
      expect(watch.tick(T0 + 300)).toBe("hold");
    });

    it("playlist-gone supersedes a pending fatal instead of walking the fatal ladder (Farol, PR 654)", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onError({ fatal: true });
      watch.onPlaylistGone();
      expect(watch.tick(T0 + 100)).toBe("hold");
      expect(watch.lastReason).toBe("playlist-gone");
      expect(watch.tick(T0 + 200)).toBe("reconnect");
      expect(watch.tick(T0 + 300)).toBe("none");
    });

    it("a media-sequence advance clears a conventional hold without a re-attach", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onMediaSequence(40, T0);
      expect(watch.tick(T0 + 20_000)).toBe("hold");
      expect(watch.isHoldingForRestart).toBe(true);
      watch.onMediaSequence(41, T0 + 21_000);
      expect(watch.isHoldingForRestart).toBe(false);
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

    it("sequence-stuck ignores the rebuild gate but is bounded by its own reconnect budget", () => {
      // `maxRebuilds: 1` would declare a fatal/stall episode dead almost
      // immediately; sequence-stuck never rebuilds at all, so that gate
      // does not apply to it -- but it is still bounded, by
      // `maxReconnects`/backoff instead (Farol review, PR 570), not left to
      // repeat forever. Conventional path: hold then reconnect, never the
      // in-place ladder.
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
      expect(decisions).toContain("hold");
      expect(decisions).not.toContain("rebuild");
      expect(decisions).not.toContain("start-load");
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
    it("leaves the constructed default untouched when never called -- byte-identical conventional hold behaviour", () => {
      // 20s (the constructed default): a sequence stuck for 19s must NOT
      // fire, and one stuck for 20s must. Conventional enters `"hold"`, not
      // the older start-load ladder.
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      expect(watch.tick(T0 + 19_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("hold");
    });

    it("scales the SEGMENT-based sequence-stuck threshold to 3 segments (12s at a 4s target), never to parts (Farol review)", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      // No part has ever advanced, so the backstop is the only rule that can
      // speak and its threshold is the one under test: a 500ms part target
      // must NOT shrink the SEGMENT threshold to a part-scaled number (the
      // bug this test guards against). It stays segment-paced at 12s until a
      // manifest says otherwise.
      expect(watch.tick(T0 + 11_999)).toBe("none");
      expect(watch.tick(T0 + 12_000)).toBe("start-load");
    });

    /**
     * PRODUCTION, 2026-09-16 00:50-00:56 UK. `pqp-remux` closes a video
     * segment only on an IDR (a PLI every 4s, answered in about a second),
     * so the live party's segments ran 5 to 9s under
     * `EXT-X-TARGETDURATION 7` while parts advanced every 0.5s. The flat 12s
     * this used to derive from `HLS_LIVE_SEGMENT_SECONDS` was under the
     * stream's own honest cadence, and the ladder spent six minutes seeking,
     * reloading, cancelling its own part downloads and rebuilding the
     * player.
     */
    it("takes its threshold from the manifest's own TARGETDURATION", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onManifestTiming({ targetDurationSeconds: 7, partTargetSeconds: 0.5 });
      // Three TARGETDURATIONs, not three of a constant that guessed 4s.
      expect(watch.tick(T0 + 12_000)).toBe("none");
      expect(watch.tick(T0 + 20_999)).toBe("none");
      expect(watch.tick(T0 + 21_000)).toBe("start-load");
    });

    /**
     * THE RULE ITSELF, and the reason the one above is only a backstop. A
     * part arriving is proof the stream is alive; `EXT-X-MEDIA-SEQUENCE`
     * moving is proof a SEGMENT closed, which on this remux is a different,
     * much slower thing.
     */
    it("never calls a stream stuck while parts keep arriving (9s segments, parts every 0.5s)", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onManifestTiming({ targetDurationSeconds: 7, partTargetSeconds: 0.5 });
      // Two minutes of the real cadence: a part every 500ms, a segment (and
      // so a media-sequence bump) every 9s.
      let sequence = 1;
      watch.onMediaSequence(sequence, T0);
      for (let t = T0; t <= T0 + 120_000; t += 500) {
        watch.onPartAdvance(`part-${t}`, t);
        if ((t - T0) % 9_000 === 0 && t > T0) {
          sequence += 1;
          watch.onMediaSequence(sequence, t);
        }
        expect(watch.tick(t)).toBe("none");
      }
    });

    it("still speaks once the parts stop too -- it is a backstop, not a mute", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onManifestTiming({ targetDurationSeconds: 7, partTargetSeconds: 0.5 });
      watch.onMediaSequence(1, T0);
      // Past the LL startup grace, so the soft rules are allowed to speak.
      watch.onPartAdvance("part-a", T0 + 7_000);
      watch.onWaiting(T0 + 7_000);
      // The part-stuck nudge fires once on the way (4s at a 0.5s target,
      // while waiting), and then the segment backstop takes over at three
      // TARGETDURATIONs.
      expect(watch.tick(T0 + 11_000)).toBe("start-load");
      expect(watch.lastReason).toBe("part-stuck");
      expect(watch.tick(T0 + 20_999)).toBe("none");
      expect(watch.tick(T0 + 21_000)).toBe("start-load");
      expect(watch.lastReason).toBe("sequence-stuck");
    });

    it("floors the segment-based threshold at 6s even for an absurdly short manifest", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      // One second of TARGETDURATION would be three seconds of threshold.
      // No part has ever advanced, so the backstop is the only rule in play.
      watch.onManifestTiming({ targetDurationSeconds: 1 });
      expect(watch.tick(T0 + 5_999)).toBe("none");
      expect(watch.tick(T0 + 6_000)).toBe("start-load");
      expect(watch.lastReason).toBe("sequence-stuck");
    });

    it("restores the constructed default on conventional after an ll episode", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.configureForMode("conventional");
      expect(watch.tick(T0 + 12_000)).toBe("none");
      expect(watch.tick(T0 + 20_000)).toBe("hold");
    });

    it("defaults the part target when omitted on ll", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll");
      // Segment-paced regardless of the (defaulted) part target: 12s until a
      // manifest arrives.
      expect(watch.tick(T0 + 11_999)).toBe("none");
      expect(watch.tick(T0 + 12_000)).toBe("start-load");
    });

    it("does not disturb an explicitly configured sequenceStuckMs's restore value", () => {
      const watch = new HlsStallWatch({ sequenceStuckMs: 9_000 });
      watch.onSourceChanged(T0);
      watch.onMediaSequence(1, T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.configureForMode("conventional");
      expect(watch.tick(T0 + 8_999)).toBe("none");
      expect(watch.tick(T0 + 9_000)).toBe("hold");
    });
  });

  describe("onBufferProgress: a waiting player still receiving media (2026-09-23)", () => {
    it("holds the stall rule while media keeps landing, up to twice the threshold", () => {
      const watch = new HlsStallWatch({ stallMs: 8_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onWaiting(T0);
      // A fragment landed 2 s ago: recovering, not stuck.
      watch.onBufferProgress(T0 + 6_000);
      expect(watch.tick(T0 + 8_000)).toBe("none");
      // Media stops landing: 5 s without progress releases the rule.
      expect(watch.tick(T0 + 11_000)).toBe("start-load");
      expect(watch.lastReason).toBe("stall");
    });

    it("still catches a wedge that keeps receiving media, at twice the threshold", () => {
      const watch = new HlsStallWatch({ stallMs: 8_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onWaiting(T0);
      for (let t = 1_000; t <= 16_000; t += 1_000) {
        watch.onBufferProgress(T0 + t);
        const decision = watch.tick(T0 + t);
        expect(decision).toBe(t < 16_000 ? "none" : "start-load");
      }
    });
  });

  describe("onPartAdvance / the part-stuck rule (Farol review, this PR)", () => {
    it("is disabled on conventional -- onPartAdvance alone never fires anything", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.onPartAdvance("10.0", T0);
      // Far past any part-based threshold that would apply on LL.
      expect(watch.tick(T0 + 60_000)).toBe("none");
    });

    it("fires exactly one start-load after 8 parts of silence while waiting on ll, then gets out of the way", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      // Past the startup grace, which is where this rule has anything to
      // say at all -- see its own describe block below.
      watch.onPartAdvance("10.0", T0 + GRACE);
      watch.onWaiting(T0 + GRACE);
      // 8 * 500ms = 4000ms.
      expect(watch.tick(T0 + GRACE + 3_999)).toBe("none");
      expect(watch.tick(T0 + GRACE + 4_000)).toBe("start-load");
      // One-shot: the SAME stall episode does not fire it again, and does
      // not escalate to a ladder of its own -- it stays "none" until the
      // segment-based rule's own (much later) threshold takes over.
      expect(watch.tick(T0 + GRACE + 4_500)).toBe("none");
      expect(watch.tick(T0 + GRACE + 11_000)).toBe("none");
    });

    it("never nudges a player that is still playing from its buffer (2026-09-23)", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onPartAdvance("10.0", T0 + GRACE);
      // No `waiting`: a late part is being ridden out as designed.
      expect(watch.tick(T0 + GRACE + 10_000)).toBe("none");
    });

    it("never nudges a viewer loading whole segments (LL-lite)", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onLlDelivery("segments");
      watch.onPartAdvance("10.0", T0 + GRACE);
      watch.onWaiting(T0 + GRACE);
      expect(watch.tick(T0 + GRACE + 10_000)).toBe("none");
    });

    it("re-arms for a later stall episode once a part actually advances", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onPartAdvance("10.0", T0 + GRACE);
      watch.onWaiting(T0 + GRACE);
      expect(watch.tick(T0 + GRACE + 4_000)).toBe("start-load");
      // A genuinely new part arrives -- the stream recovered.
      watch.onPartAdvance("10.1", T0 + GRACE + 4_100);
      expect(watch.tick(T0 + GRACE + 4_200)).toBe("none");
      // It stalls again from this new point: the one-shot fires again.
      expect(watch.tick(T0 + GRACE + 8_099)).toBe("none");
      expect(watch.tick(T0 + GRACE + 8_100)).toBe("start-load");
    });

    it("never fires while a segment-based reason is already flagged -- it only gets a turn when nothing else is", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onPartAdvance("10.0", T0);
      watch.onError({ fatal: true });
      // Fatal takes priority every tick, including the one where the
      // part-stuck threshold would otherwise have fired.
      expect(watch.tick(T0 + 2_000)).toBe("recover-media-error");
    });

    it("repeated calls with the SAME key are not progress", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onPartAdvance("10.0", T0 + GRACE);
      watch.onPartAdvance("10.0", T0 + GRACE + 1_000);
      watch.onPartAdvance("10.0", T0 + GRACE + 3_900);
      watch.onWaiting(T0 + GRACE);
      // Still counts from the FIRST time "10.0" was seen, not the repeated
      // calls -- a duplicate playlist fetch is not a new part.
      expect(watch.tick(T0 + GRACE + 4_000)).toBe("start-load");
    });

    it("paces itself off the manifest's PART-TARGET, not the wire frame's", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      // The playlist says one-second parts; the frame said half a second.
      // Eight of the manifest's own is eight seconds, not four.
      watch.onManifestTiming({ targetDurationSeconds: 7, partTargetSeconds: 1 });
      watch.onPartAdvance("10.0", T0 + GRACE);
      watch.onWaiting(T0 + GRACE);
      expect(watch.tick(T0 + GRACE + 7_999)).toBe("none");
      expect(watch.tick(T0 + GRACE + 8_000)).toBe("start-load");
      expect(watch.lastReason).toBe("part-stuck");
      // Exactly once, then out of the way -- the backstop owns what follows.
      expect(watch.tick(T0 + GRACE + 9_000)).toBe("none");
    });
  });

  /**
   * WHICH hls.js ERRORS THE LL LADDER MAY TREAT AS FATAL (production,
   * 2026-09-16). `GapController._tryNudgeBuffer` raises `bufferStalledError`
   * to `fatal: true` once it has spent `nudgeMaxRetry` nudges on a playhead
   * that will not move. On a presenter whose upload is starved that is a
   * statement about the BUFFER, and the fatal ladder answered it by
   * rebuilding the player, which cancelled the part downloads that were
   * slowly filling the buffer. Six `audio-init.mp4` fetches in a minute.
   */
  describe("LL error triage", () => {
    it("never lets a buffer event into the fatal ladder, fatal flag and all", () => {
      const watch = new HlsStallWatch({ stallMs: 15_000 });
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onError({
        fatal: true,
        type: "mediaError",
        details: "bufferStalledError",
        now: T0 + GRACE,
      });
      // Not a fatal episode: an ordinary buffering one, which says nothing
      // at all until the stall timer is up.
      expect(watch.tick(T0 + GRACE + 1_000)).toBe("none");
      expect(watch.tick(T0 + GRACE + 15_000)).toBe("start-load");
      expect(watch.lastReason).toBe("stall");
      // And the soft ladder, which never runs `recoverMediaError` -- there
      // is no media error to recover from.
      expect(watch.tick(T0 + GRACE + 16_000)).toBe("reload-level");
    });

    it("the same event on conventional is byte-identical to before", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      // No `configureForMode` at all, the conventional case.
      watch.onError({ fatal: true, details: "bufferStalledError" });
      expect(watch.tick(T0 + 1_000)).toBe("recover-media-error");
      expect(watch.lastReason).toBe("fatal");
    });

    it("gives a media-pipeline error one recovery and a bounded rebuild, then the holding screen", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onError({
        fatal: true,
        type: "mediaError",
        details: "bufferAppendError",
        now: T0,
      });
      expect(watch.tick(T0 + 1_000)).toBe("recover-media-error");
      expect(watch.tick(T0 + 2_000)).toBe("rebuild");
      expect(watch.tick(T0 + 3_000)).toBe("recover-media-error");
      expect(watch.tick(T0 + 4_000)).toBe("rebuild");
      expect(watch.tick(T0 + 5_000)).toBe("recover-media-error");
      // Two rebuilds is the budget: a person gets "try again" rather than a
      // player that tears itself down for the rest of the party.
      expect(watch.tick(T0 + 6_000)).toBe("dead");
    });

    it("leaves a network error the ladder it always had", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onPlaying();
      watch.configureForMode("ll", 500);
      watch.onError({
        fatal: true,
        type: "networkError",
        details: "fragLoadTimeOut",
        now: T0,
      });
      expect(watch.tick(T0 + 1_000)).toBe("recover-media-error");
      expect(watch.tick(T0 + 2_000)).toBe("start-load");
      expect(watch.tick(T0 + 3_000)).toBe("reload-level");
    });

    it("names the cause in the log context, which is the whole point", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onManifestTiming({ targetDurationSeconds: 7, partTargetSeconds: 0.5 });
      watch.onError({
        fatal: true,
        type: "mediaError",
        details: "bufferStalledError",
        message: "Playback stalling at @12.3 due to low buffer",
        now: T0,
      });
      const context = watch.describeContext();
      expect(context).toContain("details=bufferStalledError");
      expect(context).toContain("type=mediaError");
      expect(context).toContain("targetDuration=7s");
      expect(context).toContain("partTarget=0.500s");
      expect(context).toContain("seqStuckMs=21000");
      expect(context).toContain("partStuckMs=4000");
    });

    it("says nothing extra on conventional, so those log lines do not move", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.onError({ fatal: true, details: "bufferAppendError" });
      expect(watch.describeContext()).toBe("");
    });
  });

  /**
   * THE FIRST SECONDS OF AN LL STREAM LOOK EXACTLY LIKE A STALLED ONE.
   *
   * 2026-09-15, the first sustained LL run: viewers "struggled until it
   * settled". A player waiting out the edge's `503 Retry-After: 1` while the
   * remux warms up has no part yet, and `LL_HLS_PART_STUCK_PARTS` is two
   * seconds -- so the watchdog nudged (`startLoad`) a load that was going
   * perfectly well, before the first part had ever landed.
   */
  describe("the LL startup grace", () => {
    it("says nothing about a part that has not arrived yet", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      // No `onPartAdvance` at all: the manifest is still being fetched.
      // Long past both the part threshold AND the grace -- there is nothing
      // to be stuck when nothing has ever advanced.
      expect(watch.tick(T0 + 2_000)).toBe("none");
      expect(watch.tick(T0 + GRACE + 5_000)).toBe("none");
    });

    it("holds the part-stuck nudge until the grace is over", () => {
      const watch = new HlsStallWatch({ stallMs: 60_000 });
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      // One part landed early and then nothing: the rule's own threshold
      // (4 s) passes inside the grace and must still be quiet.
      watch.onPartAdvance("1.0", T0 + 500);
      watch.onWaiting(T0 + 500);
      expect(watch.tick(T0 + 3_000)).toBe("none");
      expect(watch.tick(T0 + GRACE - 1)).toBe("none");
      // The grace ends and the rule gets its one nudge.
      expect(watch.tick(T0 + GRACE)).toBe("start-load");
    });

    it("holds the buffering stall too, then jumps rather than starts the ladder (this attach never played)", () => {
      // Updated for the 2026-09-17 fix: this IS the shape of the incident --
      // a viewer stuck buffering before the grace has even ended, having
      // never painted a frame. Once the grace lifts, the first "stall" rung
      // is now `"jump-live"` (`HlsStallDecision`'s own doc comment), not the
      // old `"start-load"` that walked the ladder for ~40 s in production.
      const watch = new HlsStallWatch({ stallMs: 1_000 });
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onWaiting(T0);
      expect(watch.tick(T0 + 3_000)).toBe("none");
      expect(watch.tick(T0 + GRACE)).toBe("jump-live");
      expect(watch.lastReason).toBe("stall");
    });

    it("still walks the ordinary ladder once this attach has actually played", () => {
      // Same shape, except a frame already painted before the stall (the
      // starved-presenter case `classifyLlHlsError`'s own comment protects)
      // -- `"jump-live"` must never fire for it.
      const watch = new HlsStallWatch({ stallMs: 1_000 });
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onPlaying();
      watch.onWaiting(T0);
      expect(watch.tick(T0 + 3_000)).toBe("none");
      expect(watch.tick(T0 + GRACE)).toBe("start-load");
    });

    it("never graces a fatal error -- a source gone at second two is gone", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onError({ fatal: true });
      expect(watch.tick(T0 + 100)).toBe("recover-media-error");
    });

    it("is off on conventional: byte-identical to before it existed", () => {
      const watch = new HlsStallWatch({ stallMs: 1_000 });
      watch.onSourceChanged(T0);
      watch.configureForMode("conventional");
      watch.onWaiting(T0);
      expect(watch.tick(T0 + 1_000)).toBe("start-load");
    });
  });

  /**
   * PRODUCTION, 2026-09-17: a web viewer opened a party page right as its LL
   * session (re)started, hls.js requested `_HLS_msn=23` against a playlist
   * whose real `EXT-X-MEDIA-SEQUENCE` was already 33-37, nothing usable ever
   * got appended, and the "stall" reason's ordinary ladder
   * (`start-load`/`reload-level`) spent ~40 s walking before a REBUILD
   * happened to land the fresh instance on the live edge on its own.
   * `"jump-live"` is the same one-shot live-edge jump a missing-fragment
   * error already earns (`isMissingFragmentError`), offered on the FIRST
   * rung of a "stall" episode instead, but only while this attach has never
   * painted a frame -- see `HlsStallDecision`'s own doc comment for why that
   * gate exists and cannot be widened without reopening PR 646/650.
   */
  describe('"jump-live" (production, 2026-09-17)', () => {
    it("offers the jump on the very first stall rung of an attach that has never played", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onWaiting(T0 + GRACE);
      expect(watch.tick(T0 + GRACE + HLS_WATCH_PLAYER_STALL_MS)).toBe(
        "jump-live",
      );
      expect(watch.lastReason).toBe("stall");
    });

    it("falls back to the ordinary ladder from the SECOND rung on -- one jump, not a substitute ladder", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onWaiting(T0 + GRACE);
      const first = T0 + GRACE + HLS_WATCH_PLAYER_STALL_MS;
      expect(watch.tick(first)).toBe("jump-live");
      // Still stuck a tick later (the player's own jump either was not
      // acted on, or did not fix it): the ordinary ladder resumes at its
      // SECOND rung, not a repeat of the jump and not the first rung again.
      expect(watch.tick(first + 500)).toBe("reload-level");
      expect(watch.tick(first + 1_000)).toBe("start-load");
    });

    it("never fires once this attach has painted a frame -- the starved-presenter case is untouched", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onPlaying();
      watch.onWaiting(T0 + GRACE);
      expect(watch.tick(T0 + GRACE + HLS_WATCH_PLAYER_STALL_MS)).toBe(
        "start-load",
      );
    });

    it("re-arms for a genuine rebuild -- a fresh instance has not played either", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onPlaying();
      // A NEW attach (`onSourceChanged` again, the same call the player
      // makes for a rebuild or a real re-attach): the rebuilt instance is
      // genuinely as unplayed as a fresh one, so the rule re-arms.
      const t1 = T0 + 60_000;
      watch.onSourceChanged(t1);
      watch.configureForMode("ll", 500);
      watch.onWaiting(t1 + GRACE);
      expect(watch.tick(t1 + GRACE + HLS_WATCH_PLAYER_STALL_MS)).toBe(
        "jump-live",
      );
    });

    it("never fires on conventional or for the fatal ladder", () => {
      const conventional = new HlsStallWatch();
      conventional.onSourceChanged(T0);
      conventional.onWaiting(T0);
      // No `configureForMode("ll", ...)` at all -- the conventional default.
      expect(conventional.tick(T0 + HLS_WATCH_PLAYER_STALL_MS)).not.toBe(
        "jump-live",
      );

      const fatal = new HlsStallWatch();
      fatal.onSourceChanged(T0);
      fatal.configureForMode("ll", 500);
      fatal.onError({ fatal: true, type: "networkError", details: "fragLoadTimeOut" });
      // A fatal ("other" class) error keeps its existing ladder, never the
      // startup jump -- that gate is `reason === "stall"` only.
      expect(fatal.tick(T0 + GRACE + 100)).toBe("recover-media-error");
    });

    /**
     * THE REGRESSION THIS PR'S OWN COMPONENT TEST CAUGHT FIRST
     * (`hls-watch-player-ll-recovery.test.tsx`): `gateRebuild` resets
     * `ladderStep` to 0 every three cycles of the "stall" ladder, with no
     * `onPlaying` required for it to do so. Gating the jump on
     * `ladderStep === 1` alone re-satisfied that condition every ~6-7 ticks
     * on a source that never recovers, producing a REPEATED `stopLoad` +
     * `startLoad` pair instead of the promised single jump.
     * `jumpOffered` is what actually bounds it to once per attach.
     */
    it("never repeats past a gateRebuild ladderStep reset, on a source that never recovers", () => {
      const watch = new HlsStallWatch();
      watch.onSourceChanged(T0);
      watch.configureForMode("ll", 500);
      watch.onWaiting(T0 + GRACE);
      const decisions: HlsStallDecision[] = [];
      let now = T0 + GRACE;
      // Twenty ticks: well past the first jump, past a full three-cycle
      // ladder (a `"rebuild"` decision, `ladderStep` reset to 0 by
      // `gateRebuild`), and into a second cycle -- nothing here ever calls
      // `onPlaying`/`onSourceChanged`, so this is exactly what a fake or
      // genuinely dead source looks like from the watchdog's side.
      for (let i = 0; i < 20; i += 1) {
        now += 1_000;
        decisions.push(watch.tick(now));
      }
      expect(decisions.filter((d) => d === "jump-live")).toHaveLength(1);
      expect(decisions).toContain("rebuild");
    });
  });
});

describe("HlsStallWatch through a same-session seam", () => {
  const stallMs = HLS_WATCH_PLAYER_STALL_MS;

  it("holds on a frozen playlist even when the element stalled first, and never rebuilds", () => {
    const watch = new HlsStallWatch({ stallMs });
    watch.onSourceChanged(T0);
    watch.onMediaSequence(100, T0);
    watch.onPlaying();
    // Starved early: the stall clock runs out before the playlist's own.
    watch.onWaiting(T0 + 2_000);
    const decisions: HlsStallDecision[] = [];
    for (let t = T0 + 17_000; t <= T0 + 60_000; t += 1_000) {
      decisions.push(watch.tick(t));
    }
    expect(decisions).not.toContain("rebuild");
    expect(decisions).not.toContain("dead");
    expect(decisions).toContain("hold");
    expect(watch.lastReason).toBe("sequence-stuck");
  });

  it("gives the first segments after the seam a whole stall window", () => {
    const watch = new HlsStallWatch({ stallMs });
    watch.onSourceChanged(T0);
    watch.onMediaSequence(100, T0);
    watch.onPlaying();
    watch.onWaiting(T0 + 5_000);
    for (let t = T0 + 20_000; t <= T0 + 25_000; t += 1_000) {
      watch.tick(t);
    }
    expect(watch.isHoldingForRestart).toBe(true);
    // The same playlist continues behind a discontinuity.
    watch.onMediaSequence(101, T0 + 25_000);
    expect(watch.isHoldingForRestart).toBe(false);
    for (let t = T0 + 26_000; t < T0 + 25_000 + stallMs; t += 1_000) {
      expect(watch.tick(t)).toBe("none");
    }
  });

  it("stretches the stall rule on the native live engine, and only there", () => {
    const native = new HlsStallWatch({ stallMs });
    native.setNativeLiveEngine(true);
    native.onSourceChanged(T0);
    native.onPlaying();
    native.onWaiting(T0);
    expect(native.tick(T0 + stallMs + 1_000)).toBe("none");
    expect(native.tick(T0 + NATIVE_LIVE_STALL_MS - 1_000)).toBe("none");
    expect(native.tick(T0 + NATIVE_LIVE_STALL_MS)).not.toBe("none");

    const hlsjs = new HlsStallWatch({ stallMs });
    hlsjs.onSourceChanged(T0);
    hlsjs.onPlaying();
    hlsjs.onWaiting(T0);
    expect(hlsjs.tick(T0 + stallMs + 1_000)).not.toBe("none");
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
