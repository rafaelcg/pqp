import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * THE FOURTH CAMERA.
 *
 * "não dá pra ter mais de 3 câmeras ligadas nessa porra", from a member of a
 * five-person server, hitting `CAMERA_LIMIT.mesh`. The limit is correct: a
 * mesh camera is a full uplink copy per peer. The room was on mesh only
 * because the server has fewer than `LARGE_SERVER_MEMBER_THRESHOLD` members,
 * which is a guess about crowd size and predicts nothing about how many of the
 * five who turned up want their faces on.
 *
 * So the room moves, and this suite is what keeps the move from becoming the
 * bug the one-transport rule exists to prevent. What is pinned here:
 *
 * - the fourth camera promotes the room instead of being refused,
 * - two people clicking at once promote it once,
 * - every seat that can follow is told, in place, keeping its peer id,
 * - a seat that cannot follow is released and told, never left on a mesh
 *   whose signaling the server has stopped relaying,
 * - the box has a budget, and over it the old refusal is exactly the old
 *   refusal,
 * - with no LiveKit configured, nothing above happens at all.
 *
 * The harness is `voice-transport.test.ts`'s: no database, the service layer
 * faked, the registry off (one instance). The two-instance half is in
 * `voice-cluster.test.ts`.
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

vi.mock("../services/users.js", () => ({
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

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
  resolveMemberChannelPermissions: async () => ({
    permissions: (1n << 64n) - 1n,
    nickname: null,
  }),
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

/** A five-member server: mesh by policy, which is the whole point. */
const rows = vi.hoisted(() => ({
  memberCount: 5,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "22222222-2222-4222-8222-222222222222",
    voice_transport: null,
  }),
  // Everybody can see the channel, so the rosters this suite counts cameras
  // from actually reach the sockets.
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
  getServerVoiceProfile: async () => ({
    isCommunity: false,
    memberCount: rows.memberCount,
  }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
  listSfuRooms: vi.fn(() => Promise.resolve([])),
}));

const {
  getRoomTransport,
  handleVoiceMessage,
  resetVoicePeers,
  resetVoicePromotions,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");

const { SOCKET_CAPS, setAuthenticatedSocket, deleteAuthenticatedSocket } =
  await import("./sockets.js");

const { CAMERA_LIMIT, SCREEN_SHARE_LIMIT } = await import("@pqp/shared");

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Seat {
  socket: WebSocket;
  frames: Frame[];
  user: DbUser;
  peerId: string;
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 6)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

const openSockets: WebSocket[] = [];

/**
 * Seat somebody in `channel`. `follows` is whether this socket declared
 * `voice-transport-changed` at auth: the web build does, iOS and Android do
 * not.
 */
async function seat(
  channel: string,
  follows = true,
): Promise<Seat> {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  openSockets.push(socket);
  const user = asUser(randomUUID());
  setAuthenticatedSocket(
    socket,
    user,
    follows ? [SOCKET_CAPS.voiceTransportChanged] : [],
  );
  await handleVoiceMessage(
    { socket, user },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      transports: ["mesh", "livekit"],
    },
  );
  const welcome = frames.find((f) => f.type === "welcome");
  if (!welcome) {
    throw new Error(`join refused: ${JSON.stringify(frames)}`);
  }
  return { socket, frames, user, peerId: welcome.peerId as string };
}

function cameraOn(person: Seat, channel: string): Promise<void> {
  return handleVoiceMessage(
    { socket: person.socket, user: person.user },
    { type: "set-camera", streamId: `stream-${person.peerId}` },
  ).then(() => {
    void channel;
  });
}

function shareOn(person: Seat): Promise<void> {
  return handleVoiceMessage(
    { socket: person.socket, user: person.user },
    { type: "set-sharing-screen", sharing: true },
  );
}

function typesOf(person: Seat): string[] {
  return person.frames.map((f) => f.type);
}

function framesOf(person: Seat, type: string): Frame[] {
  return person.frames.filter((f) => f.type === type);
}

/** Whose camera the server thinks is on, from the last roster it sent anyone. */
function camerasOn(watcher: Seat): number {
  const rosters = framesOf(watcher, "voice-roster");
  const last = rosters[rosters.length - 1];
  const people = (last?.participants ?? []) as { cameraStreamId?: unknown }[];
  return people.filter((person) => person.cameraStreamId).length;
}

const ORIGINAL_BUDGET = process.env.VOICE_PROMOTION_MAX_SFU_MBPS;

describe("promoting a mesh room so more cameras fit", () => {
  let channel: string;

  beforeEach(() => {
    for (const socket of openSockets) {
      deleteAuthenticatedSocket(socket);
    }
    openSockets.length = 0;
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    resetVoicePromotions();
    backend.configured = "livekit";
    rows.memberCount = 5;
    channel = randomUUID();
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
    } else {
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = ORIGINAL_BUDGET;
    }
  });

  /** Four people in a small server's room; the first three turn cameras on. */
  async function roomWithThreeCameras(
    options: { fourthFollows?: boolean } = {},
  ): Promise<Seat[]> {
    const people = [
      await seat(channel),
      await seat(channel),
      await seat(channel),
      await seat(channel, options.fourthFollows ?? true),
    ];
    expect(getRoomTransport(channel)).toBe("mesh");
    for (const person of people.slice(0, CAMERA_LIMIT.mesh)) {
      await cameraOn(person, channel);
    }
    expect(camerasOn(people[0]!)).toBe(CAMERA_LIMIT.mesh);
    return people;
  }

  it("moves the room to the SFU instead of refusing the fourth camera", async () => {
    const people = await roomWithThreeCameras();
    const fourth = people[3]!;

    await cameraOn(fourth, channel);

    expect(getRoomTransport(channel)).toBe("livekit");
    expect(typesOf(fourth)).not.toContain("camera-denied");
    // The camera is actually on, not merely un-refused.
    expect(camerasOn(people[0]!)).toBe(4);
  });

  it("tells every seat, keeping their peer ids", async () => {
    const people = await roomWithThreeCameras();

    await cameraOn(people[3]!, channel);

    for (const person of people) {
      const told = framesOf(person, "voice-transport-changed");
      expect(told).toHaveLength(1);
      expect(told[0]!.transport).toBe("livekit");
      expect(told[0]!.reason).toBe("cameras");
      expect(told[0]!.voiceChannelId).toBe(channel);
      // Nobody was evicted and nobody was re-seated: the same peer id, and no
      // `peer-left` for anybody in the room.
      const participants = told[0]!.participants as { peerId: string }[];
      expect(participants.map((p) => p.peerId).sort()).toEqual(
        people.map((p) => p.peerId).sort(),
      );
    }
    expect(framesOf(people[0]!, "peer-left")).toHaveLength(0);
  });

  it("promotes once when two people click in the same tick", async () => {
    const people = await roomWithThreeCameras();
    const [, , , fourth] = people;
    const fifth = await seat(channel);

    // Both cross the cap before either resolves: this is the shape the
    // feature is for (everybody turns a camera on when the call gets fun).
    await Promise.all([cameraOn(fourth!, channel), cameraOn(fifth, channel)]);

    expect(getRoomTransport(channel)).toBe("livekit");
    for (const person of people) {
      expect(framesOf(person, "voice-transport-changed")).toHaveLength(1);
    }
    // And both cameras made it: past the promotion the SFU cap is eight.
    expect(camerasOn(people[0]!)).toBe(5);
  });

  it("releases a seat that cannot follow, and tells it why", async () => {
    const people = await roomWithThreeCameras({ fourthFollows: true });
    // A phone, seated before the promotion: it never declared the capability.
    const phone = await seat(channel, false);

    await cameraOn(people[3]!, channel);

    expect(getRoomTransport(channel)).toBe("livekit");
    const refusal = framesOf(phone, "voice-transport-unsupported");
    expect(refusal).toHaveLength(1);
    expect(refusal[0]!.reason).toBe("promoted");
    expect(refusal[0]!.transport).toBe("livekit");
    // Not left in the room, where its offers would be dropped in silence.
    expect(typesOf(phone)).not.toContain("voice-transport-changed");
    expect(
      framesOf(people[0]!, "peer-left").some(
        (frame) => frame.peerId === phone.peerId,
      ),
    ).toBe(true);
  });

  it("keeps everyone else in the call when one seat cannot follow", async () => {
    const people = await roomWithThreeCameras();
    await seat(channel, false);

    await cameraOn(people[3]!, channel);

    for (const person of people) {
      expect(framesOf(person, "voice-transport-changed")).toHaveLength(1);
      expect(typesOf(person)).not.toContain("voice-transport-unsupported");
    }
  });

  it("does the same for a screen share past the mesh cap", async () => {
    const people = [
      await seat(channel),
      await seat(channel),
      await seat(channel),
    ];
    for (const person of people.slice(0, SCREEN_SHARE_LIMIT.mesh)) {
      await shareOn(person);
    }
    expect(getRoomTransport(channel)).toBe("mesh");

    await shareOn(people[2]!);

    expect(getRoomTransport(channel)).toBe("livekit");
    expect(framesOf(people[2]!, "voice-transport-changed")[0]!.reason).toBe(
      "screens",
    );
    expect(typesOf(people[2]!)).not.toContain("screen-share-denied");
  });

  describe("the budget", () => {
    it("refuses the promotion and returns the old error when over it", async () => {
      // The room itself is worth 4 * 5 * 1.5 = 30 Mbit/s once promoted.
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "10";
      const people = await roomWithThreeCameras();

      await cameraOn(people[3]!, channel);

      expect(getRoomTransport(channel)).toBe("mesh");
      expect(typesOf(people[3]!)).toContain("camera-denied");
      expect(typesOf(people[0]!)).not.toContain("voice-transport-changed");
      expect(camerasOn(people[0]!)).toBe(CAMERA_LIMIT.mesh);
    });

    it("promotes when the room fits inside it", async () => {
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "40";
      const people = await roomWithThreeCameras();

      await cameraOn(people[3]!, channel);

      expect(getRoomTransport(channel)).toBe("livekit");
    });
  });

  it("behaves exactly as before when LiveKit is not configured", async () => {
    backend.configured = "mesh";
    const people = await roomWithThreeCameras();

    await cameraOn(people[3]!, channel);

    expect(getRoomTransport(channel)).toBe("mesh");
    expect(typesOf(people[3]!)).toContain("camera-denied");
    for (const person of people) {
      expect(typesOf(person)).not.toContain("voice-transport-changed");
    }
    expect(camerasOn(people[0]!)).toBe(CAMERA_LIMIT.mesh);
  });

  it("never promotes a room that is already on the SFU", async () => {
    rows.memberCount = 40;
    const people = [await seat(channel), await seat(channel)];
    expect(getRoomTransport(channel)).toBe("livekit");

    await cameraOn(people[0]!, channel);
    await cameraOn(people[1]!, channel);

    for (const person of people) {
      expect(typesOf(person)).not.toContain("voice-transport-changed");
    }
  });
});
