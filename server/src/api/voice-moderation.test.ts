import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * The voice-moderation routes, end to end through the real router, SQL, rank
 * checks and eviction wiring — with only the identity layer and the LiveKit
 * RPCs faked (the moderation-sfu.test.ts pattern).
 *
 * What is pinned here and nowhere else:
 * - disconnect ejects both halves (mesh peer, SFU participant) and audits it;
 * - move enforces `canAccessChannel` in both directions before the eviction
 *   carries its destination hint;
 * - the server mute is real on a LiveKit room (the SFU stops forwarding) and
 *   on BOTH transports it lands on the roster as `serverMuted`, which is the
 *   enforcement point every receiving client shares with eviction. The flag
 *   outlives the target's seat (rejoin is not an unmute button), dies with
 *   the room, and pins the target's own `muted` until a moderator clears it.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const lk = vi.hoisted(() => ({
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  removeParticipant: vi.fn(),
  mutePublishedTrack: vi.fn(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listRooms = lk.listRooms;
      listParticipants = lk.listParticipants;
      removeParticipant = lk.removeParticipant;
      mutePublishedTrack = lk.mutePublishedTrack;
    },
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("../ws/voice.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "../ws/sockets.js"
);
const { resetSfuAdminClient, settleSfuEvictions, stopSfuResweeps } =
  await import("../voice/admin.js");
const { TrackType } = await import("livekit-server-sdk");

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function configureLiveKit() {
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  resetSfuAdminClient();
}

function unconfigureLiveKit() {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  resetSfuAdminClient();
}

