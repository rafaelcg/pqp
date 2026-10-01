import { describe, expect, it } from "vitest";
import {
  createCallRatingSchema,
  inboundStreamQualitySchema,
  mediaQualitySchema,
  outboundStreamQualitySchema,
} from "./call-rating.js";

function baseRating(extra: Record<string, unknown> = {}) {
  return {
    rating: 2,
    durationSeconds: 300,
    peerCount: 2,
    transport: "mesh" as const,
    hadScreenShare: true,
    ...extra,
  };
}

function outbound(extra: Record<string, unknown> = {}) {
  return {
    frameRateMedian: 18,
    frameRateP10: 6,
    frameHeightMedian: 720,
    frameHeightP10: 360,
    bandwidthLimitedSeconds: 42,
    cpuLimitedSeconds: 0,
    ...extra,
  };
}

function inbound(extra: Record<string, unknown> = {}) {
  return {
    frameRateMedian: 24,
    frameRateP10: 10,
    frameHeightMedian: 1080,
    frameHeightP10: 480,
    freezeCount: 3,
    freezeSeconds: 1.5,
    framesDropped: 12,
    ...extra,
  };
}

function mediaQuality(extra: Record<string, unknown> = {}) {
  return {
    outboundScreenShare: outbound(),
    inboundScreenShare: inbound(),
    packetLossPercent: 2.5,
    rttMsMedian: 80,
    relayed: false,
    reconnectCount: 0,
    ...extra,
  };
}

describe("outboundStreamQualitySchema", () => {
  it("accepts a full reading", () => {
    expect(outboundStreamQualitySchema.parse(outbound())).toEqual(outbound());
  });

  it("accepts every field as null (nothing sampled yet)", () => {
    const nulled = outboundStreamQualitySchema.parse({
      frameRateMedian: null,
      frameRateP10: null,
      frameHeightMedian: null,
      frameHeightP10: null,
      bandwidthLimitedSeconds: null,
      cpuLimitedSeconds: null,
    });
    expect(nulled.frameRateMedian).toBeNull();
  });

  it("refuses a frame rate or height outside the bound", () => {
    expect(() => outboundStreamQualitySchema.parse(outbound({ frameRateMedian: 1_000 }))).toThrow();
    expect(() => outboundStreamQualitySchema.parse(outbound({ frameHeightMedian: -1 }))).toThrow();
  });

  it("carries no field beyond what a sender can honestly report (no viewer-only field, no free text)", () => {
    expect(Object.keys(outboundStreamQualitySchema.parse(outbound())).sort()).toEqual(
      [
        "frameRateMedian",
        "frameRateP10",
        "frameHeightMedian",
        "frameHeightP10",
        "bandwidthLimitedSeconds",
        "cpuLimitedSeconds",
      ].sort(),
    );
    expect(() =>
      outboundStreamQualitySchema.parse(outbound({ freezeCount: 1 })),
    ).toThrow();
  });
});

describe("inboundStreamQualitySchema", () => {
  it("accepts a full reading", () => {
    expect(inboundStreamQualitySchema.parse(inbound())).toEqual(inbound());
  });

  it("refuses a negative freeze count or an absurd frame-drop count", () => {
    expect(() => inboundStreamQualitySchema.parse(inbound({ freezeCount: -1 }))).toThrow();
    expect(() =>
      inboundStreamQualitySchema.parse(inbound({ framesDropped: 50_000_000 })),
    ).toThrow();
  });

  it("carries no sender-only field", () => {
    expect(() =>
      inboundStreamQualitySchema.parse(inbound({ bandwidthLimitedSeconds: 1 })),
    ).toThrow();
  });
});

describe("mediaQualitySchema", () => {
  it("accepts a full summary", () => {
    const parsed = mediaQualitySchema.parse(mediaQuality());
    expect(parsed.reconnectCount).toBe(0);
    expect(parsed.relayed).toBe(false);
  });

  it("accepts both screen-share halves as null (audio-only call, or nothing shared)", () => {
    const parsed = mediaQualitySchema.parse(
      mediaQuality({
        outboundScreenShare: null,
        inboundScreenShare: null,
        relayed: null,
      }),
    );
    expect(parsed.outboundScreenShare).toBeNull();
    expect(parsed.relayed).toBeNull();
  });

  it("refuses packet loss outside 0-100 and a negative RTT", () => {
    expect(() => mediaQualitySchema.parse(mediaQuality({ packetLossPercent: 101 }))).toThrow();
    expect(() => mediaQualitySchema.parse(mediaQuality({ packetLossPercent: -1 }))).toThrow();
    expect(() => mediaQualitySchema.parse(mediaQuality({ rttMsMedian: -5 }))).toThrow();
  });

  it("refuses a negative or absurd reconnect count", () => {
    expect(() => mediaQualitySchema.parse(mediaQuality({ reconnectCount: -1 }))).toThrow();
    expect(() => mediaQualitySchema.parse(mediaQuality({ reconnectCount: 5_000 }))).toThrow();
  });

  it("carries no peer id, address, or other free-text field", () => {
    const keys = Object.keys(mediaQualitySchema.parse(mediaQuality())).sort();
    expect(keys).toEqual(
      [
        "outboundScreenShare",
        "inboundScreenShare",
        "packetLossPercent",
        "rttMsMedian",
        "relayed",
        "reconnectCount",
      ].sort(),
    );
    expect(() =>
      mediaQualitySchema.parse(mediaQuality({ peerId: "abc" })),
    ).toThrow();
  });
});

describe("createCallRatingSchema with mediaQuality", () => {
  it("accepts a rating with no mediaQuality at all (an older client)", () => {
    const parsed = createCallRatingSchema.parse(baseRating());
    expect(parsed.mediaQuality).toBeUndefined();
  });

  it("accepts a rating carrying a full mediaQuality summary", () => {
    const parsed = createCallRatingSchema.parse(
      baseRating({ mediaQuality: mediaQuality() }),
    );
    expect(parsed.mediaQuality?.reconnectCount).toBe(0);
    expect(parsed.mediaQuality?.outboundScreenShare?.frameRateMedian).toBe(18);
  });

  it("refuses the whole rating when the embedded mediaQuality is invalid", () => {
    expect(() =>
      createCallRatingSchema.parse(
        baseRating({ mediaQuality: mediaQuality({ packetLossPercent: 500 }) }),
      ),
    ).toThrow();
  });
});
