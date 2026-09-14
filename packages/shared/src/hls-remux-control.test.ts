import { describe, expect, it } from "vitest";
import {
  remuxControlSignaturePayload,
  remuxErrorResponseSchema,
  remuxListSessionsResponseSchema,
  remuxSessionInfoSchema,
  remuxStartSessionRequestSchema,
  REMUX_CONTROL_CLOCK_SKEW_MS,
} from "./hls-remux-control.js";

const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";

const startRequest = {
  sessionId: SESSION_ID,
  room: CHANNEL_ID,
  channelId: CHANNEL_ID,
  partMs: 500,
  segmentMs: 4000,
  ringSegments: 6,
  keyframePolicy: "natural" as const,
  pliPaceMs: 500,
  pliGateFactor: 1.5,
};

describe("remuxControlSignaturePayload", () => {
  it("joins method, path, timestamp and body with newlines", () => {
    expect(remuxControlSignaturePayload("POST", "/sessions", "1000", "{}")).toBe(
      "POST\n/sessions\n1000\n{}",
    );
  });

  it("uppercases the method so GET and get sign identically", () => {
    expect(remuxControlSignaturePayload("get", "/sessions", "1000", "")).toBe(
      remuxControlSignaturePayload("GET", "/sessions", "1000", ""),
    );
  });

  it("treats an empty body as an empty string, not a literal null", () => {
    expect(
      remuxControlSignaturePayload("DELETE", "/sessions/abc", "1000", ""),
    ).toBe("DELETE\n/sessions/abc\n1000\n");
  });

  it("is sensitive to every field: no two distinct inputs collide by accident", () => {
    const a = remuxControlSignaturePayload("POST", "/sessions", "1000", "{}");
    const b = remuxControlSignaturePayload("POST", "/sessions/x", "100", "0}");
    expect(a).not.toBe(b);
  });
});

describe("remuxStartSessionRequestSchema", () => {
  it("accepts a well-formed start request", () => {
    expect(remuxStartSessionRequestSchema.parse(startRequest)).toEqual(
      startRequest,
    );
  });

  it("rejects an unknown keyframe policy", () => {
    expect(() =>
      remuxStartSessionRequestSchema.parse({ ...startRequest, keyframePolicy: "always" }),
    ).toThrow();
  });

  it("rejects a non-positive part or segment target", () => {
    expect(() =>
      remuxStartSessionRequestSchema.parse({ ...startRequest, partMs: 0 }),
    ).toThrow();
    expect(() =>
      remuxStartSessionRequestSchema.parse({ ...startRequest, segmentMs: -1 }),
    ).toThrow();
  });
});

describe("remuxSessionInfoSchema", () => {
  it("accepts a fresh, not-yet-subscribed session", () => {
    const parsed = remuxSessionInfoSchema.parse({
      sessionId: SESSION_ID,
      room: CHANNEL_ID,
      channelId: CHANNEL_ID,
      subscribed: false,
      startedAtMs: 1_725_000_000_000,
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 0,
      bytesServed: 0,
    });
    expect(parsed.subscribed).toBe(false);
  });

  it("accepts a running session with counters", () => {
    const parsed = remuxSessionInfoSchema.parse({
      sessionId: SESSION_ID,
      room: CHANNEL_ID,
      channelId: CHANNEL_ID,
      subscribed: true,
      startedAtMs: 1_725_000_000_000,
      lastPartAtMs: 1_725_000_004_500,
      lastIdrAtMs: 1_725_000_000_100,
      openSegmentMs: 3_200,
      partsWritten: 9,
      bytesServed: 184_320,
    });
    expect(parsed.partsWritten).toBe(9);
  });
});

describe("remuxListSessionsResponseSchema", () => {
  it("accepts an empty box", () => {
    expect(
      remuxListSessionsResponseSchema.parse({ sessions: [] }).sessions,
    ).toHaveLength(0);
  });
});

describe("remuxErrorResponseSchema", () => {
  it("accepts a bare error string", () => {
    expect(remuxErrorResponseSchema.parse({ error: "bad signature" }).error).toBe(
      "bad signature",
    );
  });
});

describe("REMUX_CONTROL_CLOCK_SKEW_MS", () => {
  it("is a positive, finite window", () => {
    expect(REMUX_CONTROL_CLOCK_SKEW_MS).toBeGreaterThan(0);
  });
});
