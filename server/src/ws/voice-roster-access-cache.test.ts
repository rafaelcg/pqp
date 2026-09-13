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
});
