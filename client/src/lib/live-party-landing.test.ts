import { describe, expect, it } from "vitest";
import { pickLivePartyChannel } from "./live-party-landing";

const channels = [{ id: "general" }, { id: "party-a" }, { id: "party-b" }];

describe("pickLivePartyChannel", () => {
  it("lands on the live party", () => {
    expect(
      pickLivePartyChannel(
        [{ channelId: "party-a", state: "live", wentLiveAt: "2026-09-26T22:01:58Z" }],
        channels,
      ),
    ).toBe("party-a");
  });

  it("ignores a party that is not on air", () => {
    for (const state of ["draft", "scheduled", "ended", "cancelled"] as const) {
      expect(
        pickLivePartyChannel(
          [{ channelId: "party-a", state, wentLiveAt: null }],
          channels,
        ),
      ).toBeNull();
    }
  });

  it("ignores a party in a channel this person cannot see", () => {
    expect(
      pickLivePartyChannel(
        [{ channelId: "private-party", state: "live", wentLiveAt: "2026-09-26T22:00:00Z" }],
        channels,
      ),
    ).toBeNull();
  });

  it("picks the party that went live most recently", () => {
    expect(
      pickLivePartyChannel(
        [
          { channelId: "party-a", state: "live", wentLiveAt: "2026-09-26T21:00:00Z" },
          { channelId: "party-b", state: "live", wentLiveAt: "2026-09-26T22:00:00Z" },
        ],
        channels,
      ),
    ).toBe("party-b");
  });

  it("answers null with nothing on air", () => {
    expect(pickLivePartyChannel([], channels)).toBeNull();
  });
});
