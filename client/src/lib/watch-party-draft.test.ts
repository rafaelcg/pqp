import { describe, expect, it, vi } from "vitest";
import type { Channel, WatchParty } from "@pqp/shared";
import { ApiError } from "./api";
import {
  abandonWatchPartyDraft,
  blockingPartyFrom,
  decideDraftAbandon,
  findResumableWatchParty,
  shouldAbandonWatchPartyDraft,
  startWatchParty,
} from "./watch-party-draft";

const SERVER = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";

function party(over: Partial<WatchParty> = {}): WatchParty {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    channelId: CHANNEL,
    serverId: SERVER,
    name: "Sessão de sábado",
    description: null,
    state: "draft",
    startsAt: null,
    wentLiveAt: null,
    endedAt: null,
    hostUserId: "44444444-4444-4444-8444-444444444444",
    hostDisplayName: "Rafa",
    hostAvatarUrl: null,
    hostDisconnectedAt: null,
    cohosts: [],
    options: {} as WatchParty["options"],
    viewerRole: "host",
    stage: {} as WatchParty["stage"],
    guests: {} as WatchParty["guests"],
    reminding: false,
    ...over,
  } as WatchParty;
}

const channel = { id: CHANNEL, name: "watch-party" } as Channel;

function deps(over: Partial<Parameters<typeof startWatchParty>[1]> = {}) {
  return {
    serverId: SERVER,
    known: [] as WatchParty[],
    create: vi.fn(async () => ({ party: party(), channel })),
    reload: vi.fn(async () => [] as WatchParty[]),
    busyMessage: "Já tem alguém montando uma watch party aqui.",
    ...over,
  };
}

describe("findResumableWatchParty", () => {
  it("finds the host's own draft in the open server", () => {
    expect(findResumableWatchParty([party()], SERVER)?.state).toBe("draft");
  });

  it("finds a scheduled party the same way", () => {
    const found = findResumableWatchParty(
      [party({ state: "scheduled", startsAt: "2026-09-20T22:00:00.000Z" })],
      SERVER,
    );
    expect(found).not.toBeNull();
  });

  it("ignores a party in another server", () => {
    expect(
      findResumableWatchParty([party({ serverId: "other" })], SERVER),
    ).toBeNull();
  });

  it("ignores a party this person only watches", () => {
    expect(
      findResumableWatchParty([party({ viewerRole: "viewer" })], SERVER),
    ).toBeNull();
  });

  it("ignores a live party: that one is already running", () => {
    expect(
      findResumableWatchParty(
        [party({ state: "live", wentLiveAt: "2026-09-18T21:00:00.000Z" })],
        SERVER,
      ),
    ).toBeNull();
  });
});

describe("startWatchParty", () => {
  it("creates one when the host has none", async () => {
    const d = deps();
    const result = await startWatchParty({ name: "Sessão" }, d);
    expect(result.kind).toBe("created");
    expect(d.create).toHaveBeenCalledTimes(1);
  });

  /**
   * F5, and the second click. The host already holds their own draft, so
   * nothing is posted at all: this is the request that used to come back 409
   * and leave the server locked behind a party nobody could open.
   */
  it("does not post when this client already holds the host's draft", async () => {
    const existing = party();
    const d = deps({ known: [existing] });
    const result = await startWatchParty({ name: "Outra" }, d);
    expect(result).toEqual({ kind: "attached", party: existing });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
  });

  /** The store was stale (another tab made it). The 409 attaches instead of shouting. */
  it("attaches to the host's own party when the server answers 409", async () => {
    const existing = party();
    const d = deps({
      create: vi.fn(async () => {
        throw new ApiError(409, "This channel already has a watch party being set up");
      }),
      reload: vi.fn(async () => [existing]),
    });
    const result = await startWatchParty({ name: "Outra" }, d);
    expect(result).toEqual({ kind: "attached", party: existing });
    expect(d.reload).toHaveBeenCalledWith(SERVER);
  });

  /** A 409 for somebody else's party is a real refusal, but never the raw sentence. */
  it("replaces the server sentence when the 409 is not the caller's party", async () => {
    const d = deps({
      create: vi.fn(async () => {
        throw new ApiError(409, "This channel already has a watch party being set up, scheduled, or live");
      }),
      reload: vi.fn(async () => [party({ viewerRole: "viewer", state: "live" })]),
    });
    await expect(startWatchParty({ name: "Outra" }, d)).rejects.toMatchObject({
      status: 409,
      message: d.busyMessage,
    });
  });

  it("does not swallow an error that is not a conflict", async () => {
    const d = deps({
      create: vi.fn(async () => {
        throw new ApiError(403, "Forbidden");
      }),
    });
    await expect(startWatchParty({ name: "Outra" }, d)).rejects.toMatchObject({
      status: 403,
    });
    expect(d.reload).not.toHaveBeenCalled();
  });
});

describe("shouldAbandonWatchPartyDraft", () => {
  it("abandons a draft this tab made and walked away from", () => {
    expect(
      shouldAbandonWatchPartyDraft(party(), { createdThisSession: true }),
    ).toBe(true);
  });

  /** F5 re-attach: the reloaded tab did not make this one, so it keeps it. */
  it("keeps a draft this tab only adopted", () => {
    expect(
      shouldAbandonWatchPartyDraft(party(), { createdThisSession: false }),
    ).toBe(false);
  });

  it("never touches a scheduled party: the room was told about it", () => {
    expect(
      shouldAbandonWatchPartyDraft(party({ state: "scheduled" }), {
        createdThisSession: true,
      }),
    ).toBe(false);
  });

  it("never touches a live party", () => {
    expect(
      shouldAbandonWatchPartyDraft(
        party({ state: "live", wentLiveAt: "2026-09-18T21:00:00.000Z" }),
        { createdThisSession: true },
      ),
    ).toBe(false);
  });

  it("only the host may call it off", () => {
    expect(
      shouldAbandonWatchPartyDraft(party({ viewerRole: "cohost" }), {
        createdThisSession: true,
      }),
    ).toBe(false);
  });

  it("no party is nothing to abandon", () => {
    expect(shouldAbandonWatchPartyDraft(null, { createdThisSession: true })).toBe(
      false,
    );
  });
});

