import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { applyWatchPartyFrame, liveWatchParties } from "./use-watch-parties";

/**
 * The one rule this hook has: a `watch-party-update` frame is authoritative
 * and is never second-guessed.
 *
 * THE BUG THIS PINS. The first version short-circuited when the id, state,
 * name, host, co-host count and viewer role all matched, to avoid a
 * re-render. Options are none of those, so a host changing "quem pode falar"
 * mid-show updated the database, rewrote the channel's SPEAK overwrites and
 * reached every viewer's socket, and no viewer's screen changed: the Pedir
 * pra falar button never appeared. Found by counting buttons in a two-browser
 * run, which is the only place it was visible.
 */

const PARTY: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: "33333333-3333-4333-8333-333333333333",
  name: "Cinemoon",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: "44444444-4444-4444-8444-444444444444",
  hostDisplayName: "Alice",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
  },
  viewerRole: "viewer",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

describe("applyWatchPartyFrame", () => {
  const held = { [PARTY.channelId]: PARTY };

  it("applies an options-only change", () => {
    const next = applyWatchPartyFrame(held, PARTY.channelId, {
      ...PARTY,
      options: { ...PARTY.options, stageMode: "invited" },
    });
    expect(next[PARTY.channelId].options.stageMode).toBe("invited");
  });

  it("applies a stage-only change, so a raised hand reaches the host", () => {
    const next = applyWatchPartyFrame(held, PARTY.channelId, {
      ...PARTY,
      stage: {
        invited: [],
        hands: [{ userId: "u", displayName: "Bob", avatarUrl: null }],
        handRaised: false,
      },
    });
    expect(next[PARTY.channelId].stage.hands).toHaveLength(1);
  });

  it("applies a name change without touching another channel's party", () => {
    const other = { ...PARTY, id: "x", channelId: "other" };
    const next = applyWatchPartyFrame(
      { ...held, other },
      PARTY.channelId,
      { ...PARTY, name: "Sessao coruja" },
    );
    expect(next[PARTY.channelId].name).toBe("Sessao coruja");
    expect(next.other).toBe(other);
  });

  it("drops the party on a null frame, which is how the sidebar block goes away", () => {
    const next = applyWatchPartyFrame(held, PARTY.channelId, null);
    expect(next[PARTY.channelId]).toBeUndefined();
  });

  it("returns the same object when a null frame names a channel it does not hold", () => {
    expect(applyWatchPartyFrame(held, "nothing-here", null)).toBe(held);
  });
});

describe("liveWatchParties", () => {
  it("only counts a live party as live", () => {
    expect(liveWatchParties({ a: { ...PARTY, state: "draft" } })).toHaveLength(0);
    expect(liveWatchParties({ a: PARTY })).toHaveLength(1);
  });

  it("puts the newest party first", () => {
    const older = { ...PARTY, id: "old", wentLiveAt: "2026-09-08T10:00:00.000Z" };
    expect(liveWatchParties({ a: older, b: PARTY }).map((p) => p.id)).toEqual([
      PARTY.id,
      "old",
    ]);
  });
});
