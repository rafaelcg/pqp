import { describe, expect, it } from "vitest";
import {
  isSampledForStreamQualityTelemetry,
  STREAM_QUALITY_TELEMETRY_MAX_BATCH,
  streamQualityTelemetryBatchSchema,
  streamQualityTelemetrySampleSchema,
} from "./stream-quality-telemetry.js";

describe("streamQualityTelemetrySampleSchema", () => {
  it("accepts a minimal sample (role and transport only)", () => {
    const parsed = streamQualityTelemetrySampleSchema.parse({
      role: "presenter",
      transport: "mesh",
    });
    expect(parsed.role).toBe("presenter");
    expect(parsed.fps).toBeUndefined();
  });

  it("accepts every optional field, including the limitation reason", () => {
    const parsed = streamQualityTelemetrySampleSchema.parse({
      role: "presenter",
      transport: "livekit",
      fps: 6,
      kbps: 350,
      width: 1280,
      height: 720,
      qualityLimitationReason: "bandwidth",
    });
    expect(parsed.fps).toBe(6);
    expect(parsed.qualityLimitationReason).toBe("bandwidth");
  });

  it("refuses an unknown role or transport", () => {
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "host",
        transport: "mesh",
      }),
    ).toThrow();
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "viewer",
        transport: "cloudflare-sfu",
      }),
    ).toThrow();
  });

  it("refuses an unknown limitation reason", () => {
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "presenter",
        transport: "mesh",
        qualityLimitationReason: "network",
      }),
    ).toThrow();
  });

  it("refuses a negative or absurd fps/bitrate/resolution", () => {
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "viewer",
        transport: "mesh",
        fps: -1,
      }),
    ).toThrow();
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "viewer",
        transport: "mesh",
        kbps: 10_000_000,
      }),
    ).toThrow();
    expect(() =>
      streamQualityTelemetrySampleSchema.parse({
        role: "viewer",
        transport: "mesh",
        width: 0,
      }),
    ).toThrow();
  });
});

describe("streamQualityTelemetryBatchSchema", () => {
  it("accepts a batch of one and of the maximum size", () => {
    const one = streamQualityTelemetryBatchSchema.parse({
      samples: [{ role: "presenter", transport: "mesh" }],
    });
    expect(one.samples).toHaveLength(1);

    const max = streamQualityTelemetryBatchSchema.parse({
      samples: Array.from({ length: STREAM_QUALITY_TELEMETRY_MAX_BATCH }, () => ({
        role: "viewer",
        transport: "livekit",
      })),
    });
    expect(max.samples).toHaveLength(STREAM_QUALITY_TELEMETRY_MAX_BATCH);
  });

  it("refuses an empty batch and a batch over the cap", () => {
    expect(() =>
      streamQualityTelemetryBatchSchema.parse({ samples: [] }),
    ).toThrow();
    expect(() =>
      streamQualityTelemetryBatchSchema.parse({
        samples: Array.from(
          { length: STREAM_QUALITY_TELEMETRY_MAX_BATCH + 1 },
          () => ({ role: "viewer", transport: "mesh" }),
        ),
      }),
    ).toThrow();
  });

  it("carries no free-text field at all -- every field is a closed enum or a bounded number", () => {
    const parsed = streamQualityTelemetryBatchSchema.parse({
      samples: [
        {
          role: "presenter",
          transport: "mesh",
          fps: 30,
          kbps: 2_500,
          width: 1920,
          height: 1080,
          qualityLimitationReason: "none",
        },
      ],
    });
    expect(Object.keys(parsed.samples[0]!).sort()).toEqual(
      ["fps", "height", "kbps", "qualityLimitationReason", "role", "transport", "width"].sort(),
    );
  });
});

describe("isSampledForStreamQualityTelemetry", () => {
  it("is deterministic: the same user id always lands on the same side", () => {
    for (const userId of ["user-1", "user-2", "00000000-aaaa-bbbb-cccc-ddddeeeeffff"]) {
      const first = isSampledForStreamQualityTelemetry(userId);
      for (let i = 0; i < 10; i++) {
        expect(isSampledForStreamQualityTelemetry(userId)).toBe(first);
      }
    }
  });

  it("rate 0 samples nobody, rate 1 samples everybody", () => {
    for (const userId of ["a", "b", "c", "some-longer-uuid-looking-id"]) {
      expect(isSampledForStreamQualityTelemetry(userId, 0)).toBe(false);
      expect(isSampledForStreamQualityTelemetry(userId, 1)).toBe(true);
    }
  });

  it("roughly a fifth of a large population is sampled at the default rate", () => {
    let sampled = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) {
      if (isSampledForStreamQualityTelemetry(`user-${i}`)) {
        sampled += 1;
      }
    }
    const fraction = sampled / total;
    expect(fraction).toBeGreaterThan(0.17);
    expect(fraction).toBeLessThan(0.23);
  });

  it("is salted differently from the HLS latency sampler -- not the same coin flip reused", async () => {
    const { isSampledForHlsTelemetry } = await import("./live-hls-telemetry.js");
    let disagreements = 0;
    const total = 2_000;
    for (let i = 0; i < total; i++) {
      const userId = `user-${i}`;
      if (
        isSampledForStreamQualityTelemetry(userId, 0.5) !==
        isSampledForHlsTelemetry(userId, 0.5)
      ) {
        disagreements += 1;
      }
    }
    // Two independent 50/50 coin flips agree about half the time; a shared
    // salt would agree (near) 100% of the time.
    expect(disagreements).toBeGreaterThan(total * 0.3);
  });
});
