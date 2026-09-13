import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { ApiError } from "./api";
import { endWatchParty, type WatchPartyEndDeps } from "./watch-party-end";

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
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

function fakeDeps(over: Partial<WatchPartyEndDeps> = {}): {
  deps: WatchPartyEndDeps;
  calls: {
    applyParty: Array<[string, WatchParty | null]>;
    refresh: number;
    reportError: string[];
    stopScreenShare: number;
    leaveVoice: number;
  };
} {
  const calls = {
    applyParty: [] as Array<[string, WatchParty | null]>,
    refresh: 0,
    reportError: [] as string[],
    stopScreenShare: 0,
    leaveVoice: 0,
  };
  const deps: WatchPartyEndDeps = {
    setEnded: async () => ({ party: { ...PARTY, state: "ended" } }),
    applyParty: (channelId, party) => calls.applyParty.push([channelId, party]),
    refresh: () => {
      calls.refresh++;
    },
    // Nothing active there any more by default: the common case behind a
    // 404/409 in these tests is "this exact end already landed".
    fetchCurrentParty: async () => null,
    reportError: (message) => calls.reportError.push(message),
    isSharingScreen: () => false,
    stopScreenShare: () => {
      calls.stopScreenShare++;
    },
    currentVoiceChannelId: () => PARTY.channelId,
    leaveVoice: () => {
      calls.leaveVoice++;
    },
    fallbackErrorMessage: "Could not end the party",
    ...over,
  };
  return { deps, calls };
}

describe("endWatchParty", () => {
  it("applies the answer, stops a running share and leaves the room on success", async () => {
    const { deps, calls } = fakeDeps({ isSharingScreen: () => true });
    await endWatchParty(PARTY, deps);
    expect(calls.applyParty).toEqual([
      [PARTY.channelId, { ...PARTY, state: "ended" }],
    ]);
    expect(calls.stopScreenShare).toBe(1);
    expect(calls.leaveVoice).toBe(1);
    expect(calls.reportError).toEqual([]);
    expect(calls.refresh).toBe(0);
  });

  it("does not stop the share or leave when not presenting or not in that room", async () => {
    const { deps, calls } = fakeDeps({
      isSharingScreen: () => false,
      currentVoiceChannelId: () => "some-other-channel",
    });
    await endWatchParty(PARTY, deps);
    expect(calls.stopScreenShare).toBe(0);
    expect(calls.leaveVoice).toBe(0);
  });

  for (const status of [404, 409]) {
    it(`confirms the channel is empty and cleans up on a ${status} (this end already landed)`, async () => {
      const { deps, calls } = fakeDeps({
        setEnded: async () => {
          throw new ApiError(status, "gone");
        },
        isSharingScreen: () => true,
        // Default fetchCurrentParty resolves null: nothing active there.
      });
      await endWatchParty(PARTY, deps);
      expect(calls.refresh).toBe(1);
      expect(calls.applyParty).toEqual([[PARTY.channelId, null]]);
      // The fetch confirmed this exact party is gone, so the same cleanup
      // as a confirmed success runs even though `setEnded` itself failed.
      expect(calls.stopScreenShare).toBe(1);
      expect(calls.leaveVoice).toBe(1);
      expect(calls.reportError).toEqual([]);
    });

    it(`leaves the call alone on a ${status} when a replacement party is now active in the channel`, async () => {
      const replacement: WatchParty = { ...PARTY, id: "99999999-9999-4999-8999-999999999999" };
      const { deps, calls } = fakeDeps({
        setEnded: async () => {
          throw new ApiError(status, "gone");
        },
        isSharingScreen: () => true,
        fetchCurrentParty: async () => replacement,
      });
      await endWatchParty(PARTY, deps);
      expect(calls.refresh).toBe(1);
      expect(calls.applyParty).toEqual([[PARTY.channelId, replacement]]);
      // A stale request must not tear down a call or share that may belong
      // to whatever replaced this party.
      expect(calls.stopScreenShare).toBe(0);
      expect(calls.leaveVoice).toBe(0);
      expect(calls.reportError).toEqual([]);
    });

    it(`leaves the call alone on a ${status} when the confirming fetch itself fails`, async () => {
      const { deps, calls } = fakeDeps({
        setEnded: async () => {
          throw new ApiError(status, "gone");
        },
        isSharingScreen: () => true,
        fetchCurrentParty: async () => {
          throw new Error("network down");
        },
      });
      await endWatchParty(PARTY, deps);
      expect(calls.refresh).toBe(1);
      // Unknown is not a confirmed end: same "stay put" fallback as before.
      expect(calls.stopScreenShare).toBe(0);
      expect(calls.leaveVoice).toBe(0);
      expect(calls.applyParty).toEqual([]);
      expect(calls.reportError).toEqual([]);
    });
  }

  it("shows an error toast, and does nothing else, on any other ApiError", async () => {
    const { deps, calls } = fakeDeps({
      setEnded: async () => {
        throw new ApiError(500, "server exploded");
      },
    });
    await endWatchParty(PARTY, deps);
    expect(calls.reportError).toEqual(["server exploded"]);
    expect(calls.refresh).toBe(0);
    expect(calls.stopScreenShare).toBe(0);
    expect(calls.leaveVoice).toBe(0);
  });

  it("shows the fallback message when the failure carries none of its own", async () => {
    const { deps, calls } = fakeDeps({
      setEnded: async () => {
        throw new Error();
      },
    });
    await endWatchParty(PARTY, deps);
    expect(calls.reportError).toEqual(["Could not end the party"]);
  });

  it("shows an error toast on a network failure that is not an ApiError at all", async () => {
    const { deps, calls } = fakeDeps({
      setEnded: async () => {
        // A rejection shape a fetch failure can genuinely produce.
        throw "network down";
      },
    });
    await endWatchParty(PARTY, deps);
    expect(calls.reportError).toEqual(["Could not end the party"]);
    expect(calls.refresh).toBe(0);
  });

  it("never leaves the room silently: a same-channel leave only follows a confirmed end", async () => {
    // The whole point of B8: the previous code path threw before the leave
    // logic ran, and had no catch, so a host who hit Encerrar during a
    // failure got no feedback AND stayed exactly where they were — but only
    // by accident, because the throw aborted everything indiscriminately.
    // This pins the same "stay put" outcome as a DELIBERATE branch, not a
    // crash: even on an ordinary 500 the room is left untouched and the host
    // is told why via `reportError`, not by silence.
    const { deps, calls } = fakeDeps({
      setEnded: async () => {
        throw new ApiError(500, "db timeout");
      },
      isSharingScreen: () => true,
    });
    await endWatchParty(PARTY, deps);
    expect(calls.stopScreenShare).toBe(0);
    expect(calls.leaveVoice).toBe(0);
    expect(calls.reportError).toEqual(["db timeout"]);
  });
});
