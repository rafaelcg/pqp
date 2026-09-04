import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * Mesh eviction and SFU eviction must agree about who is allowed in a call.
 * They are two independent mechanisms — one drops a signaling peer, the other
 * removes a participant from LiveKit — and the moderation hole this suite
 * guards is the case where only the first one runs.
 *
 * The API layer reaches voice moderation exclusively through the three
 * `evictVoice*` helpers below (server delete, server leave, channel turned
 * private, channel delete, private-channel member removed, kick/ban). Pinning
 * the pairing here therefore covers every one of those call sites, and any
 * future one, without re-testing each route.
 *
 * No database: the service layer under the peer bookkeeping is faked.
 */

vi.mock("../services/users.js", () => ({
  // Voice resolves the name to show through here now; the real one
  // reads `server_members.nickname`, which these tests have no table for.
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

// The timeout chokepoint queries Postgres, and this suite deliberately runs
// without one. Enforcement itself is proved end-to-end against a real database
// in services/sanctions.test.ts; here it only has to be out of the way.
vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

// Null audience short-circuits the roster fan-out, which is unrelated to
// eviction and would otherwise need the socket registry populated.
vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({ kind: "server", type: "voice" }),
  getChannelAudience: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const {
  evictVoiceChannel,
  evictVoiceUser,
  evictVoiceUsersExcept,
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
} = await import("./voice.js");
const { evictSfuRoom, evictSfuUser, evictSfuUsersExcept } = await import(
  "../voice/admin.js"
);

// The join schema requires channel ids to be UUIDs.
const VOICE_A = randomUUID();
const TEXT_B = randomUUID();

interface Recorder {
  socket: WebSocket;
  received: string[];
}

function recorder(): Recorder {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

/** Join a voice room and return the peer id the server assigned. */
async function join(
  rec: Recorder,
  userId: string,
  voiceChannelId: string,
): Promise<string> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  const welcome = rec.received
    .map((raw) => JSON.parse(raw) as { type: string; peerId?: string })
    .find((message) => message.type === "welcome");
  expect(welcome).toBeDefined();
  return welcome!.peerId!;
}

function typesOf(rec: Recorder): string[] {
  return rec.received.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

describe("voice eviction pairs mesh with SFU", () => {
  const sockets: Recorder[] = [];

  beforeEach(() => {
    // Peers live in module state; drop anything a previous test left behind.
    sockets.length = 0;
    resetVoicePeers();
    resetVoiceRateLimits();
    vi.mocked(evictSfuRoom).mockClear();
    vi.mocked(evictSfuUser).mockClear();
    vi.mocked(evictSfuUsersExcept).mockClear();
  });

  function track(rec: Recorder): Recorder {
    sockets.push(rec);
    return rec;
  }

  it("drops the mesh peer and the SFU participant on a kick or ban", async () => {
    const target = track(recorder());
    const bystander = track(recorder());
    const targetPeerId = await join(target, "banned", VOICE_A);
    await join(bystander, "innocent", VOICE_A);
    bystander.received.length = 0;

    evictVoiceUser("banned", new Set([VOICE_A, TEXT_B]));

    // Mesh half: the others tear down their connections to the evicted peer.
    expect(typesOf(bystander)).toContain("peer-left");

    // SFU half: same user, same scope — and the peer id it just removed, so a
    // participant whose token predates the metadata can still be identified.
    expect(evictSfuUser).toHaveBeenCalledTimes(1);
    const [userId, rooms, known] = vi.mocked(evictSfuUser).mock.calls[0]!;
    expect(userId).toBe("banned");
    expect(rooms).toEqual([VOICE_A, TEXT_B]);
    expect(known).toEqual(new Map([[targetPeerId, "banned"]]));
  });

  /**
   * The important one. With an SFU the media never reaches this process, so a
   * banned account can be live in the LiveKit room while this instance holds no
   * peer for them at all — another instance's socket, or a client that lost its
   * WebSocket and kept its LiveKit connection. Gating the SFU call on a local
   * peer being found would reinstate exactly the hole this closes.
   */
  it("still ejects from the SFU when this instance holds no peer", () => {
    evictVoiceUser("banned", new Set([VOICE_A]));

    expect(evictSfuUser).toHaveBeenCalledWith("banned", [VOICE_A], new Map());
  });

  it("asks the SFU to sweep every room when the caller gives no scope", () => {
    evictVoiceUser("banned");

    expect(evictSfuUser).toHaveBeenCalledWith("banned", null, new Map());
  });

  it("clears the SFU room when a channel is deleted", async () => {
    const rec = track(recorder());
    await join(rec, "user-1", VOICE_A);

    evictVoiceChannel(VOICE_A);

    expect(evictSfuRoom).toHaveBeenCalledWith(VOICE_A);
  });

  it("keeps the allowed users when a channel turns private", async () => {
    const allowed = track(recorder());
    const revoked = track(recorder());
    const allowedPeerId = await join(allowed, "keeper", VOICE_A);
    const revokedPeerId = await join(revoked, "outsider", VOICE_A);

    evictVoiceUsersExcept(VOICE_A, new Set(["keeper"]));

    expect(evictSfuUsersExcept).toHaveBeenCalledTimes(1);
    const [room, allowedUserIds, known] = vi.mocked(evictSfuUsersExcept).mock
      .calls[0]!;
    expect(room).toBe(VOICE_A);
    expect(allowedUserIds).toEqual(new Set(["keeper"]));
    // Snapshotted before the mesh removals — otherwise the evicted peer's row
    // is already gone and the SFU sweep loses the only way to name it.
    expect(known).toEqual(
      new Map([
        [allowedPeerId, "keeper"],
        [revokedPeerId, "outsider"],
      ]),
    );
  });

  it("does not touch the SFU when a peer simply leaves", async () => {
    const rec = track(recorder());
    await join(rec, "user-1", VOICE_A);

    await handleVoiceMessage(
      { socket: rec.socket, user: asUser("user-1") },
      { type: "leave-voice-room" },
    );

    // Leaving is the client's own choice; the SFU sees its own disconnect and
    // revoking the token would break an immediate rejoin.
    expect(evictSfuUser).not.toHaveBeenCalled();
    expect(evictSfuRoom).not.toHaveBeenCalled();
    expect(evictSfuUsersExcept).not.toHaveBeenCalled();
  });
});
