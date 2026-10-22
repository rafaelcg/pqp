import { describe, expect, it } from "vitest";
import { createFeedbackSchema, feedbackContextSchema } from "./feedback.js";

const base = { platform: "desktop" as const };

describe("feedback context voice.link", () => {
  it("accepts a full link summary", () => {
    const parsed = feedbackContextSchema.parse({
      ...base,
      voice: {
        inCall: true,
        transport: "mesh",
        link: {
          relayed: true,
          relayProtocol: "tls",
          relayHost: "turn.cloudflare.com",
          rttMsAvg: 231,
          lossPctAvg: 3.9,
          samples: 15,
          sharing: false,
          effectiveType: "4g",
          downlinkMbps: 9.5,
        },
      },
    });
    expect(parsed.voice?.link?.relayHost).toBe("turn.cloudflare.com");
  });

  it("still accepts a context from a client that sends no link", () => {
    expect(
      feedbackContextSchema.safeParse({ ...base, voice: { inCall: true } }).success,
    ).toBe(true);
  });

  it("drops a link it cannot read and keeps the rest of the context", () => {
    const parsed = feedbackContextSchema.parse({
      ...base,
      voice: { inCall: true, transport: "mesh", link: { relayProtocol: "quic" } },
    });
    expect(parsed.voice).toEqual({ inCall: true, transport: "mesh" });
  });

  it("refuses an address where a relay host belongs", () => {
    const parsed = feedbackContextSchema.parse({
      ...base,
      voice: { inCall: true, link: { relayHost: "203.0.113.7:3478" } },
    });
    expect(parsed.voice?.link).toBeUndefined();
  });

  it("never turns a bad link into a refused feedback", () => {
    const parsed = createFeedbackSchema.parse({
      kind: "bug",
      body: "audio is bad",
      context: { ...base, voice: { inCall: true, link: { lossPctAvg: 400 } } },
    });
    expect(parsed.context?.voice?.link).toBeUndefined();
  });
});
