import { describe, expect, it } from "vitest";
import {
  LIVE_HLS_PRESENCE_MAX_SPAN_MS,
  liveHlsPresenceSchema,
} from "./live-hls-telemetry.js";
import { acquisitionSchema } from "./api.js";

/**
 * What a watch-party presence beat may say about the person behind it. The
 * schema IS the privacy boundary: three device classes and bounded spans,
 * so a client cannot smuggle a user agent or a screen size through it.
 */
describe("liveHlsPresenceSchema", () => {
  it("takes a bare beat from a client that predates the report", () => {
    expect(liveHlsPresenceSchema.parse({ sessionToken: "t" })).toEqual({
      sessionToken: "t",
    });
  });

  it("takes the three classes and bounded spans", () => {
    for (const device of ["phone", "tablet", "desktop"]) {
      expect(
        liveHlsPresenceSchema.parse({
          sessionToken: "t",
          device,
          visibleMs: 25_000,
          hiddenMs: LIVE_HLS_PRESENCE_MAX_SPAN_MS,
        }).device,
      ).toBe(device);
    }
  });

  it("refuses anything finer than the three classes, and spans no beat can hold", () => {
    for (const extra of [
      { device: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" },
      { device: "watch" },
      { device: "" },
      { visibleMs: LIVE_HLS_PRESENCE_MAX_SPAN_MS + 1 },
      { hiddenMs: -1 },
      { hiddenMs: 1.5 },
    ]) {
      expect(
        liveHlsPresenceSchema.safeParse({ sessionToken: "t", ...extra }).success,
      ).toBe(false);
    }
  });
});

describe("acquisitionSchema signupSeconds", () => {
  it("takes whole seconds up to an hour", () => {
    expect(acquisitionSchema.parse({ signupSeconds: 45 })).toEqual({
      signupSeconds: 45,
    });
    expect(acquisitionSchema.safeParse({ signupSeconds: 3601 }).success).toBe(false);
    expect(acquisitionSchema.safeParse({ signupSeconds: -1 }).success).toBe(false);
    expect(acquisitionSchema.safeParse({ signupSeconds: 4.5 }).success).toBe(false);
  });
});
