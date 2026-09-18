import { describe, expect, it } from "vitest";
import { watchPartySurface } from "@pqp/shared";
import { partyOwnsChannelChrome } from "./watch-party-chrome";

describe("partyOwnsChannelChrome", () => {
  it("is true while the party is live, with or without a picture yet", () => {
    expect(partyOwnsChannelChrome({ state: "live", hasStream: true })).toBe(
      true,
    );
    expect(partyOwnsChannelChrome({ state: "live", hasStream: false })).toBe(
      true,
    );
  });

  /**
   * THE STATE THAT ENDED A LIVE SHOW (2026-09-18, 20:57 UTC). The host was
   * sharing while the party row still read `scheduled`: the panel drew its
   * live bar over the bottom of the picture and `CallStage` kept its own
   * control bar there too, because the two gates asked different questions.
   * The call bar paints later at the same z, so aiming at the party's
   * controls pressed the red hang-up.
   */
  it("is true for a scheduled party once a stream is up", () => {
    expect(
      partyOwnsChannelChrome({ state: "scheduled", hasStream: true }),
    ).toBe(true);
  });

  it("is false for a scheduled party with nothing on air", () => {
    expect(
      partyOwnsChannelChrome({ state: "scheduled", hasStream: false }),
    ).toBe(false);
  });

  it("is false with no party on the channel", () => {
    expect(partyOwnsChannelChrome({ state: null, hasStream: true })).toBe(
      false,
    );
    expect(partyOwnsChannelChrome({ state: undefined, hasStream: true })).toBe(
      false,
    );
  });

  it("is false for a draft and for a party that is over", () => {
    expect(partyOwnsChannelChrome({ state: "draft", hasStream: true })).toBe(
      false,
    );
    expect(partyOwnsChannelChrome({ state: "ended", hasStream: true })).toBe(
      false,
    );
    expect(
      partyOwnsChannelChrome({ state: "cancelled", hasStream: true }),
    ).toBe(false);
  });

  /**
   * The bar is drawn by `WatchPartyPanel`, which draws it on
   * `watchPartySurface(...) === "live"`. This predicate is what decides
   * whether the call stage stands down for that bar, so the two must agree on
   * every state — a disagreement is two bars over one row of pixels, which is
   * the whole bug. `liveUntitled` (a bare share with no party row) is the one
   * live surface that is deliberately NOT the party's chrome: there is no
   * party bar to stand down for.
   */
  it("agrees with watchPartySurface's live branch on every phase", () => {
    const phases = [
      "draft",
      "scheduled",
      "live",
      "ended",
      "cancelled",
    ] as const;
    for (const state of phases) {
      for (const hasStream of [true, false]) {
        for (const inCall of [true, false]) {
          const surface = watchPartySurface({
            state,
            hasStream,
            inCall,
            canStart: true,
          });
          expect({ state, hasStream, inCall, owns: partyOwnsChannelChrome({ state, hasStream }) }).toEqual({
            state,
            hasStream,
            inCall,
            owns: surface === "live",
          });
        }
      }
    }
  });
});
