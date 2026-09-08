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

// The scheduling seam writes the session flip to Postgres; not this file's
// concern and this suite runs without a database.
vi.mock("../services/channel-sessions.js", () => ({
  markChannelSessionLive: async () => {},
  markChannelSessionEnded: async () => {},
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
  setLiveHlsChangeListener: () => {},
  setLiveHlsSfuLoadReader: () => {},
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
  getChannelLiveState,
  handleVoiceMessage,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  ROSTER_AUDIENCE_KEYFRAME_MS,
  sendAllVoiceRosters,
} = await import("./voice.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "./sockets.js"
);
const { verifyHlsViewerToken, HLS_VIEWER_TOKEN_PARAM } = await import(
  "../voice/hls-viewer-token.js"
);
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

/** The `?t=` token on a stamped playlist URL, or null. */
function tokenOf(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }
  const query = url.split("?")[1];
  if (!query) {
    return null;
  }
  return new URLSearchParams(query).get(HLS_VIEWER_TOKEN_PARAM);
}

async function watchLive(rec: Recorder, userId: string, watching: boolean) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "watch-live", channelId: CINEMA, watching },
  );
}

describe("live HLS reaches the channel", () => {
  const registered: Recorder[] = [];

  /** An authenticated socket in the sidebar: never joins the room. */
  function viewer(userId: string): Recorder {
    const rec = recorder();
    setAuthenticatedSocket(rec.socket, asUser(userId));
    registered.push(rec);
    return rec;
  }

  async function goLive() {
    bits.byUser.set("host", PERMISSION_ALL);
    const host = viewer("host");
    await join(host, "host", CINEMA);
    await claimStage(host, "host");
    await settle();
    return host;
  }

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
    for (const rec of registered) {
      deleteAuthenticatedSocket(rec.socket);
    }
    registered.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a viewer with VIEW who never joins hears channel-live with a token of their own", async () => {
    const ana = viewer("ana");
    const host = await goLive();
    const stream = egress.streams.get(CINEMA)!;

    const live = frames(ana, "channel-live");
    expect(live).toHaveLength(1);
    expect(live[0]!.channelId).toBe(CINEMA);
    expect(live[0]!.watching).toBe(0);
    const url = (live[0]!.stream as LiveHlsStream).hlsUrl;
    expect(url.startsWith(`${stream.hlsUrl}?`)).toBe(true);
    const token = tokenOf(url);
    expect(token).not.toBeNull();
    expect(
      verifyHlsViewerToken(token, {
        channelId: CINEMA,
        startedAt: stream.startedAt,
      }),
    ).toEqual({ userId: "ana", issuedAt: expect.any(Number) });
    // Ana never took a seat: nothing on the room-only path.
    expect(frames(ana, "voice-stream")).toHaveLength(0);
    // The host, in the room, hears both, each stamped for the host.
    expect(
      verifyHlsViewerToken(
        tokenOf((lastFrame(host, "voice-stream")!.stream as LiveHlsStream).hlsUrl),
        { channelId: CINEMA, startedAt: stream.startedAt },
      ),
    ).toEqual({ userId: "host", issuedAt: expect.any(Number) });
    expect(frames(host, "channel-live")).toHaveLength(1);
  });

  it("the stop reaches the channel as stream: null", async () => {
    const ana = viewer("ana");
    const host = await goLive();
    await handleVoiceMessage(
      { socket: host.socket, user: asUser("host") },
      { type: "set-sharing-screen", sharing: false },
    );
    await settle();
    const live = frames(ana, "channel-live");
    expect(live).toHaveLength(2);
    expect(live[1]!.stream).toBeNull();
    expect(lastFrame(host, "voice-stream")!.stream).toBeNull();
  });

  it("a user without VIEW hears nothing, and their watch-live is ignored", async () => {
    access.denied.add(access.key(CINEMA, "outsider"));
    const outsider = viewer("outsider");
    const ana = viewer("ana");
    await goLive();
    expect(frames(outsider, "channel-live")).toHaveLength(0);
    expect(frames(ana, "channel-live")).toHaveLength(1);

    await watchLive(outsider, "outsider", true);
    expect(outsider.frames).toHaveLength(0);
    expect(getChannelLiveState(CINEMA).watching).toBe(0);
  });

  it("watch-live counts a socket without a seat, answers it alone, and the audience hears the count on the keyframe", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ana = viewer("ana");
    const bia = viewer("bia");
    const host = await goLive();
    expect(frames(bia, "channel-live")).toHaveLength(1);

    await watchLive(ana, "ana", true);
    // Ana alone gets the reply, with her own token and the new count.
    const reply = lastFrame(ana, "channel-live")!;
    expect(reply.watching).toBe(1);
    expect(
      verifyHlsViewerToken(
        tokenOf((reply.stream as LiveHlsStream).hlsUrl),
        { channelId: CINEMA, startedAt: egress.streams.get(CINEMA)!.startedAt },
      ),
    ).toEqual({ userId: "ana", issuedAt: expect.any(Number) });
    // Nobody else heard about it: no frame per subscribe.
    expect(frames(bia, "channel-live")).toHaveLength(1);
    expect(frames(host, "channel-live")).toHaveLength(1);
    expect(getChannelLiveState(CINEMA)).toMatchObject({
      watching: 1,
      participants: 1,
    });

    // The keyframe carries the count to the whole audience, stamped each.
    await vi.advanceTimersByTimeAsync(ROSTER_AUDIENCE_KEYFRAME_MS);
    await settle();
    expect(frames(bia, "channel-live")).toHaveLength(2);
    expect(lastFrame(bia, "channel-live")!.watching).toBe(1);
    expect(
      verifyHlsViewerToken(
        tokenOf((lastFrame(bia, "channel-live")!.stream as LiveHlsStream).hlsUrl),
        { channelId: CINEMA, startedAt: egress.streams.get(CINEMA)!.startedAt },
      ),
    ).toEqual({ userId: "bia", issuedAt: expect.any(Number) });
    expect(lastFrame(host, "channel-live")!.watching).toBe(1);

    await watchLive(ana, "ana", false);
    expect(lastFrame(ana, "channel-live")!.watching).toBe(0);
    expect(frames(bia, "channel-live")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ROSTER_AUDIENCE_KEYFRAME_MS);
    await settle();
    expect(lastFrame(bia, "channel-live")!.watching).toBe(0);
  });

  it("the clock stops when the stream is gone and nobody is watching", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ana = viewer("ana");
    const host = await goLive();
    await handleVoiceMessage(
      { socket: host.socket, user: asUser("host") },
      { type: "set-sharing-screen", sharing: false },
    );
    await settle();
    const before = frames(ana, "channel-live").length;
    await vi.advanceTimersByTimeAsync(ROSTER_AUDIENCE_KEYFRAME_MS * 3);
    await settle();
    expect(frames(ana, "channel-live")).toHaveLength(before);
  });

  it("a close and a seat both leave the count", async () => {
    const ana = viewer("ana");
    const bia = viewer("bia");
    await goLive();
    await watchLive(ana, "ana", true);
    await watchLive(bia, "bia", true);
    expect(getChannelLiveState(CINEMA).watching).toBe(2);

    // Ana's tab closed: the ws close path, which runs for sockets without a peer.
    removeVoicePeerBySocket(ana.socket);
    expect(getChannelLiveState(CINEMA).watching).toBe(1);

    // Bia pressed Entrar: the roster counts her now.
    await join(bia, "bia", CINEMA);
    expect(getChannelLiveState(CINEMA)).toMatchObject({
      watching: 0,
      participants: 2,
    });
    // A seat that sends watch-live is not double counted.
    await watchLive(bia, "bia", true);
    expect(getChannelLiveState(CINEMA).watching).toBe(0);
  });

  it("the join-time voice-stream and the socket-auth push are stamped for the recipient", async () => {
    await goLive();
    const stream = egress.streams.get(CINEMA)!;
    const late = viewer("late");
    await join(late, "late", CINEMA);
    const joined = lastFrame(late, "voice-stream")!;
    expect(
      verifyHlsViewerToken(
        tokenOf((joined.stream as LiveHlsStream).hlsUrl),
        { channelId: CINEMA, startedAt: stream.startedAt },
      ),
    ).toEqual({ userId: "late", issuedAt: expect.any(Number) });

    // A fresh socket, authenticating mid-stream, learns about it with the
    // rosters, and only for channels it may view.
    const fresh = viewer("fresh");
    await sendAllVoiceRosters(fresh.socket, asUser("fresh"));
    const pushed = lastFrame(fresh, "channel-live")!;
    expect(pushed.channelId).toBe(CINEMA);
    expect(
      verifyHlsViewerToken(
        tokenOf((pushed.stream as LiveHlsStream).hlsUrl),
        { channelId: CINEMA, startedAt: stream.startedAt },
      ),
    ).toEqual({ userId: "fresh", issuedAt: expect.any(Number) });

    access.denied.add(access.key(CINEMA, "banned"));
    const banned = viewer("banned");
    await sendAllVoiceRosters(banned.socket, asUser("banned"));
    expect(frames(banned, "channel-live")).toHaveLength(0);
    expect(frames(banned, "voice-roster")).toHaveLength(0);
  });
});
