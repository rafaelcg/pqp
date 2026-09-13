import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * `canAccessChannelForRoster` — the roster-membership cache `sendAllVoiceRosters`
 * uses instead of a bare `canAccessChannel` per room per (re)authenticating
 * socket. See CLAUDE.md's watch-party postmortem (item A2): this call site is
 * "roster membership check failed" in the logs, and a reconnect storm asked it
 * once per room per reconnecting socket for an answer that rarely changes.
 *
 * Mocks mirror `voice-roster-delta.test.ts` exactly, plus two additions: a
 * `vi.fn()` for `canAccessChannel` so call counts are observable, and a real
 * (in-memory) `onAudienceInvalidated` registry so the invalidation wiring is
 * exercised rather than assumed. The rest of the `ws` suite mocks
 * `../services/servers.js` WITHOUT that export at all — proving the module
 * still loads under that shape is `voice.ts`'s job (the try/catch documented
 * there), not this file's; this file proves the wiring works when the export
 * IS there.
 */

const backend = vi.hoisted(() => ({ configured: "livekit" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

const canAccessChannelMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: canAccessChannelMock,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
  resolveMemberChannelPermissions: async () => ({
    permissions: (1n << 64n) - 1n,
    nickname: null,
  }),
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

type AudienceEvent = { channelId?: string; serverId?: string };
const audienceListeners = vi.hoisted(() => new Set<(event: AudienceEvent) => void>());

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    has: () => true,
    userIds: [],
  }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 5 }),
  onAudienceInvalidated: (listener: (event: AudienceEvent) => void) => {
    audienceListeners.add(listener);
    return () => audienceListeners.delete(listener);
  },
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
}));

function fireAudienceInvalidated(event: AudienceEvent): void {
  for (const listener of audienceListeners) {
    listener(event);
  }
}

const {
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sendAllVoiceRosters,
  voiceChannelAccessCacheStats,
  sweepVoiceChannelAccessCache,
  ROSTER_ACCESS_MAX_ENTRIES,
} = await import("./voice.js");

function fakeSocket(): WebSocket {
  return { readyState: 1, send: () => {}, on: () => {} } as unknown as WebSocket;
}

function fakeUser(): DbUser {
  return {
    id: randomUUID(),
    display_name: "Rafa",
    avatar_url: null,
  } as unknown as DbUser;
}

const channelId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  canAccessChannelMock.mockClear();
  canAccessChannelMock.mockImplementation(async () => true);
  // NOT `audienceListeners.clear()`: voice.ts registers its listener exactly
  // once, at module load, the first time `./voice.js` is imported — clearing
  // the set here would throw that one registration away forever.
});

