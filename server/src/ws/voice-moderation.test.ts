import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * The WS half of voice moderation: notice first, then eviction — both halves
 * of the eviction (mesh peer and SFU participant), and targeting that never
 * reaches outside the channel scope it was given (which is how a server's
 * moderators are kept away from their members' DM calls).
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

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

// Null audience short-circuits the roster fan-out — targeting, not fan-out,
// is what this file tests (voice-state.test.ts covers the fan-out).
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
  disconnectVoiceUser,
  getVoiceChannelForUser,
  handleVoiceMessage,
  notifyVoiceModeration,
  resetVoicePeers,
  resetVoiceRateLimits,
} = await import("./voice.js");
const { evictSfuUser } = await import("../voice/admin.js");

const VOICE_A = randomUUID();
const VOICE_B = randomUUID();
const DM_CALL = randomUUID();

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

function framesOf(rec: Recorder): Array<Record<string, unknown>> {
  return rec.received.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe("voice moderation helpers", () => {
  const sockets: Recorder[] = [];

  beforeEach(() => {
    sockets.length = 0;
    resetVoicePeers();
    resetVoiceRateLimits();
    vi.mocked(evictSfuUser).mockClear();
  });

  function track(rec: Recorder): Recorder {
    sockets.push(rec);
    return rec;
  }

  it("finds a user's voice channel only within the given scope", async () => {
    const inServer = track(recorder());
    const inDm = track(recorder());
    await join(inServer, "member", VOICE_A);
    await join(inDm, "dm-caller", DM_CALL);

    // In scope: found.
    expect(getVoiceChannelForUser("member", new Set([VOICE_A, VOICE_B]))).toBe(
      VOICE_A,
    );
    // A DM call is not a server channel: a server's scope set never contains
    // it, so a server's moderators can never even *find* it — the same "no
    // authority over conversations" rule the timeout path enforces.
    expect(
      getVoiceChannelForUser("dm-caller", new Set([VOICE_A, VOICE_B])),
    ).toBeNull();
    expect(getVoiceChannelForUser("absent", new Set([VOICE_A]))).toBeNull();
  });

  it("disconnect: notice first, then mesh removal, then scoped SFU eviction", async () => {
    const target = track(recorder());
    const bystander = track(recorder());
    const targetPeerId = await join(target, "loud", VOICE_A);
    await join(bystander, "innocent", VOICE_A);
    target.received.length = 0;
    bystander.received.length = 0;

    disconnectVoiceUser("loud", VOICE_A, {
      message: "A moderator disconnected you from voice.",
    });

    // The target is told, with the whole sentence, before the peer teardown.
    const targetFrames = framesOf(target);
    expect(targetFrames[0]).toMatchObject({
      type: "voice-moderation",
      action: "disconnected",
      voiceChannelId: VOICE_A,
      message: "A moderator disconnected you from voice.",
    });
    expect(targetFrames[0]).not.toHaveProperty("movedToChannelId");

    // Mesh half: the others tear down their connection to the evicted peer.
    expect(framesOf(bystander)).toContainEqual(
      expect.objectContaining({ type: "peer-left", peerId: targetPeerId }),
    );

    // SFU half: same user, scoped to exactly this room, with the identity map
    // snapshotted before the mesh removal destroyed it.
    expect(evictSfuUser).toHaveBeenCalledTimes(1);
    const [userId, rooms, known] = vi.mocked(evictSfuUser).mock.calls[0]!;
    expect(userId).toBe("loud");
    expect(rooms).toEqual([VOICE_A]);
    expect(known).toEqual(new Map([[targetPeerId, "loud"]]));
  });

  it("move: the eviction notice carries the destination hint", async () => {
    const target = track(recorder());
    await join(target, "wanderer", VOICE_A);
    target.received.length = 0;

    disconnectVoiceUser("wanderer", VOICE_A, {
      movedToChannelId: VOICE_B,
      message: "A moderator moved you to General.",
    });

    expect(framesOf(target)[0]).toMatchObject({
      type: "voice-moderation",
      action: "moved",
      voiceChannelId: VOICE_A,
      movedToChannelId: VOICE_B,
      message: "A moderator moved you to General.",
    });
    // The move is still an eviction at the SFU — the target's client rejoins
    // the destination itself.
    expect(evictSfuUser).toHaveBeenCalledWith(
      "wanderer",
      [VOICE_A],
      expect.any(Map),
    );
  });

  it("notifies only the targeted user's sockets, and leaves the peer in place", async () => {
    const target = track(recorder());
    const bystander = track(recorder());
    await join(target, "muted-one", VOICE_A);
    const bystanderPeer = await join(bystander, "innocent", VOICE_A);
    target.received.length = 0;
    bystander.received.length = 0;

    notifyVoiceModeration("muted-one", VOICE_A, {
      action: "muted",
      message: "A moderator muted your microphone.",
    });

    expect(framesOf(target)).toEqual([
      expect.objectContaining({ type: "voice-moderation", action: "muted" }),
    ]);
    expect(framesOf(bystander)).toEqual([]);
    // A mute is not an eviction: nobody left, nothing swept.
    expect(evictSfuUser).not.toHaveBeenCalled();
    expect(
      getVoiceChannelForUser("muted-one", new Set([VOICE_A])),
    ).toBe(VOICE_A);
    expect(bystanderPeer).toBeTruthy();
  });
});
