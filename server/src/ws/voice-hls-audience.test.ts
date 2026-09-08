import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * Live HLS at the channel level: the stage gate on the egress start, the
 * `channel-live` frame to everyone who may view the channel, `watch-live`
 * counting viewers without a seat, and the per-recipient playlist token.
 *
 * Same fixture as voice-watch-party.test.ts (permissions are a per-user
 * bitfield), with the egress module faked: the real one records sessions in
 * Postgres and probes the playlist over HTTP, and neither is what this file
 * is about. `reconcileLiveHls` here answers with a stream whenever it is
 * handed a presenter, and `liveHlsStreamFor` reads that back.
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

const bits = vi.hoisted(() => ({ byUser: new Map<string, bigint>() }));

vi.mock("../services/permissions.js", async () => {
  const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
  const forUser = (userId: string) =>
    bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE;
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) =>
      forUser(userId),
    resolveMemberChannelPermissions: async (
      _serverId: string,
      userId: string,
    ) => ({ permissions: forUser(userId), nickname: null }),
  };
});

/** Who may view which channel. Absent means allowed. */
const access = vi.hoisted(() => ({
  denied: new Set<string>(),
  key: (channelId: string, userId: string) => `${channelId}:${userId}`,
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async (channelId: string, userId: string) =>
    !access.denied.has(access.key(channelId, userId)),
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

const SERVER = randomUUID();
const CINEMA = randomUUID();

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: "watch_party",
    server_id: SERVER,
    voice_transport: "livekit",
  }),
  getChannelAudience: async (channelId: string) => ({
    serverId: SERVER,
    kind: "server",
    has: (userId: string) =>
      !access.denied.has(access.key(channelId, userId)),
    userIds: [],
  }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 3 }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
}));

const egress = vi.hoisted(() => ({
  streams: new Map<string, LiveHlsStream>(),
  calls: [] as Array<[string, string | null, string | null]>,
  /** The egress start pretends the SFU has no screen track. */
  refuse: false,
}));

vi.mock("../voice/hls-egress.js", () => ({
  isLiveHlsEnabled: () => true,
  isLiveHlsEnabledForServer: () => true,
  liveHlsStreamFor: (channelId: string) =>
    egress.streams.get(channelId) ?? null,
  reconcileLiveHls: async (
    channelId: string,
    presenterPeerId: string | null,
    serverId: string | null,
  ) => {
    egress.calls.push([channelId, presenterPeerId, serverId]);
    if (!presenterPeerId || egress.refuse) {
      egress.streams.delete(channelId);
      return null;
    }
    const current = egress.streams.get(channelId);
    if (current?.presenterPeerId === presenterPeerId) {
      return current;
    }
    const startedAt = Date.now();
    const stream: LiveHlsStream = {
      hlsUrl: `/api/voice/hls-playlist/${channelId}/${startedAt}`,
      startedAt,
      presenterPeerId,
      delaySeconds: 10,
    };
    egress.streams.set(channelId, stream);
    return stream;
  },
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { pickHlsSharer } = await import("./hls-audience.js");
const { PERMISSION_ALL, PERMISSION_DEFAULT_EVERYONE } = await import(
  "@pqp/shared"
);

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function frames(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
}

function lastFrame(rec: Recorder, type: string): Frame | undefined {
  const all = frames(rec, type);
  return all[all.length - 1];
}

async function join(rec: Recorder, userId: string, voiceChannelId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  return rec;
}

async function claimStage(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "set-sharing-screen", sharing: true },
  );
}

/** `pushLiveHls` is fire-and-forget behind the share; let it settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("HLS start reads the stage gate", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    bits.byUser.clear();
    access.denied.clear();
    egress.streams.clear();
    egress.calls.length = 0;
    egress.refuse = false;
    backend.configured = "livekit";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a sharing peer without canStream never feeds the egress", () => {
    const usurper = { id: "p1", sharingScreen: true, canStream: false };
    const idle = { id: "p2", sharingScreen: false, canStream: true };
    expect(pickHlsSharer([usurper, idle])).toBeNull();
    const host = { id: "p3", sharingScreen: true, canStream: true };
    expect(pickHlsSharer([usurper, host])).toBe(host);
  });

  it("a host with START_WATCH_PARTY starts it, with the channel's server id", async () => {
    bits.byUser.set("host", PERMISSION_ALL);
    const host = await join(recorder(), "host", CINEMA);
    const peerId = lastFrame(host, "welcome")!.peerId as string;
    await claimStage(host, "host");
    await settle();
    const starts = egress.calls.filter(([, presenter]) => presenter !== null);
    expect(starts).toEqual([[CINEMA, peerId, SERVER]]);
    expect(egress.streams.get(CINEMA)?.presenterPeerId).toBe(peerId);
  });

  it("a member's refused claim never reaches the egress with a presenter", async () => {
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE);
    const member = await join(recorder(), "member", CINEMA);
    expect(lastFrame(member, "welcome")!.canStream).toBe(false);
    await claimStage(member, "member");
    await settle();
    expect(frames(member, "screen-share-denied")).toHaveLength(1);
    expect(
      egress.calls.filter(([, presenter]) => presenter !== null),
    ).toEqual([]);
    expect(egress.streams.has(CINEMA)).toBe(false);
  });
});