describeDb("voice moderation routes", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
    unconfigureLiveKit();
    stopSfuResweeps();
  });

  /** Sockets registered as authenticated (roster audience) by a test. */
  const viewers: WebSocket[] = [];

  beforeEach(async () => {
    resetApiRateLimits();
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    for (const socket of viewers.splice(0)) {
      deleteAuthenticatedSocket(socket);
    }
    stopSfuResweeps();
    configureLiveKit();
    lk.listRooms.mockReset().mockResolvedValue([]);
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.removeParticipant.mockReset().mockResolvedValue(undefined);
    lk.mutePublishedTrack.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members,
                server_bans, audit_log
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_vmod_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_vmod_member",
      displayName: "Member",
      avatarUrl: null,
    });
  });

  /** A server with the member joined, plus its voice channel id. */
  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Voice mod test" });
    expect(created.status).toBe(201);

    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const voiceChannel = created.body.channels.find((c) => c.type === "voice")!;
    return { serverId, voiceChannelId: voiceChannel.id };
  }

  async function asDbUser(id: string): Promise<DbUser> {
    const result = await getPool().query<DbUser>(
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

  interface WelcomeFrame {
    type: string;
    peerId?: string;
    self?: { muted: boolean; serverMuted: boolean };
  }

  /**
   * Put a user in the voice room over the WS path; returns peer id + frames.
   *
   * The socket is also registered as authenticated, so `voice-roster` frames
   * (which go to the channel's audience, not to the room) reach it. That is
   * how the tests below read what everybody else sees.
   */
  async function joinVoice(
    userId: string,
    voiceChannelId: string,
  ): Promise<{
    peerId: string;
    sent: string[];
    socket: WebSocket;
    welcome: WelcomeFrame;
  }> {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
      on: () => {},
    } as unknown as WebSocket;
    const user = await asDbUser(userId);
    setAuthenticatedSocket(socket, user);
    viewers.push(socket);

    await handleVoiceMessage(
      { socket, user },
      { type: "join-voice-room", voiceChannelId },
    );
    const welcome = sent
      .map((raw) => JSON.parse(raw) as WelcomeFrame)
      .find((message) => message.type === "welcome");
    expect(welcome).toBeDefined();
    return { peerId: welcome!.peerId!, sent, socket, welcome: welcome! };
  }

  function frames(sent: string[]): Array<Record<string, unknown>> {
    return sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  interface RosterParticipant {
    userId: string;
    muted: boolean;
    serverMuted: boolean;
  }

  /** The newest `voice-roster` this socket received for the room. */
  function lastRoster(
    sent: string[],
    voiceChannelId: string,
  ): RosterParticipant[] {
    const all = frames(sent).filter(
      (frame) =>
        frame.type === "voice-roster" &&
        frame.voiceChannelId === voiceChannelId,
    );
    expect(all.length).toBeGreaterThan(0);
    return all[all.length - 1]!.participants as RosterParticipant[];
  }

  function rosterEntry(
    sent: string[],
    voiceChannelId: string,
    userId: string,
  ): RosterParticipant {
    const entry = lastRoster(sent, voiceChannelId).find(
      (participant) => participant.userId === userId,
    );
    expect(entry).toBeDefined();
    return entry!;
  }

  async function leaveVoice(socket: WebSocket, userId: string) {
    await handleVoiceMessage(
      { socket, user: await asDbUser(userId) },
      { type: "leave-voice-room" },
    );
  }

  async function declareVoiceState(
    socket: WebSocket,
    userId: string,
    muted: boolean,
  ) {
    await handleVoiceMessage(
      { socket, user: await asDbUser(userId) },
      { type: "set-voice-state", muted, deafened: false },
    );
  }

  function muteCall(serverId: string, userId: string, muted: boolean) {
    return call<{ error?: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${userId}/voice-mute`,
      { muted },
    );
  }

  async function auditActions(serverId: string): Promise<string[]> {
    const result = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE server_id = $1 ORDER BY id`,
      [serverId],
    );
    return result.rows.map((row) => row.action);
  }

  // ------------------------------------------------------------- disconnect

  it("disconnect ejects the mesh peer, the SFU participant, and audits it", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const { peerId, sent } = await joinVoice(member.id, voiceChannelId);
    lk.listRooms.mockResolvedValue([{ name: voiceChannelId }]);
    lk.listParticipants.mockResolvedValue([
      { identity: peerId, metadata: JSON.stringify({ userId: member.id }) },
    ]);
    sent.length = 0;

    const res = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-disconnect`,
    );
    expect(res.status).toBe(200);
    await settleSfuEvictions();

    // The target was told, with the whole sentence, before the teardown.
    expect(frames(sent)[0]).toMatchObject({
      type: "voice-moderation",
      action: "disconnected",
      voiceChannelId,
    });

    // SFU half ran, scoped to the room, token revocation included.
    expect(lk.removeParticipant).toHaveBeenCalledTimes(1);
    const [room, identity, options] = lk.removeParticipant.mock.calls[0]!;
    expect(room).toBe(voiceChannelId);
    expect(identity).toBe(peerId);
    expect(typeof options.revokeTokenTs).toBe("bigint");

    expect(await auditActions(serverId)).toContain("member.voice_disconnect");

    // And they are actually out: a second disconnect finds nobody.
    const again = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-disconnect`,
    );
    expect(again.status).toBe(404);
  });

  it("refuses a disconnect from a plain member", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(owner.id, voiceChannelId);

    const res = await call(
      member,
      "POST",
      `/api/servers/${serverId}/members/${owner.id}/voice-disconnect`,
    );
    expect(res.status).toBe(403);
  });

  it("404s when the target is not in a voice channel of this server", async () => {
    const { serverId } = await makeServer();

    const res = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-disconnect`,
    );
    expect(res.status).toBe(404);
  });

  // ------------------------------------------------------------------- move

  async function makeSecondVoiceChannel(
    serverId: string,
    isPrivate = false,
  ): Promise<string> {
    const created = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: isPrivate ? "vip-voice" : "second-voice", type: "voice", isPrivate },
    );
    expect(created.status).toBe(201);
    return created.body.channel.id;
  }

  it("move evicts with a destination hint the target can follow", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const destination = await makeSecondVoiceChannel(serverId);
    const { sent } = await joinVoice(member.id, voiceChannelId);
    sent.length = 0;

    const res = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-move`,
      { channelId: destination },
    );
    expect(res.status).toBe(200);

    expect(frames(sent)[0]).toMatchObject({
      type: "voice-moderation",
      action: "moved",
      voiceChannelId,
      movedToChannelId: destination,
    });
    expect(await auditActions(serverId)).toContain("member.voice_move");
    await settleSfuEvictions();
  });

  it("refuses to move somebody into a channel they cannot access", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    // Private, and the member is NOT granted access — but the owner has it,
    // so this pins the *target's* access check, not the actor's.
    const privateChannel = await makeSecondVoiceChannel(serverId, true);
    await joinVoice(member.id, voiceChannelId);

    const res = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-move`,
      { channelId: privateChannel },
    );
    expect(res.status).toBe(403);
    expect(await auditActions(serverId)).not.toContain("member.voice_move");
  });

  it("refuses to move into a text channel or another server's channel", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(member.id, voiceChannelId);

    const channels = await call<{ channels: Array<{ id: string; type: string }> }>(
      owner,
      "GET",
      `/api/servers/${serverId}/channels`,
    );
    const textChannel = channels.body.channels.find((c) => c.type === "text")!;
    const text = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-move`,
      { channelId: textChannel.id },
    );
    expect(text.status).toBe(400);

    // A channel of a different server 404s — moderators cannot reach across.
    const other = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Other" });
    const foreignVoice = other.body.channels.find((c) => c.type === "voice")!;
    const foreign = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-move`,
      { channelId: foreignVoice.id },
    );
    expect(foreign.status).toBe(404);
  });

  // ------------------------------------------------------------------- mute

  it("server mute is real on a LiveKit room, and lands on the roster too", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const { peerId, sent } = await joinVoice(member.id, voiceChannelId);
    const observer = await joinVoice(owner.id, voiceChannelId);
    lk.listParticipants.mockResolvedValue([
      {
        identity: peerId,
        metadata: JSON.stringify({ userId: member.id }),
        tracks: [{ sid: "TR_mic", type: TrackType.AUDIO }],
      },
    ]);
    sent.length = 0;

    const res = await muteCall(serverId, member.id, true);
    expect(res.status).toBe(200);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith(
      voiceChannelId,
      peerId,
      "TR_mic",
      true,
    );
    // The target is told; the peer is NOT dropped: a mute is not an eviction.
    expect(frames(sent).find((f) => f.type === "voice-moderation")).toMatchObject({
      action: "muted",
    });
    expect(lk.removeParticipant).not.toHaveBeenCalled();
    expect(await auditActions(serverId)).toContain("member.voice_mute");
    // And the same flag every mesh client enforces is on the roster here as
    // well, so a tile looks the same whichever transport carried the call.
    expect(rosterEntry(observer.sent, voiceChannelId, member.id)).toMatchObject({
      muted: true,
      serverMuted: true,
    });
  });

  /** A mesh room: no LiveKit when the room opens, so it pins to mesh. */
  async function makeMeshRoom() {
    unconfigureLiveKit();
    const made = await makeServer();
    const target = await joinVoice(member.id, made.voiceChannelId);
    const observer = await joinVoice(owner.id, made.voiceChannelId);
    return { ...made, target, observer };
  }

  it("server mute on a mesh room sets the roster flag and tells the target", async () => {
    const { serverId, voiceChannelId, target, observer } = await makeMeshRoom();
    target.sent.length = 0;

    const res = await muteCall(serverId, member.id, true);
    expect(res.status).toBe(200);
    // No SFU in the path: nothing to ask it. The roster is the enforcement.
    expect(lk.mutePublishedTrack).not.toHaveBeenCalled();
    expect(rosterEntry(observer.sent, voiceChannelId, member.id)).toMatchObject({
      muted: true,
      serverMuted: true,
    });
    expect(rosterEntry(observer.sent, voiceChannelId, owner.id)).toMatchObject({
      serverMuted: false,
    });
    expect(frames(target.sent).find((f) => f.type === "voice-moderation")).toMatchObject({
      action: "muted",
      voiceChannelId,
    });
    expect(await auditActions(serverId)).toContain("member.voice_mute");
  });

  it("the flag outlives the seat: leaving and rejoining comes back muted", async () => {
    const { serverId, voiceChannelId, target } = await makeMeshRoom();
    expect((await muteCall(serverId, member.id, true)).status).toBe(200);

    await leaveVoice(target.socket, member.id);
    const back = await joinVoice(member.id, voiceChannelId);

    // Both in the welcome that seats them, before any client declaration.
    expect(back.welcome.self).toMatchObject({ muted: true, serverMuted: true });
  });

  it("a moderator can clear it, and the target may then unmute", async () => {
    const { serverId, voiceChannelId, target, observer } = await makeMeshRoom();
    expect((await muteCall(serverId, member.id, true)).status).toBe(200);
    target.sent.length = 0;

    const res = await muteCall(serverId, member.id, false);
    expect(res.status).toBe(200);
    // Clearing is not an unmute: the person's mic stays off until they say.
    expect(rosterEntry(observer.sent, voiceChannelId, member.id)).toMatchObject({
      muted: true,
      serverMuted: false,
    });
    expect(frames(target.sent).find((f) => f.type === "voice-moderation")).toMatchObject({
      action: "unmuted",
    });
    expect(await auditActions(serverId)).toContain("member.voice_unmute");

    await declareVoiceState(target.socket, member.id, false);
    expect(rosterEntry(observer.sent, voiceChannelId, member.id)).toMatchObject({
      muted: false,
      serverMuted: false,
    });
  });

  it("an emptied room forgets the mute", async () => {
    const { serverId, voiceChannelId, target, observer } = await makeMeshRoom();
    expect((await muteCall(serverId, member.id, true)).status).toBe(200);

    await leaveVoice(target.socket, member.id);
    await leaveVoice(observer.socket, owner.id);
    const back = await joinVoice(member.id, voiceChannelId);

    expect(back.welcome.self).toMatchObject({ muted: false, serverMuted: false });
  });

  it("refuses the target's own unmute while server-muted; the roster stays muted", async () => {
    const { serverId, voiceChannelId, target, observer } = await makeMeshRoom();
    expect((await muteCall(serverId, member.id, true)).status).toBe(200);
    const rostersBefore = frames(observer.sent).filter(
      (f) => f.type === "voice-roster",
    ).length;

    await declareVoiceState(target.socket, member.id, false);

    expect(rosterEntry(observer.sent, voiceChannelId, member.id)).toMatchObject({
      muted: true,
      serverMuted: true,
    });
    // The refusal is a re-sent roster, so the client snaps back to what
    // everyone else sees rather than sitting on a local unmute nobody plays.
    expect(
      frames(observer.sent).filter((f) => f.type === "voice-roster").length,
    ).toBeGreaterThan(rostersBefore);
  });

  it("refuses a server mute from a plain member", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(owner.id, voiceChannelId);

    const res = await call(
      member,
      "POST",
      `/api/servers/${serverId}/members/${owner.id}/voice-mute`,
      { muted: true },
    );
    expect(res.status).toBe(403);
    expect(await auditActions(serverId)).not.toContain("member.voice_mute");
  });

  it("reports an SFU that refuses the mute instead of pretending", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(member.id, voiceChannelId);
    lk.listParticipants.mockRejectedValue(new Error("livekit unreachable"));

    const res = await call(
      owner,
      "POST",
      `/api/servers/${serverId}/members/${member.id}/voice-mute`,
      { muted: true },
    );
    expect(res.status).toBe(502);
    expect(await auditActions(serverId)).not.toContain("member.voice_mute");
  });
});
