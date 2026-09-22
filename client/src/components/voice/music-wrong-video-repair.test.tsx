// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WRONG_VIDEO_REPAIR_LIMIT,
  applyRoomTrack,
  useWrongVideoRepair,
} from "./music-player-embed";
import type { YTPlayer } from "@/lib/youtube-iframe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE REPAIR RUNS FROM A TIMER, SO IT MUST NOT THROW AND MUST NOT FORGET.
 *
 * A YouTube player that is failing or being torn down can throw from
 * `loadVideoById`; from inside a `setInterval` that escaped as an uncaught
 * error. And the retry budget was keyed only by the video the room wanted,
 * so a track that exhausted it stayed exhausted: the room moved to B, came
 * back to A (repeat-all, a re-add), the player missed it, and nothing ever
 * tried again.
 */

function player(overrides: Partial<YTPlayer> = {}): YTPlayer {
  return {
    loadVideoById: vi.fn(),
    cueVideoById: vi.fn(),
    ...overrides,
  } as unknown as YTPlayer;
}

describe("applyRoomTrack", () => {
  it("loads a playing room and cues a paused one", () => {
    const p = player();
    expect(applyRoomTrack(p, "aaaaaaaaaaa", true, 12)).toBe(true);
    expect(p.loadVideoById).toHaveBeenCalledWith("aaaaaaaaaaa", 12);
    expect(applyRoomTrack(p, "aaaaaaaaaaa", false, 12)).toBe(true);
    expect(p.cueVideoById).toHaveBeenCalledWith("aaaaaaaaaaa", 12);
  });

  it("reports a player that throws instead of throwing itself", () => {
    const p = player({
      loadVideoById: vi.fn(() => {
        throw new Error("player destroyed");
      }),
    });
    expect(() => applyRoomTrack(p, "aaaaaaaaaaa", true, 0)).not.toThrow();
    expect(applyRoomTrack(p, "aaaaaaaaaaa", true, 0)).toBe(false);
  });
});

describe("useWrongVideoRepair", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let tryRepair: ((roomVideoId: string, nowMs: number) => boolean) | null = null;

  function Harness({ trackKey }: { trackKey: string | null }) {
    tryRepair = useWrongVideoRepair(trackKey);
    return null;
  }

  function render(trackKey: string | null) {
    act(() => {
      root!.render(<Harness trackKey={trackKey} />);
    });
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    tryRepair = null;
  });

  it("gives an exhausted track a fresh budget when the room comes back to it", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    render("track-a");
    let now = 0;
    for (let i = 0; i < WRONG_VIDEO_REPAIR_LIMIT; i += 1) {
      expect(tryRepair!("aaaaaaaaaaa", now)).toBe(true);
      now += 60_000;
    }
    expect(tryRepair!("aaaaaaaaaaa", now)).toBe(false);

    // The room plays B for a while, then returns to A.
    render("track-b");
    render("track-a");
    expect(tryRepair!("aaaaaaaaaaa", now)).toBe(true);
  });
});
