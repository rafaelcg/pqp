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
  /** `channels.voice_transport`: the operator's explicit choice, or null. */
  voiceTransport: null as "mesh" | "livekit" | null,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "22222222-2222-4222-8222-222222222222",
    voice_transport: rows.voiceTransport,
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
  resetVoicePinRechecks,
  resetVoicePromotions,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");

const { SOCKET_CAPS, setAuthenticatedSocket, deleteAuthenticatedSocket } =
  await import("./sockets.js");

const {
  CAMERA_LIMIT,
  MESH_ROOM_PROMOTION_SIZE,
  MESH_VOICE_LIMIT,
  SCREEN_SHARE_LIMIT,
} = await import("@pqp/shared");

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

interface Knock {
  socket: WebSocket;
  frames: Frame[];
  user: DbUser;
  /** The peer id the server assigned, or null when the join was refused. */
  peerId: string | null;
}

/**
 * Ask to join `channel`, and report what came back whether or not it was a
 * seat. `follows` is whether this socket declared `voice-transport-changed`
 * at auth: the web build does, iOS and Android do not. `transports` is what
 * the client says it can run.
 */
async function knock(
  channel: string,
  options: {
    follows?: boolean;
    transports?: ("mesh" | "livekit")[];
  } = {},
): Promise<Knock> {
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
    (options.follows ?? true) ? [SOCKET_CAPS.voiceTransportChanged] : [],
  );
  await handleVoiceMessage(
    { socket, user },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      transports: options.transports ?? ["mesh", "livekit"],
    },
  );
  const welcome = frames.find((f) => f.type === "welcome");
  return {
    socket,
    frames,
    user,
    peerId: welcome ? (welcome.peerId as string) : null,
  };
}

