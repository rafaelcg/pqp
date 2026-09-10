import { describe, expect, it } from "vitest";
import { shouldOfferCommunityHomePostToast } from "./post-toast";

describe("shouldOfferCommunityHomePostToast", () => {
  it("pops when unread rises while looking at another channel", () => {
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: false,
        unreadBefore: 0,
        unreadAfter: 1,
      }),
    ).toBe(true);
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: false,
        unreadBefore: 2,
        unreadAfter: 3,
      }),
    ).toBe(true);
  });

  it("stays quiet for the author, a pin, a delete, or a draft", () => {
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: false,
        unreadBefore: 0,
        unreadAfter: 0,
      }),
    ).toBe(false);
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: false,
        unreadBefore: 2,
        unreadAfter: 2,
      }),
    ).toBe(false);
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: false,
        unreadBefore: 2,
        unreadAfter: 1,
      }),
    ).toBe(false);
  });

  it("does not pop on top of the feed the person is already reading", () => {
    expect(
      shouldOfferCommunityHomePostToast({
        lookingAtFeed: true,
        unreadBefore: 0,
        unreadAfter: 1,
      }),
    ).toBe(false);
  });
});
