import { describe, expect, it } from "vitest";
import {
  advanceCall,
  COOLDOWN_MS,
  finishCall,
  startCall,
  type CallSnapshot,
} from "./call-rating";

/**
 * The rules that decide whether a person gets interrupted.
 *
 * Worth pinning because every one of them is a judgement that can be quietly
 * reversed by a plausible-looking edit, and the cost of getting them wrong is
 * paid by everybody who uses the product rather than by anybody who reads this
 * file.
 */

const snap = (over: Partial<CallSnapshot> = {}): CallSnapshot => ({
  peerCount: 2,
  usingSfu: false,
  screenSharing: false,
  channelId: "11111111-1111-1111-1111-111111111111",
  ...over,
});

const T0 = 1_700_000_000_000;
const FIVE_MINUTES = 300_000;

describe("finishCall", () => {
  it("asks after a long enough call with somebody else in it", () => {
    const call = startCall(snap(), T0);
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)).toEqual({
      durationSeconds: 300,
      peerCount: 2,
      transport: "mesh",
      hadScreenShare: false,
      channelId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("stays quiet after a call under a minute", () => {
    // Below this they are rating whether they meant to click.
    const call = startCall(snap(), T0);
    expect(finishCall(call, T0 + 59_000, 0)).toBeNull();
    expect(finishCall(call, T0 + 60_000, 0)).not.toBeNull();
  });

  it("stays quiet after a call nobody else joined", () => {
    // A call of one has no quality to rate.
    const call = startCall(snap({ peerCount: 0 }), T0);
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)).toBeNull();
  });

  it("stays quiet inside the cooldown and speaks again after it", () => {
    const call = startCall(snap(), T0);
    const end = T0 + FIVE_MINUTES;
    expect(finishCall(call, end, end - COOLDOWN_MS + 1_000)).toBeNull();
    expect(finishCall(call, end, end - COOLDOWN_MS)).not.toBeNull();
  });
});

describe("advanceCall", () => {
  it("remembers the busiest moment, not the count at the end", () => {
    // People leave before somebody hangs up. Reporting a call of five as a
    // call of one would misdescribe the thing being rated.
    let call = startCall(snap({ peerCount: 1 }), T0);
    call = advanceCall(call, snap({ peerCount: 5 }));
    call = advanceCall(call, snap({ peerCount: 1 }));
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)!.peerCount).toBe(5);
  });

  it("remembers a screen share that only happened in the middle", () => {
    let call = startCall(snap(), T0);
    call = advanceCall(call, snap({ screenSharing: true }));
    call = advanceCall(call, snap({ screenSharing: false }));
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)!.hadScreenShare).toBe(true);
  });

  it("follows a room promoted to the SFU mid-call", () => {
    // The transport is re-read rather than trusted from the join, because the
    // whole point of recording it is comparing the two honestly.
    let call = startCall(snap({ usingSfu: false }), T0);
    call = advanceCall(call, snap({ usingSfu: true }));
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)!.transport).toBe("livekit");
  });

  it("keeps the channel it started in", () => {
    let call = startCall(snap(), T0);
    call = advanceCall(call, snap({ channelId: "other" }));
    expect(finishCall(call, T0 + FIVE_MINUTES, 0)!.channelId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });
});