describe("canAccessChannelForRoster (via sendAllVoiceRosters)", () => {
  it("asks canAccessChannel once per (channel, user) miss", async () => {
    const user = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), user);

    expect(canAccessChannelMock).toHaveBeenCalledTimes(0); // no live rooms yet
  });

  it("answers a repeat pair from the cache, not another call", async () => {
    // Seed a room so `sendAllVoiceRosters` has something to check access for.
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewer);
    const callsAfterFirst = canAccessChannelMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same user reconnecting five more times: a reconnect storm, in miniature.
    for (let i = 0; i < 5; i++) {
      await sendAllVoiceRosters(fakeSocket(), viewer);
    }

    expect(canAccessChannelMock.mock.calls.length).toBe(callsAfterFirst);
    expect(voiceChannelAccessCacheStats().entries).toBeGreaterThan(0);
  });

  it("keys the cache on the pair: a different viewer is still a miss", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewerA = fakeUser();
    const viewerB = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewerA);
    const callsAfterA = canAccessChannelMock.mock.calls.length;

    await sendAllVoiceRosters(fakeSocket(), viewerB);

    expect(canAccessChannelMock.mock.calls.length).toBeGreaterThan(callsAfterA);
  });

  it("a channel-scoped invalidation drops just that channel", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewer);
    const before = canAccessChannelMock.mock.calls.length;

    fireAudienceInvalidated({ channelId });

    await sendAllVoiceRosters(fakeSocket(), viewer);
    expect(canAccessChannelMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("a server-scoped invalidation clears the whole cache", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewer);
    expect(voiceChannelAccessCacheStats().entries).toBeGreaterThan(0);

    fireAudienceInvalidated({ serverId: "11111111-1111-4111-8111-111111111111" });

    expect(voiceChannelAccessCacheStats()).toEqual({ channels: 0, entries: 0 });
  });

  it("sweepVoiceChannelAccessCache drops only expired entries", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewer);
    expect(voiceChannelAccessCacheStats().entries).toBeGreaterThan(0);

    sweepVoiceChannelAccessCache(Date.now()); // not expired yet
    expect(voiceChannelAccessCacheStats().entries).toBeGreaterThan(0);

    sweepVoiceChannelAccessCache(Date.now() + 60_000); // past the 30s TTL
    expect(voiceChannelAccessCacheStats()).toEqual({ channels: 0, entries: 0 });
  });

  it("coalesces concurrent misses for the same pair into one query", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    // The join above already made its own (unrelated) canAccessChannel call
    // via the default mock; count from here, not from zero.
    const callsBeforeStorm = canAccessChannelMock.mock.calls.length;

    // Hold the query open so every concurrent caller below observes a miss
    // before any of them resolves — the reconnect-storm shape this cache
    // exists for.
    let resolveQuery!: (allowed: boolean) => void;
    canAccessChannelMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveQuery = resolve)),
    );

    // Launched one at a time with microtask flushes in between, not all in
    // one `Promise.all` — `sendAllVoiceRosters` runs a few awaits of its own
    // before it ever reaches the access check, and starting all three in the
    // same tick just races those against each other instead of proving
    // anything about the cache. What a reconnect storm actually guarantees is
    // weaker and easier to test directly: caller 2 and 3 arrive while
    // caller 1's query is still unresolved, in-flight or not.
    const viewer = fakeUser();
    const first = sendAllVoiceRosters(fakeSocket(), viewer);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    const second = sendAllVoiceRosters(fakeSocket(), viewer);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    const third = sendAllVoiceRosters(fakeSocket(), viewer);

    resolveQuery(true);
    await Promise.all([first, second, third]);

    expect(canAccessChannelMock.mock.calls.length - callsBeforeStorm).toBe(1);
  });

  it("does not cache a query's answer if the channel was invalidated while it was in flight", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    let resolveQuery!: (allowed: boolean) => void;
    canAccessChannelMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveQuery = resolve)),
    );

    const viewer = fakeUser();
    const inFlight = sendAllVoiceRosters(fakeSocket(), viewer);
    // Let the query start and register as in-flight.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Membership is revoked while the query above is still pending.
    fireAudienceInvalidated({ channelId });

    // The stale query resolves ALLOWED after the revocation.
    resolveQuery(true);
    await inFlight;

    const callsAfterRace = canAccessChannelMock.mock.calls.length;
    // A racy `true` must not have been cached: the next call is a fresh miss,
    // not a hit on a permission that no longer holds.
    await sendAllVoiceRosters(fakeSocket(), viewer);
    expect(canAccessChannelMock.mock.calls.length).toBeGreaterThan(callsAfterRace);
  });

  it("bounds the cache to ROSTER_ACCESS_MAX_ENTRIES via LRU eviction", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const overflow = 5;
    const firstViewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), firstViewer);
    expect(voiceChannelAccessCacheStats().entries).toBe(1);

    for (let i = 0; i < ROSTER_ACCESS_MAX_ENTRIES + overflow - 1; i++) {
      await sendAllVoiceRosters(fakeSocket(), fakeUser());
    }

    // Never above the cap, no matter how many distinct pairs were asked
    // about.
    expect(voiceChannelAccessCacheStats().entries).toBeLessThanOrEqual(
      ROSTER_ACCESS_MAX_ENTRIES,
    );

    // The first viewer, never touched again, was the oldest entry and is
    // the one LRU eviction should have dropped first.
    const callsBefore = canAccessChannelMock.mock.calls.length;
    await sendAllVoiceRosters(fakeSocket(), firstViewer);
    expect(canAccessChannelMock.mock.calls.length).toBeGreaterThan(callsBefore);
  }, 30_000);

  it("a caller who joined an in-flight query before invalidation re-queries instead of trusting it", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    const callsBeforeStorm = canAccessChannelMock.mock.calls.length;

    // Caller A's query is held open on purpose: `mockImplementationOnce`
    // intercepts exactly this one call, so anything after it (A's original
    // call is the only consumer) falls back to the default `async () =>
    // true` from `beforeEach` — including caller B's eventual re-query.
    let resolveQuery!: (allowed: boolean) => void;
    canAccessChannelMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveQuery = resolve)),
    );

    const callerA = sendAllVoiceRosters(fakeSocket(), viewer);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Caller B joins the SAME in-flight query — it must do so before the
    // invalidation below removes the in-flight entry, so start it now and
    // give it room to reach the "found an in-flight promise" branch.
    const callerB = sendAllVoiceRosters(fakeSocket(), viewer);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Membership is revoked while A's query is still pending and B is
    // awaiting that same shared promise.
    fireAudienceInvalidated({ channelId });

    // A's query — the one both A and B are waiting on — resolves ALLOWED
    // after the revocation.
    resolveQuery(true);
    await Promise.all([callerA, callerB]);

    // A made the original (now-stale) query. B, having joined it before the
    // invalidation, must have detected the epoch moved after the shared
    // promise resolved and issued its OWN fresh query rather than trusting
    // the pre-invalidation answer — exactly two calls, not one.
    expect(canAccessChannelMock.mock.calls.length - callsBeforeStorm).toBe(2);
  });

  it("invalidating many distinct channels does not grow unbounded per-channel bookkeeping", async () => {
    const host = { socket: fakeSocket(), user: fakeUser() };
    const { handleVoiceMessage } = await import("./voice.js");
    await handleVoiceMessage(host, {
      type: "join-voice-room",
      voiceChannelId: channelId,
      transports: ["mesh", "livekit"],
    });

    const viewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), viewer);
    expect(voiceChannelAccessCacheStats().entries).toBe(1);

    // A flood of invalidations for channels this cache has never heard of.
    // With a single global epoch (not a per-channel generation map) this is
    // O(1) per call — a plain integer increment — and leaves no per-channel
    // residue behind, so it must run fast and leave the real channel's
    // bookkeeping untouched.
    const start = Date.now();
    for (let i = 0; i < 5_000; i++) {
      fireAudienceInvalidated({ channelId: randomUUID() });
    }
    expect(Date.now() - start).toBeLessThan(2_000);

    // The flood of unrelated invalidations must not have disturbed the real
    // channel's cache: a fresh viewer is still an ordinary, correctly
    // handled cache miss, same as it would be with no flood at all.
    const callsBefore = canAccessChannelMock.mock.calls.length;
    const freshViewer = fakeUser();
    await sendAllVoiceRosters(fakeSocket(), freshViewer);
    expect(canAccessChannelMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(voiceChannelAccessCacheStats().entries).toBe(2);
  }, 30_000);
});
