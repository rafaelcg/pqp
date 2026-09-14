import { describe, expect, it } from "vitest";
import {
  AUDIENCE_SEAT_GRACE_MS,
  shouldReleaseAudienceWatchSeat,
} from "./watch-party-seat";

/**
 * An audience seat whose stream has genuinely ended: the client saw a stream
 * and was then told `null`, and the seat is well past its grace.
 */
const audience = {
  channelType: "watch_party",
  isAudienceSeat: true,
  isSharingScreen: false,
  voiceStatus: "connected",
  partyState: "live" as const,
  hasLiveStream: false,
  streamEnded: true,
  seatAgeMs: 60_000,
};

describe("shouldReleaseAudienceWatchSeat", () => {
  it("is false when the channel is not a watch party", () => {
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, channelType: "voice" }),
    ).toBe(false);
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, channelType: null }),
    ).toBe(false);
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, channelType: undefined }),
    ).toBe(false);
  });

  it("is false when voice is idle", () => {
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, voiceStatus: "idle" }),
    ).toBe(false);
  });

  it("is false for a host or mic seat while the party is still live", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        isAudienceSeat: false,
        hasLiveStream: false,
      }),
    ).toBe(false);
  });

  it("is true for a mic seat once the party has ended", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        isAudienceSeat: false,
        hasLiveStream: true,
        partyState: "ended",
      }),
    ).toBe(true);
  });

  it("is true for an audience seat with no stream and no share", () => {
    expect(shouldReleaseAudienceWatchSeat(audience)).toBe(true);
  });

  it("is false while the audience still has a live stream", () => {
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, hasLiveStream: true }),
    ).toBe(false);
  });

  it("is true when the party has ended or been cancelled", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        hasLiveStream: true,
        partyState: "ended",
      }),
    ).toBe(true);
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        hasLiveStream: true,
        partyState: "cancelled",
      }),
    ).toBe(true);
  });

  it("does not yank a presenter who is still sharing with no stream", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        isSharingScreen: true,
        hasLiveStream: false,
      }),
    ).toBe(false);
  });

  /**
   * 2026-09-14, 14:57:58 UTC: a viewer whose socket was on the API machine
   * NOT running the egress pressed "Entrar no palco", was seated, and left one
   * second later. No `channel-live` had reached that machine, so the
   * channel's entry was simply absent, and absent read as "no stream".
   */
  it("does not release a seat when the channel has never been described (absent entry)", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        hasLiveStream: false,
        streamEnded: false,
      }),
    ).toBe(false);
  });

  it("does not release a seat that was taken a moment ago, even with the stream reported ended", () => {
    expect(
      shouldReleaseAudienceWatchSeat({ ...audience, seatAgeMs: 1_000 }),
    ).toBe(false);
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        seatAgeMs: AUDIENCE_SEAT_GRACE_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        seatAgeMs: AUDIENCE_SEAT_GRACE_MS,
      }),
    ).toBe(true);
    // Unknown age is treated as old: the backstop keeps working for a
    // caller that has no clock, which is what every caller was before.
    expect(shouldReleaseAudienceWatchSeat({ ...audience, seatAgeMs: null })).toBe(
      true,
    );
  });

  it("still releases a mic seat inside the grace once the party has ended", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        isAudienceSeat: false,
        hasLiveStream: true,
        streamEnded: false,
        partyState: "ended",
        seatAgeMs: 500,
      }),
    ).toBe(true);
  });

  it("is false while the party is live and the stream is present", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        partyState: "live",
        hasLiveStream: true,
      }),
    ).toBe(false);
  });
});