describe("abandonWatchPartyDraft", () => {
  it("cancels it and forgets it", async () => {
    const cancel = vi.fn(async () => ({}));
    const forget = vi.fn();
    await expect(
      abandonWatchPartyDraft(party(), { cancel, forget }),
    ).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith(party().id);
    expect(forget).toHaveBeenCalledWith(CHANNEL);
  });

  /** A sweep got there first. Still gone from this screen, still no throw. */
  it("forgets it even when the cancel fails", async () => {
    const forget = vi.fn();
    await expect(
      abandonWatchPartyDraft(party(), {
        cancel: async () => {
          throw new ApiError(404, "Watch party not found");
        },
        forget,
      }),
    ).resolves.toBe(false);
    expect(forget).toHaveBeenCalledWith(CHANNEL);
  });
});

/**
 * The sequence, which is the bug. Each step is one render of `App.tsx`'s
 * watcher, in the order the browser produces them.
 */
describe("decideDraftAbandon", () => {
  it("does nothing at all when this tab created no draft", () => {
    expect(
      decideDraftAbandon({
        watched: null,
        parties: [party()],
        selectedChannelId: CHANNEL,
      }),
    ).toEqual({ action: "forget" });
  });

  /**
   * The create's own await window: the draft is in the store and
   * `selectChannel` has not landed yet. Cancelling here would kill the party
   * on the click that made it.
   */
  it("waits while the setup surface has not been on screen yet", () => {
    expect(
      decideDraftAbandon({
        watched: { partyId: party().id, seen: false },
        parties: [party()],
        selectedChannelId: "some-other-channel",
      }),
    ).toEqual({ action: "wait" });
  });

  it("records the setup surface being on screen", () => {
    expect(
      decideDraftAbandon({
        watched: { partyId: party().id, seen: false },
        parties: [party()],
        selectedChannelId: CHANNEL,
      }),
    ).toEqual({ action: "seen" });
  });

  it("abandons it once the host leaves the channel", () => {
    const decision = decideDraftAbandon({
      watched: { partyId: party().id, seen: true },
      parties: [party()],
      selectedChannelId: "some-other-channel",
    });
    expect(decision.action).toBe("abandon");
  });

  it("abandons it when the host leaves the server entirely", () => {
    const decision = decideDraftAbandon({
      watched: { partyId: party().id, seen: true },
      parties: [party()],
      selectedChannelId: null,
    });
    expect(decision.action).toBe("abandon");
  });

  /** Ir ao vivo happened. There is nothing abandoned about it any more. */
  it("stops watching a draft that went live", () => {
    expect(
      decideDraftAbandon({
        watched: { partyId: party().id, seen: true },
        parties: [
          party({ state: "live", wentLiveAt: "2026-09-18T21:00:00.000Z" }),
        ],
        selectedChannelId: "some-other-channel",
      }),
    ).toEqual({ action: "forget" });
  });

  /** The host announced it. The room knows; it is not this watcher's to cancel. */
  it("stops watching a draft that was scheduled", () => {
    expect(
      decideDraftAbandon({
        watched: { partyId: party().id, seen: true },
        parties: [party({ state: "scheduled", startsAt: "2026-09-20T22:00:00.000Z" })],
        selectedChannelId: "some-other-channel",
      }),
    ).toEqual({ action: "forget" });
  });
});

describe("the 409 body", () => {
  const blocking = {
    blockingParty: {
      sessionId: "33333333-3333-4333-8333-333333333333",
      state: "draft",
      name: "Sessão de sábado",
    },
  };

  it("reads the blocking party the server named", () => {
    expect(blockingPartyFrom(new ApiError(409, "nope", null, blocking))).toEqual(
      blocking.blockingParty,
    );
  });

  it("reads nothing from an API that does not send it", () => {
    expect(blockingPartyFrom(new ApiError(409, "nope"))).toBeNull();
    expect(blockingPartyFrom(new Error("nope"))).toBeNull();
    expect(
      blockingPartyFrom(new ApiError(409, "nope", null, { blockingParty: 7 })),
    ).toBeNull();
  });

  /** The host's own draft, named by the server, opened instead of refused. */
  it("attaches to the party the 409 named when the caller runs it", async () => {
    const existing = party();
    const d = deps({
      create: vi.fn(async () => {
        throw new ApiError(409, "already has one", null, blocking);
      }),
      reload: vi.fn(async () => [existing]),
    });
    await expect(startWatchParty({ name: "Outra" }, d)).resolves.toEqual({
      kind: "attached",
      party: existing,
    });
  });

  /** Somebody else's. Say whose, so the person knows what to go and close. */
  it("names the blocking party when it is not the caller's", async () => {
    const d = deps({
      create: vi.fn(async () => {
        throw new ApiError(409, "already has one", null, blocking);
      }),
      reload: vi.fn(async () => []),
      busyNamedMessage: (name: string) => `"${name}" já está sendo montada aqui.`,
    });
    await expect(startWatchParty({ name: "Outra" }, d)).rejects.toMatchObject({
      status: 409,
      message: '"Sessão de sábado" já está sendo montada aqui.',
    });
  });
});
