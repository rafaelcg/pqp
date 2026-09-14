import { describe, expect, it } from "vitest";
import {
  AUDIENCE_SEAT_GRACE_MS,
  audienceSeatAgeMs,
  nextAudienceSeatClock,
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

describe("nextAudienceSeatClock", () => {
  const CHANNEL = "c1";

  it("restarts the grace when the stage seat is taken in a room this tab was already in", () => {
    // The 2026-09-14 shape, one layer down: this tab had been in the channel
    // for a minute before pressing "Entrar no palco". Keyed on the room alone
    // (what this replaced) the seat would be born a minute old and the
    // backstop could hang it up on the first late frame.
    const sitting = nextAudienceSeatClock(null, {
      channelId: CHANNEL,
      isAudienceSeat: false,
      voiceStatus: "connected",
      now: 0,
    });
    expect(sitting).toEqual({
      channelId: CHANNEL,
      isAudienceSeat: false,
      at: 0,
    });
    const seated = nextAudienceSeatClock(sitting, {
      channelId: CHANNEL,
      isAudienceSeat: true,
      voiceStatus: "connected",
      now: 60_000,
    });
    expect(seated?.at).toBe(60_000);
    expect(audienceSeatAgeMs(seated, CHANNEL, 61_000)).toBe(1_000);
    expect(
      shouldReleaseAudienceWatchSeat({
        ...audience,
        seatAgeMs: audienceSeatAgeMs(seated, CHANNEL, 61_000),
      }),
    ).toBe(false);
  });

  it("is the same seat across a re-render, and no seat at all once idle", () => {
    const seated = nextAudienceSeatClock(null, {
      channelId: CHANNEL,
      isAudienceSeat: true,
      voiceStatus: "connected",
      now: 0,
    });
    expect(
      nextAudienceSeatClock(seated, {
        channelId: CHANNEL,
        isAudienceSeat: true,
        voiceStatus: "connected",
        now: 5_000,
      }),
    ).toBe(seated);
    expect(
      nextAudienceSeatClock(seated, {
        channelId: CHANNEL,
        isAudienceSeat: true,
        voiceStatus: "idle",
        now: 5_000,
      }),
    ).toBeNull();
    expect(
      nextAudienceSeatClock(seated, {
        channelId: null,
        isAudienceSeat: true,
        voiceStatus: "connected",
        now: 5_000,
      }),
    ).toBeNull();
    // Another room is another seat.
    expect(
      nextAudienceSeatClock(seated, {
        channelId: "c2",
        isAudienceSeat: true,
        voiceStatus: "connected",
        now: 5_000,
      })?.at,
    ).toBe(5_000);
  });

  it("an age it cannot know is not a young seat", () => {
    expect(audienceSeatAgeMs(null, CHANNEL, 1_000)).toBeNull();
    expect(
      audienceSeatAgeMs(
        { channelId: "c2", isAudienceSeat: true, at: 0 },
        CHANNEL,
        1_000,
      ),
    ).toBeNull();
  });
});
