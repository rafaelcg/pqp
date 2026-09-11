import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import {
  applyWatchPartyFrame,
  liveWatchParties,
  liveWatchPartyServerIds,
  patchWatchParty,
} from "./use-watch-parties";

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
 *
 * THE OTHER BUG THIS PINS. A `watch-party-update` for a party on another
 * server used to be written into the open server's map, so a LIVE block for
 * server A appeared in the sidebar while looking at server B. Catch-up and
 * fan-out both do this. A null frame still deletes, so a stale entry can
 * clear; the live list also drops any party whose serverId is not the open
 * server, in case one slipped in.
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
    voiceEnabled: false,
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
  const open = PARTY.serverId;

  it("applies an options-only change", () => {
    const next = applyWatchPartyFrame(
      held,
      PARTY.channelId,
      {
        ...PARTY,
        options: { ...PARTY.options, stageMode: "invited" },
      },
      open,
    );
    expect(next[PARTY.channelId].options.stageMode).toBe("invited");
  });

  it("applies a stage-only change, so a raised hand reaches the host", () => {
    const next = applyWatchPartyFrame(
      held,
      PARTY.channelId,
      {
        ...PARTY,
        stage: {
          invited: [],
          hands: [{ userId: "u", displayName: "Bob", avatarUrl: null }],
          handRaised: false,
        },
      },
      open,
    );
    expect(next[PARTY.channelId].stage.hands).toHaveLength(1);
  });

  it("applies a name change without touching another channel's party", () => {
    const other = { ...PARTY, id: "x", channelId: "other" };
    const next = applyWatchPartyFrame(
      { ...held, other },
      PARTY.channelId,
      { ...PARTY, name: "Sessao coruja" },
      open,
    );
    expect(next[PARTY.channelId].name).toBe("Sessao coruja");
    expect(next.other).toBe(other);
  });

  it("drops the party on a null frame, which is how the sidebar block goes away", () => {
    const next = applyWatchPartyFrame(held, PARTY.channelId, null, open);
    expect(next[PARTY.channelId]).toBeUndefined();
  });

  it("returns the same object when a null frame names a channel it does not hold", () => {
    expect(applyWatchPartyFrame(held, "nothing-here", null, open)).toBe(held);
  });

  it("keeps a frame from another server, for the rail, and out of this server's list", () => {
    // The rail's dot on a server you are not looking at is fed by exactly
    // these frames; the sidebar block stays this server's because
    // `liveWatchParties` filters on read.
    const foreign = {
      ...PARTY,
      channelId: "77777777-7777-4777-8777-777777777777",
      serverId: "55555555-5555-4555-8555-555555555555",
    };
    const next = applyWatchPartyFrame(held, foreign.channelId, foreign, open);
    expect(next[foreign.channelId]).toEqual(foreign);
    expect(liveWatchParties(next, open).map((p) => p.serverId)).not.toContain(
      foreign.serverId,
    );
    expect(liveWatchPartyServerIds(next)).toEqual(
      new Set([PARTY.serverId, foreign.serverId]),
    );
  });

  it("still drops a stale entry on a null frame, even while looking at another server", () => {
    const next = applyWatchPartyFrame(
      held,
      PARTY.channelId,
      null,
      "55555555-5555-4555-8555-555555555555",
    );
    expect(next[PARTY.channelId]).toBeUndefined();
  });
});

describe("patchWatchParty", () => {
  it("updates only the current party with the matching id", () => {
    const replaced = { ...PARTY, id: "replaced", reminding: false };
    const next = patchWatchParty(
      { [PARTY.channelId]: replaced },
      PARTY.id,
      { reminding: true },
    );
    expect(next).toEqual({ [PARTY.channelId]: replaced });
  });

  it("does nothing when the party has gone away", () => {
    const held = { [PARTY.channelId]: PARTY };
    expect(patchWatchParty(held, "gone", { reminding: true })).toBe(held);
  });
});

describe("liveWatchParties", () => {
  it("only counts a live party as live", () => {
    expect(
      liveWatchParties({ a: { ...PARTY, state: "draft" } }, PARTY.serverId),
    ).toHaveLength(0);
    expect(liveWatchParties({ a: PARTY }, PARTY.serverId)).toHaveLength(1);
  });

  it("puts the newest party first", () => {
    const older = { ...PARTY, id: "old", wentLiveAt: "2026-09-08T10:00:00.000Z" };
    expect(
      liveWatchParties({ a: older, b: PARTY }, PARTY.serverId).map((p) => p.id),
    ).toEqual([PARTY.id, "old"]);
  });

  it("only includes parties whose serverId is the open server", () => {
    const foreign = {
      ...PARTY,
      id: "66666666-6666-4666-8666-666666666666",
      serverId: "55555555-5555-4555-8555-555555555555",
    };
    expect(
      liveWatchParties({ a: PARTY, b: foreign }, PARTY.serverId).map((p) => p.id),
    ).toEqual([PARTY.id]);
    expect(liveWatchParties({ a: PARTY, b: foreign }, null)).toHaveLength(0);
  });
});