/** `knock`, for a join that must succeed. */
async function seat(channel: string, follows = true): Promise<Seat> {
  const knocked = await knock(channel, { follows });
  if (!knocked.peerId) {
    throw new Error(`join refused: ${JSON.stringify(knocked.frames)}`);
  }
  return { ...knocked, peerId: knocked.peerId };
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
const ORIGINAL_ROOM_SIZE = process.env.VOICE_PROMOTION_ROOM_SIZE;

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
    resetVoicePinRechecks();
    backend.configured = "livekit";
    rows.memberCount = 5;
    rows.voiceTransport = null;
    channel = randomUUID();
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
    // Off for the groups above, which are about the CAPS: a room of four
    // would otherwise move before anybody clicked a camera, and every one of
    // those tests would be measuring the wrong trigger. Its own group turns
    // it back on.
    process.env.VOICE_PROMOTION_ROOM_SIZE = "0";
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS;
    } else {
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = ORIGINAL_BUDGET;
    }
    if (ORIGINAL_ROOM_SIZE === undefined) {
      delete process.env.VOICE_PROMOTION_ROOM_SIZE;
    } else {
      process.env.VOICE_PROMOTION_ROOM_SIZE = ORIGINAL_ROOM_SIZE;
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

  /**
   * THE NINTH PERSON.
   *
   * 2026-09-08, 16:13Z: three people in a row were refused from one voice
   * channel with `voice.roomFull limit=8`, and one of them retried 35 times
   * in two minutes. The room was on mesh, the mesh holds eight, and the
   * answer to the ninth person was "no". The mesh cap is right; refusing at
   * it is not, when there is a media server standing there.
   */
  describe("a full mesh room", () => {
    async function fullRoom(): Promise<Seat[]> {
      const people: Seat[] = [];
      for (let i = 0; i < MESH_VOICE_LIMIT; i++) {
        people.push(await seat(channel));
      }
      expect(getRoomTransport(channel)).toBe("mesh");
      return people;
    }

    it("moves the room and lets the ninth person in", async () => {
      const people = await fullRoom();

      const ninth = await knock(channel);

      expect(ninth.peerId).not.toBeNull();
      expect(ninth.frames.map((f) => f.type)).not.toContain("voice-room-full");
      expect(ninth.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "livekit",
      );
      expect(getRoomTransport(channel)).toBe("livekit");
      // The eight who were already talking moved in place, keeping their
      // peer ids: nobody was hung up to make room for a ninth.
      for (const person of people) {
        const told = framesOf(person, "voice-transport-changed");
        expect(told).toHaveLength(1);
        expect(told[0]!.reason).toBe("room-full");
        expect(told[0]!.transport).toBe("livekit");
      }
      expect(framesOf(people[0]!, "peer-left")).toHaveLength(0);
    });

    it("says room-full in the log, so the two triggers are separable", async () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.join(" "));
        });
      try {
        await fullRoom();
        await knock(channel);
      } finally {
        spy.mockRestore();
      }

      const promoted = lines.filter((line) =>
        line.startsWith("[pqp] voice.transportPromoted "),
      );
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toContain("reason=room-full");
      expect(promoted[0]).toContain(`voiceChannelId=${channel}`);
    });

    it("refuses exactly as before when the box is over budget", async () => {
      // A full room with a screen share running, which is what production was
      // doing at 16:13: 2 publishers x 9 people x 1.5 = 27 Mbit/s.
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "10";
      const people = await fullRoom();
      await shareOn(people[0]!);
      await shareOn(people[1]!);

      const ninth = await knock(channel);

      expect(ninth.peerId).toBeNull();
      expect(ninth.frames.find((f) => f.type === "voice-room-full")).toMatchObject(
        { voiceChannelId: channel, limit: MESH_VOICE_LIMIT },
      );
      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("never promotes a channel an operator pinned to mesh", async () => {
      rows.voiceTransport = "mesh";
      const people = await fullRoom();

      const ninth = await knock(channel);

      expect(ninth.peerId).toBeNull();
      expect(ninth.frames.find((f) => f.type === "voice-room-full")).toMatchObject(
        { limit: MESH_VOICE_LIMIT },
      );
      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("does not spend the box on a client that could not follow it there", async () => {
      const people = await fullRoom();

      // A build that only speaks mesh. Moving the room would evict nobody's
      // problem but its own: it still could not be seated.
      const ninth = await knock(channel, { transports: ["mesh"] });

      expect(ninth.peerId).toBeNull();
      expect(ninth.frames.find((f) => f.type === "voice-room-full")).toMatchObject(
        { limit: MESH_VOICE_LIMIT },
      );
      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("promotes once when two ninth people knock in the same tick", async () => {
      const people = await fullRoom();

      const [a, b] = await Promise.all([knock(channel), knock(channel)]);

      expect(a.peerId).not.toBeNull();
      expect(b.peerId).not.toBeNull();
      expect(getRoomTransport(channel)).toBe("livekit");
      // One move, one frame each. Two would tear a live SFU session down and
      // build it again under everybody.
      for (const person of people) {
        expect(framesOf(person, "voice-transport-changed")).toHaveLength(1);
      }
    });

    it("is not attempted at all once the room is on the media server", async () => {
      rows.memberCount = 40;
      const people = [await seat(channel), await seat(channel)];
      expect(getRoomTransport(channel)).toBe("livekit");

      const ninth = await knock(channel);

      expect(ninth.peerId).not.toBeNull();
      for (const person of [...people, ninth]) {
        expect(person.frames.map((f) => f.type)).not.toContain(
          "voice-transport-changed",
        );
      }
    });

    it("behaves exactly as before when LiveKit is not configured", async () => {
      backend.configured = "mesh";
      await fullRoom();

      const ninth = await knock(channel);

      expect(ninth.peerId).toBeNull();
      expect(ninth.frames.find((f) => f.type === "voice-room-full")).toMatchObject(
        { limit: MESH_VOICE_LIMIT },
      );
    });
  });

  /**
   * THE STALE PIN, which is what actually produced the incident above.
   *
   * The refused room was in a server of seventeen members, well over
   * `LARGE_SERVER_MEMBER_THRESHOLD`. It was on mesh because it opened at
   * 11:46 when the server was smaller, and it never emptied, so it never
   * re-decided. A pin outliving its reason is the general shape; the ninth
   * person is one symptom of it.
   */
  describe("a pin that no longer matches the policy", () => {
    it("moves a live room when its server grows past the threshold", async () => {
      const people = [await seat(channel), await seat(channel)];
      expect(getRoomTransport(channel)).toBe("mesh");

      rows.memberCount = 17;
      const joiner = await knock(channel);

      expect(getRoomTransport(channel)).toBe("livekit");
      expect(joiner.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "livekit",
      );
      for (const person of people) {
        expect(framesOf(person, "voice-transport-changed")[0]!.reason).toBe(
          "stale-pin",
        );
      }
    });

    it("moves a live room when the override is switched to the SFU mid-call", async () => {
      const people = [await seat(channel), await seat(channel)];

      rows.voiceTransport = "livekit";
      await knock(channel);

      expect(getRoomTransport(channel)).toBe("livekit");
      expect(framesOf(people[0]!, "voice-transport-changed")).toHaveLength(1);
    });

    it("leaves a room an operator pinned to mesh exactly where it is", async () => {
      rows.voiceTransport = "mesh";
      rows.memberCount = 500;
      const people = [await seat(channel), await seat(channel)];

      const joiner = await knock(channel);

      expect(getRoomTransport(channel)).toBe("mesh");
      expect(joiner.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "mesh",
      );
      expect(typesOf(people[0]!)).not.toContain("voice-transport-changed");
    });

    it("leaves a small server's room alone", async () => {
      const people = [await seat(channel), await seat(channel)];

      const joiner = await knock(channel);

      expect(getRoomTransport(channel)).toBe("mesh");
      expect(joiner.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "mesh",
      );
      expect(typesOf(people[0]!)).not.toContain("voice-transport-changed");
    });

    it("keeps the budget guard: over it the room stays where it is", async () => {
      // Two shares in a room of three is 2 x 3 x 1.5 = 9 Mbit/s on the box.
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "5";
      const people = [await seat(channel), await seat(channel), await seat(channel)];
      await shareOn(people[0]!);
      await shareOn(people[1]!);

      rows.memberCount = 17;
      const joiner = await knock(channel);

      expect(getRoomTransport(channel)).toBe("mesh");
      expect(joiner.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "mesh",
      );
    });
  });

  /**
   * THE FOURTH PERSON, and the caps nobody should ever meet.
   *
   * Every limit a small call runs into is a mesh limit: three cameras, two
   * screen shares, eight people. The groups above move the room when somebody
   * hits one, which works and still leaves the cap as something people MEET,
   * mid call, as a refusal. Rafael: "a 2 or 3 person call is fine. 4 or 5
   * becomes a proper thing. I want people to be able to share screen or use
   * webcam."
   *
   * So the room moves at `MESH_ROOM_PROMOTION_SIZE`, before anybody asks for
   * anything, and two and three person calls stay peer to peer on purpose.
   */
  describe("a room reaching the promotion size", () => {
    beforeEach(() => {
      delete process.env.VOICE_PROMOTION_ROOM_SIZE;
    });

    /** Seat `count` people, one at a time, as a real room fills. */
    async function fill(count: number): Promise<Seat[]> {
      const people: Seat[] = [];
      for (let i = 0; i < count; i++) {
        people.push(await seat(channel));
      }
      return people;
    }

    it("moves the room when the fourth person arrives", async () => {
      const people = await fill(MESH_ROOM_PROMOTION_SIZE - 1);
      expect(getRoomTransport(channel)).toBe("mesh");

      const fourth = await knock(channel);

      expect(fourth.peerId).not.toBeNull();
      expect(getRoomTransport(channel)).toBe("livekit");
      expect(fourth.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "livekit",
      );
      for (const person of people) {
        const told = framesOf(person, "voice-transport-changed");
        expect(told).toHaveLength(1);
        expect(told[0]!.reason).toBe("room-size");
        expect(told[0]!.transport).toBe("livekit");
      }
      // Moved in place: no leave, no rejoin, the same peer ids.
      expect(framesOf(people[0]!, "peer-left")).toHaveLength(0);
    });

    it("leaves a two or three person call peer to peer", async () => {
      const people = await fill(MESH_ROOM_PROMOTION_SIZE - 1);

      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("means nobody meets the camera cap at all", async () => {
      // The whole point. On mesh the fourth camera is a refusal that then
      // moves the room; here the room already moved, so the click is just a
      // click and the cap in force is the SFU's eight.
      const people = await fill(MESH_ROOM_PROMOTION_SIZE);
      expect(getRoomTransport(channel)).toBe("livekit");

      for (const person of people) {
        await cameraOn(person, channel);
      }

      expect(camerasOn(people[0]!)).toBe(MESH_ROOM_PROMOTION_SIZE);
      for (const person of people) {
        expect(typesOf(person)).not.toContain("camera-denied");
      }
    });

    it("says room-size in the log, separably from the other triggers", async () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.join(" "));
        });
      try {
        await fill(MESH_ROOM_PROMOTION_SIZE);
      } finally {
        spy.mockRestore();
      }

      const promoted = lines.filter((line) =>
        line.startsWith("[pqp] voice.transportPromoted "),
      );
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toContain("reason=room-size");
      expect(promoted[0]).toContain(`voiceChannelId=${channel}`);
    });

    it("never promotes a channel an operator pinned to mesh", async () => {
      rows.voiceTransport = "mesh";

      const people = await fill(MESH_ROOM_PROMOTION_SIZE);

      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("keeps the budget guard, and still seats the person", async () => {
      // Two shares in a room of four is 2 x 4 x 1.5 = 12 Mbit/s on the box.
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "5";
      const people = await fill(MESH_ROOM_PROMOTION_SIZE - 1);
      await shareOn(people[0]!);
      await shareOn(people[1]!);

      const fourth = await knock(channel);

      expect(getRoomTransport(channel)).toBe("mesh");
      // The difference from the room-full trigger: the room is not full, so a
      // refused promotion costs nobody their seat.
      expect(fourth.peerId).not.toBeNull();
      expect(fourth.frames.find((f) => f.type === "welcome")?.transport).toBe(
        "mesh",
      );
    });

    it("does not move the room for a client that could not follow it", async () => {
      const people = await fill(MESH_ROOM_PROMOTION_SIZE - 1);

      const fourth = await knock(channel, { transports: ["mesh"] });

      expect(getRoomTransport(channel)).toBe("mesh");
      // Seated, on the mesh it can actually run.
      expect(fourth.peerId).not.toBeNull();
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("behaves exactly as before when LiveKit is not configured", async () => {
      backend.configured = "mesh";

      const people = await fill(MESH_ROOM_PROMOTION_SIZE + 1);

      expect(getRoomTransport(channel)).toBe("mesh");
      for (const person of people) {
        expect(typesOf(person)).not.toContain("voice-transport-changed");
      }
    });

    it("promotes once when two people arrive in the same tick", async () => {
      const people = await fill(MESH_ROOM_PROMOTION_SIZE - 2);

      const [a, b] = await Promise.all([knock(channel), knock(channel)]);

      expect(a.peerId).not.toBeNull();
      expect(b.peerId).not.toBeNull();
      expect(getRoomTransport(channel)).toBe("livekit");
      for (const person of people) {
        expect(framesOf(person, "voice-transport-changed")).toHaveLength(1);
      }
    });

    describe("the threshold is tunable without a deploy", () => {
      it("moves the line to five when told to", async () => {
        process.env.VOICE_PROMOTION_ROOM_SIZE = "5";

        await fill(4);
        expect(getRoomTransport(channel)).toBe("mesh");

        await seat(channel);

        expect(getRoomTransport(channel)).toBe("livekit");
      });

      it("is off at zero, and the mesh caps are the old caps again", async () => {
        process.env.VOICE_PROMOTION_ROOM_SIZE = "0";

        const people = await fill(6);

        expect(getRoomTransport(channel)).toBe("mesh");
        for (const person of people) {
          expect(typesOf(person)).not.toContain("voice-transport-changed");
        }
      });

      it("treats a typo as the default rather than as a change", async () => {
        process.env.VOICE_PROMOTION_ROOM_SIZE = "four";

        await fill(MESH_ROOM_PROMOTION_SIZE);

        expect(getRoomTransport(channel)).toBe("livekit");
      });
    });
  });
});
