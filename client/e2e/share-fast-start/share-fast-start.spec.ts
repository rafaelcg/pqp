/**
 * `share_fast_start_quality` measured, as a regression: the product's LiveKit
 * session against a real LiveKit 1.13.6 and real Chrome (see `rig.mjs`).
 *
 * Two scenarios, flag on, each asserting what the flag promises:
 *
 *   1. JOIN: three viewers join a film-night-sized room (22 idle participants,
 *      so the presenter's plan is the large-room one: 360p + 720p) with the
 *      share already running. Every viewer's first decoded picture is the
 *      720p layer, and its steady rate is the same 720p layer's.
 *   2. CROSSING: six viewers join a room of seventeen, taking it past twenty.
 *      Nobody's picture goes away: no viewer sees the share unpublished.
 *
 * The flag-off numbers (360p first for about a second on some joins; every
 * viewer losing the picture at the crossing) are in the README; this file
 * pins the fixed behaviour, not the bug.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
// @ts-expect-error plain ESM rig module, no types
import { runScenario, scenario } from "./run.mjs";
// @ts-expect-error plain ESM rig module, no types
import { hasTools } from "./rig.mjs";

interface Viewer {
  summary: {
    firstFrame: number | null;
    heights: { t: number; h: number }[];
    steadyKbps: number | null;
  };
  raw: { events: { t: number; name: string; data?: { h?: number } }[] };
}

/**
 * Every picture height the viewer had: the stats loop's (four times a second)
 * and the element's own (`size` events, also four a second), so a drop and a
 * recovery between two samples of one of them still shows in the other.
 */
function heightsSeen(viewer: Viewer): number[] {
  return [
    ...viewer.summary.heights.map((step) => step.h),
    ...viewer.raw.events
      .filter((event) => event.name === "size" && typeof event.data?.h === "number")
      .map((event) => event.data!.h!),
  ];
}

const chrome = spawnSync("test", ["-d", "/Applications/Google Chrome.app"]).status === 0 ||
  spawnSync("which", ["google-chrome"]).status === 0;

test.describe("share_fast_start_quality", () => {
  test.skip(!hasTools() || !chrome, "needs Docker, ffmpeg and Google Chrome");

  test("a joining viewer's first picture is the stage's layer", async () => {
    const result = await runScenario(
      scenario({ idle: 22, viewers: 3, warm: 10, watch: 15, fast: true }),
    );
    // The presenter's plan is the large-room one only above twenty.
    expect(result.participantsBeforeViewers).toBeGreaterThan(20);
    expect(result.viewers).toHaveLength(3);
    for (const viewer of result.viewers as Viewer[]) {
      const { firstFrame, heights, steadyKbps } = viewer.summary;
      expect(firstFrame, "first frame decoded").not.toBeNull();
      expect(firstFrame!).toBeLessThan(2_500);
      expect(heights[0]?.h, "first picture is the 720p layer, not the 360p copy").toBe(720);
      expect(heightsSeen(viewer).every((h) => h >= 720)).toBe(true);
      // The same layer as before the flag: about 1.5 Mbit/s, never the top of
      // a bigger ladder.
      expect(steadyKbps!).toBeLessThan(1_800);
    }
  });

  test("the room crossing twenty does not take the picture away", async () => {
    const result = await runScenario(
      scenario({ src: "display", idle: 16, viewers: 6, warm: 15, watch: 30, fast: true }),
    );
    // It has to have crossed, or "nobody lost the picture" proves nothing.
    expect(result.participantsBeforeViewers).toBeLessThanOrEqual(20);
    expect(result.participantsAfterViewers).toBeGreaterThan(20);
    expect(result.viewers).toHaveLength(6);
    for (const viewer of result.viewers as Viewer[]) {
      expect(viewer.summary.firstFrame).not.toBeNull();
      expect(viewer.raw.events.some((event) => event.name === "screenGone")).toBe(false);
      expect(heightsSeen(viewer).some((h) => h <= 2)).toBe(false);
    }
  });
});
