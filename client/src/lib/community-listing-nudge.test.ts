import { describe, expect, it } from "vitest";
import { winningCornerHint } from "./corner-hints";
import {
  listingNudgeSeenPatch,
  shouldFetchListingNudge,
  wantsListingNudge,
} from "./community-listing-nudge";

describe("shouldFetchListingNudge", () => {
  const base = {
    communitiesEnabled: true,
    ready: true,
    seen: false,
    automated: false,
  };

  it("asks once everything is in place", () => {
    expect(shouldFetchListingNudge(base)).toBe(true);
  });

  it("does not ask on an instance without communities", () => {
    expect(shouldFetchListingNudge({ ...base, communitiesEnabled: false })).toBe(
      false,
    );
  });

  it("does not ask before the age gate has passed", () => {
    expect(shouldFetchListingNudge({ ...base, ready: false })).toBe(false);
  });

  it("does not ask an account that already saw the card, on any device", () => {
    expect(shouldFetchListingNudge({ ...base, seen: true })).toBe(false);
  });

  it("does not ask for an automated browser", () => {
    expect(shouldFetchListingNudge({ ...base, automated: true })).toBe(false);
  });
});

describe("wantsListingNudge", () => {
  it("wants the corner with a room to ask about", () => {
    expect(
      wantsListingNudge({
        hasCandidate: true,
        closed: false,
        campaignsYield: false,
      }),
    ).toBe(true);
  });

  it("yields to a live party or the watch-now strip, like every campaign", () => {
    expect(
      wantsListingNudge({
        hasCandidate: true,
        closed: false,
        campaignsYield: true,
      }),
    ).toBe(false);
  });

  it("lets go once closed, and never wants it with nothing to ask", () => {
    expect(
      wantsListingNudge({ hasCandidate: true, closed: true, campaignsYield: false }),
    ).toBe(false);
    expect(
      wantsListingNudge({
        hasCandidate: false,
        closed: false,
        campaignsYield: false,
      }),
    ).toBe(false);
  });
});

describe("the listing nudge in the corner queue", () => {
  it("comes after the QG and before the Voz limpa nudge and the campaigns", () => {
    expect(winningCornerHint({ qg: true, listingNudge: true })).toBe("qg");
    expect(
      winningCornerHint({
        listingNudge: true,
        voiceClean: true,
        mobileBeta: true,
        whatsNew: true,
      }),
    ).toBe("listingNudge");
    expect(winningCornerHint({ update: true, listingNudge: true })).toBe(
      "update",
    );
  });
});

describe("listingNudgeSeenPatch", () => {
  it("stamps the preference the server also reads", () => {
    expect(listingNudgeSeenPatch(new Date("2026-10-12T09:00:00Z"))).toEqual({
      communityListingNudgeAt: "2026-10-12T09:00:00.000Z",
    });
  });
});
