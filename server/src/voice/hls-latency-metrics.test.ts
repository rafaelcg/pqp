import { afterEach, describe, expect, it } from "vitest";
import {
  HLS_LATENCY_BUCKET_BOUNDARIES_MS,
  hlsLatencySnapshot,
  hlsTelemetryActivity,
  recordHlsLatencySample,
  recordHlsTelemetryBatchAccepted,
  recordHlsTelemetryBatchRejectedRateLimit,
  recordHlsTelemetryBatchRejectedSchema,
  resetHlsLatencyMetricsForTests,
} from "./hls-latency-metrics.js";

afterEach(() => {
  resetHlsLatencyMetricsForTests();
});

describe("hlsLatencySnapshot", () => {
  it("is empty with no samples", () => {
    expect(hlsLatencySnapshot()).toEqual([]);
  });

  it("reports count, p50 and p95 for a rung with one sample", () => {
    recordHlsLatencySample("720p30", 8_000);
    const snapshot = hlsLatencySnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ rung: "720p30", count: 1 });
    // One sample: p50 and p95 both land on its own bucket.
    expect(snapshot[0]!.p50Ms).toBe(8_000);
    expect(snapshot[0]!.p95Ms).toBe(8_000);
  });

  it("keeps rungs separate", () => {
    recordHlsLatencySample("720p30", 4_000);
    recordHlsLatencySample("1080p30", 20_000);
    const snapshot = hlsLatencySnapshot();
    expect(snapshot).toHaveLength(2);
    const byRung = Object.fromEntries(snapshot.map((r) => [r.rung, r]));
    expect(byRung["720p30"]!.p50Ms).toBe(4_000);
    expect(byRung["1080p30"]!.p50Ms).toBe(20_000);
  });

  it("p95 sits at or above p50 as more samples spread the distribution", () => {
    for (let i = 0; i < 100; i++) {
      // 90 fast samples, 10 slow ones.
      recordHlsLatencySample("720p30", i < 90 ? 3_000 : 45_000);
    }
    const [summary] = hlsLatencySnapshot();
    expect(summary!.p50Ms).toBeLessThanOrEqual(summary!.p95Ms!);
    expect(summary!.p50Ms).toBe(3_000);
    expect(summary!.p95Ms).toBe(45_000);
  });

  it("a sample above every boundary lands in the overflow bucket, reported as the last boundary", () => {
    const lastBoundary =
      HLS_LATENCY_BUCKET_BOUNDARIES_MS[HLS_LATENCY_BUCKET_BOUNDARIES_MS.length - 1]!;
    recordHlsLatencySample("720p30", lastBoundary + 500_000);
    const [summary] = hlsLatencySnapshot();
    expect(summary!.p50Ms).toBe(lastBoundary);
    expect(summary!.count).toBe(1);
  });

  it("results are sorted by rung name for a stable panel order", () => {
    recordHlsLatencySample("1080p30", 1_000);
    recordHlsLatencySample("480p30", 1_000);
    recordHlsLatencySample("720p30", 1_000);
    expect(hlsLatencySnapshot().map((r) => r.rung)).toEqual([
      "1080p30",
      "480p30",
      "720p30",
    ]);
  });
});

describe("hlsTelemetryActivity", () => {
  it("tracks accepted/rejected batch counters independently of the histogram", () => {
    recordHlsTelemetryBatchAccepted();
    recordHlsTelemetryBatchAccepted();
    recordHlsTelemetryBatchRejectedSchema();
    recordHlsTelemetryBatchRejectedRateLimit();
    recordHlsLatencySample("720p30", 5_000);
    recordHlsLatencySample("720p30", 6_000);

    const activity = hlsTelemetryActivity();
    expect(activity.batchesAccepted).toBe(2);
    expect(activity.batchesRejectedSchema).toBe(1);
    expect(activity.batchesRejectedRateLimit).toBe(1);
    expect(activity.samplesRecorded).toBe(2);
    expect(activity.byRung).toHaveLength(1);
  });
});

describe("resetHlsLatencyMetricsForTests", () => {
  it("clears every counter and every histogram", () => {
    recordHlsLatencySample("720p30", 5_000);
    recordHlsTelemetryBatchAccepted();
    resetHlsLatencyMetricsForTests();
    const activity = hlsTelemetryActivity();
    expect(activity.batchesAccepted).toBe(0);
    expect(activity.samplesRecorded).toBe(0);
    expect(activity.byRung).toEqual([]);
  });
});
