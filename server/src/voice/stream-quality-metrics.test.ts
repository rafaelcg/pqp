import { afterEach, describe, expect, it } from "vitest";
import {
  classifyBitrateKbps,
  classifyFps,
  classifyResolution,
  recordStreamQualityBatchAccepted,
  recordStreamQualityBatchRejectedRateLimit,
  recordStreamQualityBatchRejectedSchema,
  recordStreamQualitySample,
  resetStreamQualityMetricsForTests,
  streamQualityMetricsSnapshot,
} from "./stream-quality-metrics.js";

afterEach(() => {
  resetStreamQualityMetricsForTests();
});

describe("classifyFps", () => {
  it("puts the '5-6 fps' complaint squarely in its own bucket", () => {
    expect(classifyFps(5)).toBe("5-9");
    expect(classifyFps(6)).toBe("5-9");
  });

  it("buckets the boundaries the way a half-open range reads", () => {
    expect(classifyFps(0)).toBe("0-4");
    expect(classifyFps(4.9)).toBe("0-4");
    expect(classifyFps(29)).toBe("25-29");
    expect(classifyFps(30)).toBe("30-plus");
    expect(classifyFps(60)).toBe("30-plus");
  });
});

describe("classifyBitrateKbps", () => {
  it("buckets low and high bitrates", () => {
    expect(classifyBitrateKbps(0)).toBe("0-199");
    expect(classifyBitrateKbps(199)).toBe("0-199");
    expect(classifyBitrateKbps(200)).toBe("200-499");
    expect(classifyBitrateKbps(3_999)).toBe("2000-3999");
    expect(classifyBitrateKbps(4_000)).toBe("4000-plus");
    expect(classifyBitrateKbps(50_000)).toBe("4000-plus");
  });
});

describe("classifyResolution", () => {
  it("buckets by height", () => {
    expect(classifyResolution(180)).toBe("240p-minus");
    expect(classifyResolution(360)).toBe("360p");
    expect(classifyResolution(480)).toBe("480p");
    expect(classifyResolution(720)).toBe("720p");
    expect(classifyResolution(1_080)).toBe("1080p");
    expect(classifyResolution(1_440)).toBe("1440p-plus");
    expect(classifyResolution(2_160)).toBe("1440p-plus");
  });
});

describe("streamQualityMetricsSnapshot", () => {
  it("starts at zero for every role, transport and bucket", () => {
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.samplesAccepted).toBe(0);
    expect(snapshot.fpsBuckets.presenter.mesh["5-9"]).toBe(0);
    expect(snapshot.fpsBuckets.viewer.livekit["30-plus"]).toBe(0);
    expect(snapshot.bitrateBuckets.presenter.livekit["0-199"]).toBe(0);
    expect(snapshot.resolutionBuckets.viewer.mesh["720p"]).toBe(0);
    expect(snapshot.limitationReasons.mesh.bandwidth).toBe(0);
    expect(snapshot.limitationReasons.livekit.none).toBe(0);
  });

  it("folds a presenter sample into fps, bitrate, resolution and the reason, keyed by transport", () => {
    recordStreamQualitySample({
      role: "presenter",
      transport: "mesh",
      fps: 6,
      kbps: 350,
      width: 640,
      height: 360,
      qualityLimitationReason: "bandwidth",
    });
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.samplesAccepted).toBe(1);
    expect(snapshot.fpsBuckets.presenter.mesh["5-9"]).toBe(1);
    expect(snapshot.bitrateBuckets.presenter.mesh["200-499"]).toBe(1);
    expect(snapshot.resolutionBuckets.presenter.mesh["360p"]).toBe(1);
    expect(snapshot.limitationReasons.mesh.bandwidth).toBe(1);
    // Nothing leaked into the viewer or livekit slots.
    expect(snapshot.fpsBuckets.viewer.mesh["5-9"]).toBe(0);
    expect(snapshot.fpsBuckets.presenter.livekit["5-9"]).toBe(0);
  });

  it("a viewer sample never counts toward the limitation reason, even if the field is set", () => {
    recordStreamQualitySample({
      role: "viewer",
      transport: "livekit",
      fps: 30,
      // A viewer sample carrying this is legal on the wire (the schema does
      // not forbid it) but meaningless: a receiver's getStats() row has no
      // such field in practice, and this must not be recorded as if it did.
      qualityLimitationReason: "cpu",
    });
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.limitationReasons.livekit.cpu).toBe(0);
    expect(snapshot.fpsBuckets.viewer.livekit["30-plus"]).toBe(1);
  });

  it("counts accumulate across many samples", () => {
    for (let i = 0; i < 5; i++) {
      recordStreamQualitySample({ role: "viewer", transport: "mesh", fps: 25 });
    }
    recordStreamQualitySample({ role: "viewer", transport: "mesh", fps: 3 });
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.fpsBuckets.viewer.mesh["25-29"]).toBe(5);
    expect(snapshot.fpsBuckets.viewer.mesh["0-4"]).toBe(1);
    expect(snapshot.samplesAccepted).toBe(6);
  });

  it("a sample with no numeric fields still counts as accepted but buckets nothing", () => {
    recordStreamQualitySample({ role: "presenter", transport: "mesh" });
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.samplesAccepted).toBe(1);
    for (const bucket of Object.values(snapshot.fpsBuckets.presenter.mesh)) {
      expect(bucket).toBe(0);
    }
  });

  it("tracks batch accept/reject operational counters independently of samples", () => {
    recordStreamQualityBatchAccepted();
    recordStreamQualityBatchAccepted();
    recordStreamQualityBatchRejectedSchema();
    recordStreamQualityBatchRejectedRateLimit();
    recordStreamQualityBatchRejectedRateLimit();
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.batchesAccepted).toBe(2);
    expect(snapshot.batchesRejectedSchema).toBe(1);
    expect(snapshot.batchesRejectedRateLimit).toBe(2);
  });

  it("reset clears every counter", () => {
    recordStreamQualitySample({
      role: "presenter",
      transport: "mesh",
      fps: 6,
      qualityLimitationReason: "cpu",
    });
    recordStreamQualityBatchAccepted();
    resetStreamQualityMetricsForTests();
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.samplesAccepted).toBe(0);
    expect(snapshot.batchesAccepted).toBe(0);
    expect(snapshot.fpsBuckets.presenter.mesh["5-9"]).toBe(0);
    expect(snapshot.limitationReasons.mesh.cpu).toBe(0);
  });
});
