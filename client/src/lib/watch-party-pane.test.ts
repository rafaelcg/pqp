import { describe, expect, it } from "vitest";
import { watchPartyPanelOwnsPane } from "./watch-party-pane";

/**
 * WHO OWNS THE PANE. The regression this pins is a host pressing Criar watch
 * party on a channel that still had a playlist going out — the second party
 * of the night, a share that outlived the party before it, a co-host still
 * presenting — and being handed the audience picture instead of their own
 * setup surface. Both stages mounted into the same slot and neither knew
 * about the other; the draft case below is the one that shipped broken.
 */
describe("watchPartyPanelOwnsPane", () => {
  const base = { hasStream: false, inCall: false, canStart: true };

  it("gives a draft the pane EVEN WITH A STREAM STILL GOING OUT", () => {
    // The whole bug in one assertion. `hasStream` said yes, the audience
    // stage drew itself, and the host's private setup surface was under it.
    expect(
      watchPartyPanelOwnsPane({ ...base, state: "draft", hasStream: true }),
    ).toBe(true);
  });

  it("gives a draft the pane with no stream, as it always did", () => {
    expect(watchPartyPanelOwnsPane({ ...base, state: "draft" })).toBe(true);
  });

  it("gives a scheduled party the pane", () => {
    expect(watchPartyPanelOwnsPane({ ...base, state: "scheduled" })).toBe(true);
  });

  it("gives the empty stage the pane for somebody who may start one", () => {
    expect(watchPartyPanelOwnsPane({ ...base, state: null })).toBe(true);
  });

  it("does not claim a quiet channel from somebody who may not start a party", () => {
    expect(
      watchPartyPanelOwnsPane({ ...base, state: null, canStart: false }),
    ).toBe(false);
  });

  it("keeps the pane while a live party has nothing on screen yet", () => {
    expect(watchPartyPanelOwnsPane({ ...base, state: "live" })).toBe(true);
  });

  it("hands a live party's pane over once there is a picture", () => {
    // Unchanged behaviour: with a stream the panel draws a bar and nothing
    // else, and the audience stage is what fills the pane.
    expect(
      watchPartyPanelOwnsPane({ ...base, state: "live", hasStream: true }),
    ).toBe(false);
  });

  it("hands the pane over the moment this person takes a seat", () => {
    // The call stage owns it from there, in every state.
    expect(
      watchPartyPanelOwnsPane({ ...base, state: "live", inCall: true }),
    ).toBe(false);
    expect(
      watchPartyPanelOwnsPane({
        ...base,
        state: "live",
        hasStream: true,
        inCall: true,
      }),
    ).toBe(false);
  });

  it("leaves a bare share alone: no party, a picture, nobody's setup surface", () => {
    expect(
      watchPartyPanelOwnsPane({ ...base, state: null, hasStream: true }),
    ).toBe(false);
  });
});
