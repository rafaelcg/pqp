import { describe, expect, it } from "vitest";
import { summarizeHlsTelemetryBatch } from "./hls-telemetry-summary.js";

describe("summarizeHlsTelemetryBatch (telemetry v2)", () => {
  it("heads with frozen seconds per steady viewer-minute, startup excluded", () => {
    const summary = summarizeHlsTelemetryBatch([
      // The attach's own buffering: counted as startup, not in the headline.
      { rung: "ll", latencyMs: 9_000, startup: true, stalls: 1, rebufferMs: 2_000, windowMs: 5_000 },
      { rung: "ll", latencyMs: 9_000, startup: false, stalls: 1, rebufferMs: 500, windowMs: 5_000 },
      { rung: "ll", latencyMs: 9_000, startup: false, stalls: 0, rebufferMs: 0, windowMs: 5_000 },
    ]);
    expect(summary.startupSamples).toBe(1);
    expect(summary.steadySamples).toBe(2);
    expect(summary.steadyStalls).toBe(1);
    expect(summary.steadyRebufferMs).toBe(500);
    expect(summary.steadyWindowMs).toBe(10_000);
    // 0.5 s frozen over 10 s = 3 s per minute.
    expect(summary.stallSecondsPerMinute).toBe(3);
    expect(summary.totalRebufferMs).toBe(2_500);
  });

  it("reads an old client's batch as unknown, never as steady", () => {
    const summary = summarizeHlsTelemetryBatch([
      { rung: "720p30", latencyMs: 30_000, stalls: 3, playerRebuildCount: 4 },
    ]);
    expect(summary.steadySamples).toBe(0);
    expect(summary.startupSamples).toBe(0);
    expect(summary.stallSecondsPerMinute).toBeUndefined();
    // The lifetime counter is not a per-window rebuild.
    expect(summary.rebuilds).toBe(0);
  });

  it("sums per-window rebuilds and hole skips, and lists modes, visibility and fatals", () => {
    const summary = summarizeHlsTelemetryBatch([
      { rung: "ll", latencyMs: 1, rebuilds: 1, holeSkips: 2, playerMode: "ll", hidden: true, muted: true, fatal: ["fragLoadTimeOut"] },
      { rung: "ll", latencyMs: 1, rebuilds: 0, holeSkips: 1, playerMode: "ll-segments", fatal: ["fragLoadTimeOut", "bad detail!"] },
    ]);
    expect(summary.rebuilds).toBe(1);
    expect(summary.holeSkips).toBe(3);
    expect(summary.playerModes).toEqual(["ll", "ll-segments"]);
    expect(summary.hiddenSamples).toBe(1);
    expect(summary.mutedSamples).toBe(1);
    // Only plain identifiers reach a log line.
    expect(summary.fatal).toEqual(["fragLoadTimeOut"]);
  });

  it("reports the player's own target beside the measured latency (LL batches)", () => {
    const summary = summarizeHlsTelemetryBatch([
      { rung: "ll", latencyMs: 20_900, targetLatencyMs: 20_000, playerMode: "ll-segments" },
      { rung: "ll", latencyMs: 21_200, targetLatencyMs: 20_000, playerMode: "ll-segments" },
      { rung: "ll", latencyMs: 20_400, targetLatencyMs: 20_000, playerMode: "ll-segments" },
      // An old client: no target, left out of both medians.
      { rung: "ll", latencyMs: 5_000 },
    ]);
    expect(summary.medianTargetLatencyMs).toBe(20_000);
    // Holding its target to within a second: the 21 s is where it was told to sit.
    expect(summary.medianLatencyOverTargetMs).toBe(900);
  });

  it("averages the two central values when a batch has an even number of targets", () => {
    const summary = summarizeHlsTelemetryBatch([
      { rung: "ll", latencyMs: 8_100, targetLatencyMs: 8_000 },
      { rung: "ll", latencyMs: 20_300, targetLatencyMs: 20_000 },
    ]);
    // Midpoint, not the upper of the two (20 s).
    expect(summary.medianTargetLatencyMs).toBe(14_000);
    // Offsets 100 and 300: 200, not 300.
    expect(summary.medianLatencyOverTargetMs).toBe(200);
  });

  it("leaves the target fields undefined when no sample carries one", () => {
    const summary = summarizeHlsTelemetryBatch([{ rung: "720p30", latencyMs: 12_000 }]);
    expect(summary.medianTargetLatencyMs).toBeUndefined();
    expect(summary.medianLatencyOverTargetMs).toBeUndefined();
  });
});
