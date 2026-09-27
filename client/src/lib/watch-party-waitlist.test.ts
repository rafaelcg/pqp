import { describe, expect, it } from "vitest";
import type { WatchPartyWaitlistState } from "@pqp/shared";
import { shouldOfferWatchPartyTeaser } from "./watch-party-waitlist";

const STATE: WatchPartyWaitlistState = {
  campaign: true,
  canRequest: true,
  available: false,
  entry: null,
};

describe("shouldOfferWatchPartyTeaser", () => {
  it("teases only where the server explicitly said no", () => {
    expect(shouldOfferWatchPartyTeaser({ hlsEnabled: false, state: STATE })).toBe(true);
  });

  it("never on a server that runs watch parties, whatever the waitlist says", () => {
    expect(shouldOfferWatchPartyTeaser({ hlsEnabled: true, state: STATE })).toBe(false);
  });

  it("not before the config has answered, nor before the waitlist has", () => {
    expect(shouldOfferWatchPartyTeaser({ hlsEnabled: null, state: STATE })).toBe(false);
    expect(shouldOfferWatchPartyTeaser({ hlsEnabled: false, state: null })).toBe(false);
  });

  it("not when the deployment is not running the campaign", () => {
    expect(
      shouldOfferWatchPartyTeaser({ hlsEnabled: false, state: { ...STATE, campaign: false } }),
    ).toBe(false);
    expect(
      shouldOfferWatchPartyTeaser({ hlsEnabled: false, state: { ...STATE, available: true } }),
    ).toBe(false);
  });
});
