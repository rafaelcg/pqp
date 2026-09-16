// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Hls from "hls.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";
import { LL_HLS_EDGE_JUMP_MAX } from "@/lib/hls-live-edge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * WHAT THE FIRST SUSTAINED LL RUN DID WITH AN ERROR (2026-09-15, 21:29-21:41
 * UTC). The edge Worker returned five sporadic 500s on media parts. After
 * them the player asked for `ll/part-699.m4s` with the live edge at part
 * ~1,400, twice, minutes apart: the recovery ladder called `startLoad(-1)`,
 * which in hls.js means "resume at `lastCurrentTime`", so it re-requested
 * the part the frozen playhead named. That part had left the remux's ring
 * (six segments, parts on the newest three) long before. The Worker answered
 * 404, hls.js does not retry a 4xx and an LL master has no second level to
 * fail over to, so it went fatal, and a room full of people were told "A
 * transmissão caiu" about a broadcast that was still running.
 *
 * `hls-live-edge.test.ts` pins the pieces. This suite drives the PLAYER,
 * because every piece was individually correct: what shipped was the
 * component wiring them to the wrong position. The fake below runs the REAL
 * hls.js constructor over our config first, the way
 * `hls-watch-player-ll-attach.test.tsx` established -- a fake that validates
 * nothing is how the last one of these got through.
 */

/** Every loader call the player made, in order, e.g. `startLoad(1499.5)`. */
const calls: string[] = [];
/** What the fake reports as hls.js's own live sync point. */
const engine = { liveSyncPosition: null as number | null };
type Handler = (event: string, data: unknown) => void;
const handlers = new Map<string, Handler[]>();

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class RecordingFakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      // The real merge, including the validation that once threw for every
      // LL viewer in production. Destroyed immediately: nothing here should
      // touch media.
      const probe = new RealHls(config as never);
      this.config = probe.config as unknown as Record<string, unknown>;
      probe.destroy();
    }
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
    off() {}
    loadSource() {
      calls.push("loadSource");
    }
    attachMedia() {}
    destroy() {}
    startLoad(position?: number) {
      calls.push(`startLoad(${position})`);
    }
    stopLoad() {
      calls.push("stopLoad");
    }
    recoverMediaError() {
      calls.push("recoverMediaError");
    }
    get latency() {
      return 1;
    }
    get liveSyncPosition() {
      return engine.liveSyncPosition;
    }
    get levels() {
      return [];
    }
    currentLevel = -1;
    nextLevel = -1;
  }
  return { ...actual, default: RecordingFakeHls };
});

const LL_SRC =
  "https://hls.pqp.gg/api/voice/hls-playlist/d5559e70-8b1c-4a0b-8ffc-b61c88004c73/1789496087461?mode=ll&t=tok";

/** hls.js's own shape for a part/segment the edge no longer has. */
function missingPartError() {
  return {
    fatal: true,
    type: "networkError",
    details: "fragLoadError",
    response: { code: 404, text: "Not Found" },
  };
}

function fire(data: unknown) {
  for (const handler of handlers.get(Hls.Events.ERROR) ?? []) {
    handler(Hls.Events.ERROR, data);
  }
}

/**
 * A LEVEL_UPDATED as the live party actually produced it on 2026-09-16:
 * `EXT-X-TARGETDURATION 7` (the remux closes a video segment only on an IDR,
 * and the keyframe gate is a PLI every 4 s answered in about a second, so
 * segments run 5 to 9 s), half-second parts, and a `partList` that is
 * genuinely there.
 */
function levelUpdated(startSN: number, partSn: number, partIndex: number) {
  return {
    details: {
      startSN,
      endSN: startSN + 5,
      targetduration: 7,
      partTarget: 0.5,
      partHoldBack: 1.5,
      lastPartSn: partSn,
      lastPartIndex: partIndex,
      partList: [{}, {}],
      totalduration: 42,
      fragments: [],
      live: true,
    },
  };
}

function fireLevelUpdated(data: unknown) {
  for (const handler of handlers.get(Hls.Events.LEVEL_UPDATED) ?? []) {
    handler(Hls.Events.LEVEL_UPDATED, data);
  }
}

