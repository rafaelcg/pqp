import { describe, expect, it } from "vitest";
import type { VideoReceiverSample } from "@/lib/voice-stats-probe";
import {
  isLiveReceiver,
  liveReceiverRows,
} from "@/components/voice/inbound-video-rows";

/**
 * The filter behind "Video you receive".
 *
 * The regression this pins: an SFU viewer, share playing on the stage, menu
 * saying nobody was sending them video. The sampler now produces rows for an
 * SFU room, and those rows must be shown even before the decoder has counted a
 * frame, while a mesh report's idle receiver rows must stay hidden.
 */
function row(over: Partial<VideoReceiverSample>): VideoReceiverSample {
  return {
    peerId: "peer",
    displayName: null,
    role: "unknown",
    width: null,
    height: null,
    fps: null,
    kbps: null,
    framesDecoded: null,
    decoder: null,
    freezeCount: null,
    packetsLost: null,
    ...over,
  };
}

describe("isLiveReceiver", () => {
  it("hides a mesh receiver row that has decoded nothing and carries nothing", () => {
    // Every video m-line in a mesh report has one of these, watching or not.
    expect(isLiveReceiver(row({ framesDecoded: 0, kbps: 0 }))).toBe(false);
    expect(isLiveReceiver(row({}))).toBe(false);
  });

  it("shows a mesh receiver row once frames or bytes arrive", () => {
    expect(isLiveReceiver(row({ framesDecoded: 12 }))).toBe(true);
    expect(isLiveReceiver(row({ kbps: 300 }))).toBe(true);
  });

  it("shows an SFU subscription even before the decoder has reported", () => {
    // The server only forwards a track it is receiving; the row is the proof.
    expect(
      isLiveReceiver(row({ attached: true, framesDecoded: null, kbps: null })),
    ).toBe(true);
    expect(isLiveReceiver(row({ attached: true, framesDecoded: 0 }))).toBe(
      true,
    );
  });
});

describe("liveReceiverRows", () => {
  it("keeps the live rows in a stable person-then-role order", () => {
    const rows = liveReceiverRows([
      row({ peerId: "b", displayName: "Zeca", role: "screen", attached: true }),
      row({ peerId: "a", displayName: "Ana", role: "screen", attached: true }),
      row({ peerId: "c", displayName: "Idle", role: "camera" }),
      row({ peerId: "a", displayName: "Ana", role: "camera", attached: true }),
    ]);
    expect(rows.map((r) => `${r.displayName}:${r.role}`)).toEqual([
      "Ana:camera",
      "Ana:screen",
      "Zeca:screen",
    ]);
  });

  it("yields no rows for a room where nothing is subscribed", () => {
    expect(liveReceiverRows([])).toEqual([]);
  });
});
