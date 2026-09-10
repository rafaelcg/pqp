import { describe, expect, it } from "vitest";
import { shouldReleaseAudienceWatchSeat } from "./watch-party-seat";

const audience = {
  channelType: "watch_party",
  isAudienceSeat: true,
  isSharingScreen: false,
  voiceStatus: "connected",
  partyState: "live" as const,
  hasLiveStream: false,
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

  it("is false for a host or mic seat even if the stream is gone", () => {
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        isAudienceSeat: false,
        hasLiveStream: false,
      }),
    ).toBe(false);
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