describe("an LL player that falls behind the part ring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    calls.length = 0;
    handlers.clear();
    engine.liveSyncPosition = 1_500;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    warn.mockRestore();
    vi.useRealTimers();
  });

  async function mount(mode: "ll" | "live" = "ll") {
    await act(async () => {
      root.render(
        <HlsWatchPlayer
          src={LL_SRC}
          layout="cinema"
          mode={mode}
          partTargetMs={500}
        />,
      );
    });
    // `attach()` awaits `import("hls.js")`, so it finishes a few ticks after
    // the render. Wait for the outcome, bounded.
    for (let i = 0; i < 200 && !handlers.has(Hls.Events.ERROR); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(handlers.has(Hls.Events.ERROR)).toBe(true);
    calls.length = 0;
  }

  /** One pass of the player's 1 s stall tick. */
  async function tick(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }
  }

  it("jumps to the live edge on a 404'd part instead of declaring the stream dead", async () => {
    await mount();
    await act(async () => {
      fire(missingPartError());
    });
    // One live-edge restart: the loader is pointed at the edge (one part
    // back, `liveSeekOffsetSeconds("ll", 500)`), not at `-1`, which is what
    // sent it back to part 699.
    expect(calls).toEqual(["stopLoad", "startLoad(1499.5)"]);
  });

  it("does not hand that error to the stall ladder at all", async () => {
    await mount();
    await act(async () => {
      fire(missingPartError());
    });
    calls.length = 0;
    // The watchdog was never told this was fatal, so its ladder has nothing
    // to walk: no `recoverMediaError`, and nothing about a dead stream.
    await tick(3);
    expect(calls).toEqual([]);
    expect(container.textContent).not.toContain("dropped");
    expect(container.textContent).not.toContain("voice.hls.dead");
  });

  it("hands the SECOND part error to §4's pin, which rebuilds rather than jumping", async () => {
    await mount();
    await act(async () => {
      fire(missingPartError());
    });
    expect(calls).toEqual(["stopLoad", "startLoad(1499.5)"]);
    calls.length = 0;
    // Two part-load errors inside 10 s is the pin rule
    // (`shouldPinToConventionalRung`): this session stops asking hls.js to
    // hold the LL edge at all, which re-attaches from the live edge anyway.
    // Two responses to one error is how a ladder fights itself, so the jump
    // stands down for it.
    await act(async () => {
      fire(missingPartError());
    });
    expect(calls).not.toContain("startLoad(1499.5)");
    expect(
      warn.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes("pinning to conventional"),
      ),
    ).toBe(true);
  });

  it("is bounded: past the budget the error escalates the way it always did", async () => {
    // Spaced wider than the pin rule's 10 s window and inside the jump
    // budget's 30 s one, so this exercises the budget rather than §4's pin
    // (which would otherwise always reach a second part error first). #646
    // drove this case on a CONVENTIONAL stream, which is exactly the
    // behaviour the revert was about: there is no jump there to bound.
    await mount();
    for (let i = 0; i < LL_HLS_EDGE_JUMP_MAX; i += 1) {
      await act(async () => {
        fire(missingPartError());
      });
      expect(calls).toContain("startLoad(1499.5)");
      calls.length = 0;
      await tick(11);
      calls.length = 0;
    }
    await act(async () => {
      fire(missingPartError());
    });
    // Not jumped: no loader call of its own...
    expect(calls).toEqual([]);
    // ...and the ladder has it now, which on the next tick is its first step.
    await tick();
    expect(calls).toContain("recoverMediaError");
  });

  /**
   * THE GATE ITSELF, from the LL side. Nothing above may reach a
   * conventional stream -- that is what #650 reverted #646 to be sure of,
   * and `hls-watch-player-conventional-recovery.test.tsx` is the other,
   * larger half of the answer, recorded off post-revert `main`.
   */
  it("does none of this on a conventional stream", async () => {
    await mount("live");
    await act(async () => {
      fire(missingPartError());
    });
    // No jump, and the watchdog was told: the ladder starts on the next
    // tick, at `-1`, not at the edge.
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toContain("recoverMediaError");
    await tick();
    expect(calls).toContain("startLoad(-1)");
    expect(calls).not.toContain("startLoad(1496)");
  });

  it("escalates when there is no live edge to jump to", async () => {
    engine.liveSyncPosition = null;
    await mount();
    await act(async () => {
      fire(missingPartError());
    });
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toContain("recoverMediaError");
  });

  it("leaves a 500 on a part to the retry budget and then the ladder", async () => {
    await mount();
    await act(async () => {
      fire({ ...missingPartError(), response: { code: 500, text: "Oops" } });
    });
    // No jump: a 500 is the Worker having a bad moment on a part that still
    // exists, which `fragLoadPolicy` owns.
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toContain("recoverMediaError");
  });

  it("still escalates a 404 on the playlist itself -- that session IS gone", async () => {
    await mount();
    await act(async () => {
      fire({
        fatal: true,
        type: "networkError",
        details: "levelLoadError",
        response: { code: 404, text: "Not Found" },
      });
    });
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toContain("recoverMediaError");
  });

  /**
   * THE OTHER HALF OF THE SAME RUN: "it struggles until it settles". The
   * part-stuck rule is four parts, two seconds at a 500 ms target, and the
   * first two seconds of an LL attach are spent waiting out the edge's
   * `503 Retry-After: 1` while the remux warms up. So the watchdog nudged
   * (`startLoad`) a load that was going fine, before a single part had
   * arrived.
   */
  it("says nothing for the first seconds of an LL attach", async () => {
    await mount();
    // Well past the part threshold and past the grace: no part has ever
    // advanced, so there is nothing to be stuck, and the loader is left
    // alone to do what it was already doing.
    await tick(10);
    expect(calls).toEqual([]);
  });

  /**
   * ITEM 1 OF THE SAME BUG, on the ladder rather than on the error handler:
   * a recovery step that resumes at the frozen playhead asks for a part that
   * is gone, on a stream where the window is twelve seconds.
   */
  it("restarts the loader at the live edge when the ladder does run", async () => {
    await mount();
    await act(async () => {
      // A fatal NETWORK error, not a buffer one. `bufferStalledError` used
      // to stand in here, and since 2026-09-16 it does not reach the fatal
      // ladder at all on LL (hls.js raises it to fatal after its own nudge
      // budget on a starved source, which is a statement about the buffer);
      // see `hls-stall.test.ts` "LL error triage". The claim under test is
      // unchanged: when the fatal ladder DOES run, it restarts at the edge.
      fire({
        fatal: true,
        type: "networkError",
        details: "fragLoadTimeOut",
        response: undefined,
      });
    });
    // Step 1 of the fatal ladder.
    await tick();
    expect(calls).toContain("recoverMediaError");
    calls.length = 0;
    // Step 2 is `start-load`, and it starts AT THE EDGE.
    await tick();
    expect(calls).toContain("startLoad(1499.5)");
    expect(calls).not.toContain("startLoad(-1)");
  });

  /**
   * THE 2026-09-16 LOOP, END TO END. Bundle `index-CFUMtvOT.js`, a session
   * the server was serving perfectly -- remux at 2 parts/s, `timelineRatio`
   * 1.00, 520 Worker requests all 200 -- and a viewer console repeating
   * `stream stalled (sequence-stuck)`, then `(fatal)`, `start-load`,
   * `reload-level`, `recover-media-error`, `rebuilding the player`. The
   * media sequence only moves when a SEGMENT closes, which on this remux is
   * every 5 to 9 s; parts moved every 0.5 s throughout.
   */
  it("never calls a part-advancing stream stuck, whatever the media sequence does", async () => {
    await mount();
    // Ninety seconds of parts arriving with `EXT-X-MEDIA-SEQUENCE` held
    // still throughout -- the honest case, not a contrived one: `startSN`
    // only moves when a closed segment leaves the playlist window, and a ring
    // of six 5-to-9 s segments does not start sliding for the best part of a
    // minute. The old rule fired at twelve seconds and then every cycle
    // after it.
    for (let second = 0; second < 90; second += 1) {
      await act(async () => {
        fireLevelUpdated(levelUpdated(100, 200 + second, second % 2));
      });
      await tick();
    }
    // Not one recovery step, and above all not a rebuild: the player was
    // cancelling its own init and part downloads for this.
    expect(calls).toEqual([]);
    const warned = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warned.filter((line: string) => line.includes("stream stalled"))).toEqual([]);
  });

  /**
   * `GapController._tryNudgeBuffer` raises `bufferStalledError` to
   * `fatal: true` once it has spent `nudgeMaxRetry` nudges. The presenter's
   * upload was starved that night (tiny parts, a shrinking buffer), and the
   * fatal ladder answered a low buffer by rebuilding the player, which
   * cancelled the part downloads that were filling it.
   */
  it("shows buffering for a starved source instead of rebuilding the player", async () => {
    await mount();
    await act(async () => {
      fireLevelUpdated(levelUpdated(100, 200, 0));
      fire({
        fatal: true,
        type: "mediaError",
        details: "bufferStalledError",
        error: { message: "Playback stalling at @12.3 due to low buffer" },
      });
    });
    // The whole fatal ladder's worth of ticks, and nothing from it.
    await tick(10);
    expect(calls).not.toContain("recoverMediaError");
    const warned = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(warned.some((line: string) => line.includes("rebuilding the player"))).toBe(
      false,
    );
    // And when the soft ladder does eventually speak, the line names the
    // hls.js error and the cadence behind the thresholds.
    const stalls = warned.filter((line: string) => line.includes("stream stalled"));
    for (const line of stalls) {
      expect(line).toContain("details=bufferStalledError");
      expect(line).toContain("targetDuration=7s");
    }
  });
});
