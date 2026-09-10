import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE WIRE BETWEEN THE PARTY AND THE TRANSCODE, which is the half that would
 * have been missing.
 *
 * `watch-party-live.ts` decides whether the egress may run and
 * `broadcastWatchParty` is the only thing that sees every state change, so the
 * feature is two correct halves and one call between them. That call was
 * deleted on purpose while writing this and **every other test still passed**:
 * the gate's own suite sets the mark by hand, and the party suite never asks
 * about the egress. Complete on both ends and absent in the middle is
 * CLAUDE.md pitfalls 9 and 12, and this file is what catches it.
 *
 * Mocked one call deep, at the module boundary `broadcastWatchParty` reads
 * from: the row and the audience. What the row means is `watch-parties.ts`'s
 * job; this is about whether the state on it reaches the media path.
 */
const rows = vi.hoisted(() => ({
  current: {
    id: "session-1",
    channel_id: "11111111-1111-4111-8111-111111111111",
    server_id: "22222222-2222-4222-8222-222222222222",
    host_user_id: "host",
    status: "live" as string,
  },
}));

vi.mock("../services/watch-parties.js", () => ({
  getWatchPartyRow: async () => rows.current,
  loadCohostRows: async () => [],
  mapWatchParty: () => null,
  markWatchPartyHostBack: async () => {},
  markWatchPartyHostGone: async () => {},
}));

vi.mock("../services/servers.js", () => ({
  getChannelAudience: async () => new Set<string>(),
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => 0n,
}));

vi.mock("../services/users.js", () => ({
  canAccessChannel: async () => true,
}));

vi.mock("./sockets.js", () => ({
  forEachAuthenticatedSocket: () => {},
  userHasAuthenticatedSocket: () => false,
}));

const { broadcastWatchParty } = await import("./watch-party-events.js");
const {
  resetWatchPartyLiveForTests,
  setWatchPartyLiveListener,
  watchPartyKnownOver,
} = await import("./watch-party-live.js");

const CHANNEL = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resetWatchPartyLiveForTests();
  setWatchPartyLiveListener(null);
  rows.current.status = "live";
});

describe("a party's state reaches the transcode", () => {
  it("marks the channel over when the party ends", async () => {
    rows.current.status = "ended";
    await broadcastWatchParty("session-1");
    expect(watchPartyKnownOver(CHANNEL)).toBe(true);
  });

  it("marks it over when the party is cancelled", async () => {
    rows.current.status = "cancelled";
    await broadcastWatchParty("session-1");
    expect(watchPartyKnownOver(CHANNEL)).toBe(true);
  });

  it("clears the mark when a party goes live", async () => {
    rows.current.status = "ended";
    await broadcastWatchParty("session-1");
    rows.current.status = "live";
    await broadcastWatchParty("session-1");
    expect(watchPartyKnownOver(CHANNEL)).toBe(false);
  });

  /**
   * A draft is somebody thinking, and nothing is broadcast until they press Ir
   * ao vivo, so a draft created after a show must not hand the transcode
   * permission the show's end took away.
   */
  it("leaves the mark alone for a draft or a scheduled party", async () => {
    rows.current.status = "ended";
    await broadcastWatchParty("session-1");
    for (const status of ["draft", "scheduled"]) {
      rows.current.status = status;
      await broadcastWatchParty("session-1");
      expect(watchPartyKnownOver(CHANNEL)).toBe(true);
    }
  });

  /**
   * The mark alone leaves the transcode running until somebody happens to join
   * or leave the room, and a host who presses Encerrar and touches nothing
   * else is the ordinary case.
   */
  it("reconciles the stream on the spot, on the change and only on the change", async () => {
    const reconciled: string[] = [];
    setWatchPartyLiveListener((channelId) => reconciled.push(channelId));

    rows.current.status = "ended";
    await broadcastWatchParty("session-1");
    expect(reconciled).toEqual([CHANNEL]);

    // Already over: a second `ended` broadcast is not a second teardown.
    await broadcastWatchParty("session-1");
    expect(reconciled).toEqual([CHANNEL]);

    rows.current.status = "live";
    await broadcastWatchParty("session-1");
    expect(reconciled).toEqual([CHANNEL, CHANNEL]);
  });
});
