import { describe, expect, it } from "vitest";
import { shouldOfferCommunityHomePostToast } from "./post-toast";

const rise = {
  lookingAtFeed: false,
  hasUnreadBaseline: true,
  fromNudge: true,
  unreadBefore: 0,
  unreadAfter: 1,
};

describe("shouldOfferCommunityHomePostToast", () => {
  it("pops when unread rises while looking at another channel", () => {
    expect(shouldOfferCommunityHomePostToast(rise)).toBe(true);
    expect(
      shouldOfferCommunityHomePostToast({
        ...rise,
        unreadBefore: 2,
        unreadAfter: 3,
      }),
    ).toBe(true);
  });

  it("stays quiet for the author, a pin, a delete, or a draft", () => {
    expect(
      shouldOfferCommunityHomePostToast({ ...rise, unreadAfter: 0 }),
    ).toBe(false);
    expect(
      shouldOfferCommunityHomePostToast({
        ...rise,
        unreadBefore: 2,
        unreadAfter: 2,
      }),
    ).toBe(false);
    expect(
      shouldOfferCommunityHomePostToast({
        ...rise,
        unreadBefore: 2,
        unreadAfter: 1,
      }),
    ).toBe(false);
  });

  it("does not pop on top of the feed the person is already reading", () => {
    expect(
      shouldOfferCommunityHomePostToast({ ...rise, lookingAtFeed: true }),
    ).toBe(false);
  });

  it("does not pop until this server has an unread baseline, or without a WS nudge", () => {
    expect(
      shouldOfferCommunityHomePostToast({ ...rise, hasUnreadBaseline: false }),
    ).toBe(false);
    expect(
      shouldOfferCommunityHomePostToast({ ...rise, fromNudge: false }),
    ).toBe(false);
  });
});
