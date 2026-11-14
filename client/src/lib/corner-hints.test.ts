import { describe, expect, it } from "vitest";
import { CORNER_HINT_ORDER, winningCornerHint } from "./corner-hints";

describe("winningCornerHint", () => {
  it("returns null when nobody wants the corner", () => {
    expect(winningCornerHint({})).toBeNull();
    expect(
      winningCornerHint({ notifyOffer: false, listingNudge: false }),
    ).toBeNull();
  });

  it("keeps only the Baú post, the notification offer and the listing nudge", () => {
    expect([...CORNER_HINT_ORDER]).toEqual([
      "communityHomePost",
      "notifyOffer",
      "listingNudge",
    ]);
  });

  it("puts the notification offer after a Baú post, before the listing nudge", () => {
    expect(
      winningCornerHint({ notifyOffer: true, listingNudge: true }),
    ).toBe("notifyOffer");
    expect(
      winningCornerHint({ communityHomePost: true, notifyOffer: true }),
    ).toBe("communityHomePost");
    expect(winningCornerHint({ listingNudge: true })).toBe("listingNudge");
  });

  it("a live Baú post beats every other card", () => {
    expect(
      winningCornerHint({
        communityHomePost: true,
        notifyOffer: true,
        listingNudge: true,
      }),
    ).toBe("communityHomePost");
  });
});
