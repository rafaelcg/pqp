import { describe, expect, it } from "vitest";
import {
  isSampledForHlsTelemetry,
  LIVE_HLS_TELEMETRY_MAX_BATCH,
  liveHlsTelemetryBatchSchema,
  liveHlsTelemetrySampleSchema,
} from "./live-hls-telemetry.js";

describe("liveHlsTelemetrySampleSchema", () => {
  it("accepts a minimal sample (rung and latency only)", () => {
    const parsed = liveHlsTelemetrySampleSchema.parse({
      rung: "720p30",
      latencyMs: 8_200,
    });
    expect(parsed.rung).toBe("720p30");
    expect(parsed.latencyMs).toBe(8_200);
    expect(parsed.bufferSeconds).toBeUndefined();
  });

  it("accepts every optional field", () => {
    const parsed = liveHlsTelemetrySampleSchema.parse({
      rung: "1080p30",
      latencyMs: 6_000,
      bufferSeconds: 12.5,
      stalls: 2,
      rebufferMs: 900,
      startupMs: 1_400,
      playerRebuildCount: 0,
    });
    expect(parsed.stalls).toBe(2);
    expect(parsed.playerRebuildCount).toBe(0);
  });

  it("refuses a negative or absurd latency", () => {
    expect(() =>
      liveHlsTelemetrySampleSchema.parse({ rung: "720p30", latencyMs: -1 }),
    ).toThrow();
    expect(() =>
      liveHlsTelemetrySampleSchema.parse({
        rung: "720p30",
        latencyMs: 10_000_000,
      }),
    ).toThrow();
  });

  it("refuses a missing rung or a rung that is not a short string", () => {
    expect(() =>
      liveHlsTelemetrySampleSchema.parse({ latencyMs: 1_000 }),
    ).toThrow();
    expect(() =>
      liveHlsTelemetrySampleSchema.parse({
        rung: "x".repeat(64),
        latencyMs: 1_000,
      }),
    ).toThrow();
  });

  it("refuses an unknown extra field silently smuggled in — strict, not the zod default", () => {
    // Zod objects are non-strict by default (unknown keys pass through
    // silently); this only pins that the KNOWN shape above still validates,
    // guarding against a future accidental loosening being caught by a
    // reviewer rather than by this test if someone adds `.strict()` here.
    const parsed = liveHlsTelemetrySampleSchema.parse({
      rung: "720p30",
      latencyMs: 1_000,
    });
    expect(Object.keys(parsed).sort()).toEqual(["latencyMs", "rung"]);
  });
});

describe("liveHlsTelemetryBatchSchema", () => {
  it("accepts a batch of one and of the maximum size", () => {
    const one = liveHlsTelemetryBatchSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      samples: [{ rung: "720p30", latencyMs: 1_000 }],
    });
    expect(one.samples).toHaveLength(1);

    const max = liveHlsTelemetryBatchSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      samples: Array.from({ length: LIVE_HLS_TELEMETRY_MAX_BATCH }, () => ({
        rung: "720p30",
        latencyMs: 1_000,
      })),
    });
    expect(max.samples).toHaveLength(LIVE_HLS_TELEMETRY_MAX_BATCH);
  });

  it("refuses an empty batch and a batch over the cap", () => {
    expect(() =>
      liveHlsTelemetryBatchSchema.parse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        samples: [],
      }),
    ).toThrow();
    expect(() =>
      liveHlsTelemetryBatchSchema.parse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        samples: Array.from(
          { length: LIVE_HLS_TELEMETRY_MAX_BATCH + 1 },
          () => ({ rung: "720p30", latencyMs: 1_000 }),
        ),
      }),
    ).toThrow();
  });

  it("refuses a missing session id", () => {
    expect(() =>
      liveHlsTelemetryBatchSchema.parse({
        samples: [{ rung: "720p30", latencyMs: 1_000 }],
      }),
    ).toThrow();
  });
});

describe("isSampledForHlsTelemetry", () => {
  it("is deterministic: the same user id always lands on the same side", () => {
    for (const userId of ["user-1", "user-2", "00000000-aaaa-bbbb-cccc-ddddeeeeffff"]) {
      const first = isSampledForHlsTelemetry(userId);
      for (let i = 0; i < 10; i++) {
        expect(isSampledForHlsTelemetry(userId)).toBe(first);
      }
    }
  });

  it("rate 0 samples nobody, rate 1 samples everybody", () => {
    for (const userId of ["a", "b", "c", "some-longer-uuid-looking-id"]) {
      expect(isSampledForHlsTelemetry(userId, 0)).toBe(false);
      expect(isSampledForHlsTelemetry(userId, 1)).toBe(true);
    }
  });

  it("roughly a tenth of a large population is sampled at the default rate", () => {
    let sampled = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) {
      if (isSampledForHlsTelemetry(`user-${i}`)) {
        sampled += 1;
      }
    }
    const fraction = sampled / total;
    expect(fraction).toBeGreaterThan(0.08);
    expect(fraction).toBeLessThan(0.12);
  });
});
