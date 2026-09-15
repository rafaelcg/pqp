import { describe, expect, it } from "vitest";
import { decideGoLiveMicPrompt } from "./watch-party-go-live";

describe("decideGoLiveMicPrompt", () => {
  it("arms when the party is live, the same one requested, and the host is muted", () => {
    expect(
      decideGoLiveMicPrompt({
        wentOut: true,
        requestedPartyId: "party-1",
        party: { id: "party-1", state: "live" },
        isMuted: true,
      }),
    ).toEqual({ arm: true });
  });

  it("does not arm when the share never actually started", () => {
    expect(
      decideGoLiveMicPrompt({
        wentOut: false,
        requestedPartyId: "party-1",
        party: { id: "party-1", state: "live" },
        isMuted: true,
      }),
    ).toEqual({ arm: false, reason: "not-shared" });
  });

  it("does not arm, and is not an error, when the party is already unmuted", () => {
    expect(
      decideGoLiveMicPrompt({
        wentOut: true,
        requestedPartyId: "party-1",
        party: { id: "party-1", state: "live" },
        isMuted: false,
      }),
    ).toEqual({ arm: false, reason: "already-unmuted" });
  });

  /**
   * THE SCENARIO (Farol, 2026-09-14, round three): the host confirms
   * `HlsHostAckSheet`'s disclosure notice long enough after the go-live
   * share was requested that the party it was for has ended on its own —
   * closed from another tab, or the host-disconnect grace sweep timed it
   * out. The confirmed share still resolves `wentOut: true`; the party
   * lookup at that point is the gone-ness this guards.
   */
  it("does not arm when the party ended while the disclosure sheet was open", () => {
    expect(
      decideGoLiveMicPrompt({
        wentOut: true,
        requestedPartyId: "party-1",
        party: { id: "party-1", state: "ended" },
        isMuted: true,
      }),
    ).toEqual({ arm: false, reason: "party-gone" });
  });

  it("does not arm when the party row is gone entirely", () => {
    expect(
      decideGoLiveMicPrompt({
        wentOut: true,
        requestedPartyId: "party-1",
        party: null,
        isMuted: true,
      }),
    ).toEqual({ arm: false, reason: "party-gone" });
  });

  it("does not arm for a different party that has since gone live in the same channel", () => {
    // The channel lookup is fresh at completion time; a new party with a
    // different id occupying it is exactly as wrong a target as an empty
    // channel, even though `state` alone would read "live".
    expect(
      decideGoLiveMicPrompt({
        wentOut: true,
        requestedPartyId: "party-1",
        party: { id: "party-2", state: "live" },
        isMuted: true,
      }),
    ).toEqual({ arm: false, reason: "party-gone" });
  });
});
