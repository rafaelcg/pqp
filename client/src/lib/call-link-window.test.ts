import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackContextSchema } from "@pqp/shared";
import {
  LINK_WINDOW_MS,
  currentLinkSummary,
  noteLinkSample,
  resetLinkWindow,
} from "./call-link-window";
import { buildFeedbackContext } from "./feedback-context";
import type {
  CandidatePairSample,
  VideoSenderSample,
  VoiceStatsSnapshot,
} from "./voice-stats-probe";

function path(over: Partial<CandidatePairSample> = {}): CandidatePairSample {
  return {
    peerId: "them",
    localType: "srflx",
    remoteType: "srflx",
    relayed: false,
    rttMs: 60,
    availableOutgoingKbps: 3000,
    localAddress: "192.168.0.10",
    remoteAddress: "198.51.100.4",
    packetsLost: 0,
    packetsReceived: 100,
    ...over,
  };
}

function snap(
  paths: CandidatePairSample[],
  senders: VoiceStatsSnapshot["senders"] = [],
): VoiceStatsSnapshot {
  return { senders, receivers: [], paths };
}

afterEach(() => {
  resetLinkWindow();
  vi.unstubAllGlobals();
});

describe("call link window", () => {
  it("is empty before the first sample", () => {
    expect(currentLinkSummary(1000)).toEqual({});
  });

  it("averages round trip and weighs loss by packets, not by sample", () => {
    noteLinkSample(snap([path({ rttMs: 200, packetsLost: 0, packetsReceived: 100 })]), 1000);
    noteLinkSample(snap([path({ rttMs: 300, packetsLost: 10, packetsReceived: 90 })]), 3000);
    const link = currentLinkSummary(4000);
    expect(link.rttMsAvg).toBe(250);
    expect(link.lossPctAvg).toBe(5);
    expect(link.samples).toBe(2);
    expect(link.relayed).toBe(false);
    expect(link.relayHost).toBeUndefined();
  });

  it("names the relay path of the latest sample, host label only", () => {
    noteLinkSample(snap([path()]), 1000);
    noteLinkSample(
      snap([
        path({
          localType: "relay",
          relayed: true,
          relayProtocol: "tls",
          relayHost: "turn.cloudflare.com",
        }),
      ]),
      3000,
    );
    const link = currentLinkSummary(4000);
    expect(link).toMatchObject({
      relayed: true,
      relayProtocol: "tls",
      relayHost: "turn.cloudflare.com",
    });
    expect(JSON.stringify(link)).not.toContain("198.51.100.4");
    expect(JSON.stringify(link)).not.toContain("192.168.0.10");
  });

  it("forgets samples older than the window", () => {
    noteLinkSample(snap([path({ rttMs: 900 })]), 1000);
    noteLinkSample(snap([path({ rttMs: 40 })]), 1000 + LINK_WINDOW_MS + 1);
    const link = currentLinkSummary(1000 + LINK_WINDOW_MS + 2);
    expect(link.rttMsAvg).toBe(40);
    expect(link.samples).toBe(1);
    expect(currentLinkSummary(1000 + 3 * LINK_WINDOW_MS)).toEqual({});
  });

  it("notes a screen share going out", () => {
    const screen = { role: "screen" } as VideoSenderSample;
    noteLinkSample(snap([path()], [screen]), 1000);
    expect(currentLinkSummary(2000).sharing).toBe(true);
  });

  it("adds what the browser says about the network", () => {
    vi.stubGlobal("navigator", {
      connection: { effectiveType: "4g", downlink: 9.5 },
      language: "pt-BR",
    });
    noteLinkSample(snap([path()]), 1000);
    expect(currentLinkSummary(2000)).toMatchObject({
      effectiveType: "4g",
      downlinkMbps: 9.5,
    });
  });
});

describe("buildFeedbackContext with a call link", () => {
  it("attaches the link while in a call, and the schema accepts it", () => {
    noteLinkSample(
      snap([path({ rttMs: 230, relayed: true, localType: "relay", relayProtocol: "udp" })]),
      Date.now(),
    );
    const context = buildFeedbackContext(
      { inCall: true, transport: "mesh", watchParty: false },
      { appVersion: "abc", locale: "pt-BR" },
    );
    expect(context.voice?.link).toMatchObject({ relayed: true, relayProtocol: "udp", rttMsAvg: 230 });
    expect(feedbackContextSchema.safeParse(context).success).toBe(true);
  });

  it("sends no link out of a call, even when the window still holds samples", () => {
    noteLinkSample(snap([path()]), Date.now());
    const context = buildFeedbackContext(
      { inCall: false, transport: null, watchParty: false },
      { appVersion: "abc" },
    );
    expect(context.voice?.link).toBeUndefined();
  });
});
