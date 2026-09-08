import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
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
 * The voice registry (`voice/registry.ts`) against a real Postgres, driven
 * through the real join handler wherever the handler is what writes.
 *
 * Two promises are pinned here and nowhere else:
 *
 * - With `VOICE_REGISTRY` off, the handler never touches the tables. That is
 *   the byte-for-byte guarantee the flag makes; the other voice suites prove
 *   the behaviour itself is unchanged, this one proves the rows stay empty.
 * - With it on, the decisions that have to be atomic across instances (the
 *   transport pin, the retired-id block) go through the table and survive
 *   what an in-process map cannot: a second process, and a restart.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

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

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({ kind: "server", type: "voice" }),
  getChannelAudience: async () => null,
  getServerVoiceProfile: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const { getPool, initDb, closePool } = await import("../db.js");
const {
  findVoiceChannelForUser,
  findVoicePeerIdentities,
  getVoiceActivitySnapshot,
  handleVoiceMessage,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const {
  heartbeatVoiceInstance,
  INSTANCE_TTL_MS,
  listLiveVoiceInstances,
  pinVoiceRoom,
  promoteVoiceRoomTransport,
  readVoiceRoomTransport,
  settleVoiceRegistryWrites,
  startVoiceInstanceHeartbeat,
  withdrawVoiceInstance,
} = await import("../voice/registry.js");
const { INSTANCE_ID } = await import("../lib/bus.js");

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
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function frame(rec: Recorder, type: string): Frame | undefined {
  return rec.frames.find((f) => f.type === type);
}

async function join(
  rec: Recorder,
  userId: string,
  voiceChannelId: string,
  extra: {
    transports?: ("mesh" | "livekit")[];
    resumePeerId?: string;
    resumeToken?: string;
  } = {},
): Promise<Recorder> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    {
      type: "join-voice-room",
      voiceChannelId,
      resume: true,
      transports: extra.transports ?? ["mesh", "livekit"],
      ...(extra.resumePeerId ? { resumePeerId: extra.resumePeerId } : {}),
      ...(extra.resumeToken ? { resumeToken: extra.resumeToken } : {}),
    },
  );
  await settleVoiceRegistryWrites();
  return rec;
}

async function leave(rec: Recorder, userId: string): Promise<void> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "leave-voice-room" },
  );
  await settleVoiceRegistryWrites();
}

async function count(table: string, where = "TRUE", params: unknown[] = []) {
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function peerRow(peerId: string) {
  const result = await getPool().query(
    `SELECT * FROM voice_peers WHERE peer_id = $1`,
    [peerId],
  );
  return result.rows[0] as
    | {
        channel_id: string;
        user_id: string;
        instance_id: string;
        muted: boolean;
        deafened: boolean;
        sharing_screen: boolean;
        orphaned_at: Date | null;
      }
    | undefined;
}

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("voice registry", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    backend.configured = "mesh";
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    resetVoicePeers();
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  describe("the flag-off guarantee", () => {
    it("writes nothing with VOICE_REGISTRY off, through join, state change, orphan and leave", async () => {
      delete process.env.VOICE_REGISTRY;
      const channel = randomUUID();
      const a = await join(recorder(), randomUUID(), channel);
      expect(frame(a, "welcome")).toBeDefined();
      await handleVoiceMessage(
        { socket: a.socket, user: asUser("x") },
        { type: "set-voice-state", muted: true, deafened: false },
      );
      removeVoicePeerBySocket(a.socket);
      await settleVoiceRegistryWrites();

      expect(await count("voice_rooms")).toBe(0);
      expect(await count("voice_peers")).toBe(0);
      expect(await count("voice_retired_peers")).toBe(0);
    });
  });

  describe("write-through from the join handler", () => {
    it("copies join, state change and leave into the rows", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const a = await join(recorder(), userId, channel);
      const peerId = frame(a, "welcome")?.peerId as string;

      let row = await peerRow(peerId);
      expect(row).toMatchObject({
        channel_id: channel,
        user_id: userId,
        instance_id: INSTANCE_ID,
        muted: false,
        sharing_screen: false,
        orphaned_at: null,
      });
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(1);

      await handleVoiceMessage(
        { socket: a.socket, user: asUser(userId) },
        { type: "set-voice-state", muted: true, deafened: true },
      );
      await settleVoiceRegistryWrites();
      row = await peerRow(peerId);
      expect(row).toMatchObject({ muted: true, deafened: true });

      await handleVoiceMessage(
        { socket: a.socket, user: asUser(userId) },
        { type: "set-sharing-screen", sharing: true },
      );
      await settleVoiceRegistryWrites();
      expect((await peerRow(peerId))?.sharing_screen).toBe(true);

      await leave(a, userId);
      expect(await peerRow(peerId)).toBeUndefined();
      // The id is retired cluster-wide, exactly as it is in-process.
      expect(
        await count("voice_retired_peers", "peer_id = $1", [peerId]),
      ).toBe(1);
    });

    it("marks a socket loss as orphaned and clears it on resume", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const a = await join(recorder(), userId, channel);
      const welcome = frame(a, "welcome")!;
      const peerId = welcome.peerId as string;

      removeVoicePeerBySocket(a.socket);
      await settleVoiceRegistryWrites();
      expect((await peerRow(peerId))?.orphaned_at).not.toBeNull();

      const b = await join(recorder(), userId, channel, {
        resumePeerId: peerId,
        resumeToken: welcome.resumeToken as string,
      });
      expect(frame(b, "welcome")).toMatchObject({ peerId, resumed: true });
      expect((await peerRow(peerId))?.orphaned_at).toBeNull();
    });

    it("unpins the room on the last leave and not before", async () => {
      const channel = randomUUID();
      const a = await join(recorder(), randomUUID(), channel);
      const b = await join(recorder(), randomUUID(), channel);

      await leave(a, "a");
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(1);
      expect(await count("voice_peers", "channel_id = $1", [channel])).toBe(1);

      await leave(b, "b");
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(0);
      expect(await count("voice_peers", "channel_id = $1", [channel])).toBe(0);
    });

    it("leaves no room row behind a refused join", async () => {
      backend.configured = "livekit";
      const channel = randomUUID();
      const phone = await join(recorder(), randomUUID(), channel, {
        transports: ["mesh"],
      });

      expect(frame(phone, "voice-transport-unsupported")).toBeDefined();
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(0);
    });
  });

  describe("the transport pin is atomic across instances", () => {
    it("two concurrent pins with different wishes agree on one transport", async () => {
      const channel = randomUUID();
      const [first, second] = await Promise.all([
        pinVoiceRoom(channel, "mesh"),
        pinVoiceRoom(channel, "livekit"),
      ]);

      expect(first).toBe(second);
      const stored = await getPool().query<{ transport: string }>(
        `SELECT transport FROM voice_rooms WHERE channel_id = $1`,
        [channel],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.transport).toBe(first);
    });

    it("the loser adopts the stored transport in its welcome", async () => {
      // Another instance pinned this channel to the SFU a moment ago. This
      // instance would have chosen mesh (LiveKit is off here, the drift case
      // from section 5.1) and must not: the room follows the first joiner.
      const channel = randomUUID();
      await pinVoiceRoom(channel, "livekit");
      const rec = await join(recorder(), randomUUID(), channel);

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
      expect(
        (console.log as ReturnType<typeof vi.fn>).mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("voice.transportAdopted")),
      ).toHaveLength(1);
    });

    it("refuses a client that cannot run the adopted transport", async () => {
      const channel = randomUUID();
      await pinVoiceRoom(channel, "livekit");
      const phone = await join(recorder(), randomUUID(), channel, {
        transports: ["mesh"],
      });

      expect(frame(phone, "voice-transport-unsupported")).toMatchObject({
        transport: "livekit",
      });
      expect(frame(phone, "welcome")).toBeUndefined();
    });
  });

  /**
   * PROMOTION. The one time a pinned room changes transport, so the one time
   * the pin is rewritten rather than inserted. It has to be a conditional
   * UPDATE: two people clicking a camera in the same second, on one machine
   * or two, must produce one promotion and therefore one announcement. A
   * read-then-write here would announce it twice, and the second frame would
   * tear down a LiveKit session that had just come up.
   */
  describe("promoting a pinned room", () => {
    it("moves a mesh room to the SFU and says it won", async () => {
      const channel = randomUUID();
      await pinVoiceRoom(channel, "mesh");

      const result = await promoteVoiceRoomTransport(channel, "mesh", "livekit");

      expect(result).toEqual({ transport: "livekit", promoted: true });
      expect(await readVoiceRoomTransport(channel)).toBe("livekit");
    });

    /**
     * The atomicity is a property of ONE statement, and a test cannot force
     * two connections to interleave inside it, so this asserts the shape
     * instead: the winning path is a single round trip. A read-then-write
     * would be two, and two is what lets both callers read `mesh`, both
     * write, and both announce a promotion, the second one tearing
     * down a LiveKit session that had just come up.
     */
    it("wins in one statement, which is what makes two callers safe", async () => {
      const channel = randomUUID();
      await pinVoiceRoom(channel, "mesh");
      const pool = getPool();
      const query = vi.spyOn(pool, "query");

      const result = await promoteVoiceRoomTransport(channel, "mesh", "livekit");

      expect(result.promoted).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0]?.[0])).toContain("AND transport =");
      query.mockRestore();
    });

    it("both callers are told where the room actually is", async () => {
      const channel = randomUUID();
      await pinVoiceRoom(channel, "mesh");

      const results = await Promise.all([
        promoteVoiceRoomTransport(channel, "mesh", "livekit"),
        promoteVoiceRoomTransport(channel, "mesh", "livekit"),
      ]);

      // The loser gets the stored transport without a second read of its own,
      // so it can move its own seats whether it won or not.
      expect(results.every((r) => r.transport === "livekit")).toBe(true);
    });

    it("a second promotion of an already promoted room wins nothing", async () => {
      const channel = randomUUID();
      await pinVoiceRoom(channel, "mesh");
      await promoteVoiceRoomTransport(channel, "mesh", "livekit");

      const again = await promoteVoiceRoomTransport(channel, "mesh", "livekit");

      expect(again).toEqual({ transport: "livekit", promoted: false });
    });

    it("a room that has emptied is not resurrected", async () => {
      const channel = randomUUID();

      const result = await promoteVoiceRoomTransport(channel, "mesh", "livekit");

      expect(result).toEqual({ transport: null, promoted: false });
      expect(await readVoiceRoomTransport(channel)).toBeNull();
    });
  });

  describe("retired ids", () => {
    it("blocks reconstruct of a hung-up id after the local map is gone", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const a = await join(recorder(), userId, channel);
      const welcome = frame(a, "welcome")!;
      const peerId = welcome.peerId as string;
      const token = welcome.resumeToken as string;
      await leave(a, userId);

      // A restart, or the other machine: no peers, no local retired map.
      resetVoicePeers();

      const b = await join(recorder(), userId, channel, {
        resumePeerId: peerId,
        resumeToken: token,
      });
      const again = frame(b, "welcome")!;
      expect(again.peerId).not.toBe(peerId);
      expect(again.resumed).toBeUndefined();
    });

    it("the same sequence reconstructs with the flag off, which is the bug the row closes", async () => {
      process.env.VOICE_REGISTRY = "off";
      const channel = randomUUID();
      const userId = randomUUID();
      const a = await join(recorder(), userId, channel);
      const welcome = frame(a, "welcome")!;
      await leave(a, userId);
      resetVoicePeers();

      const b = await join(recorder(), userId, channel, {
        resumePeerId: welcome.peerId as string,
        resumeToken: welcome.resumeToken as string,
      });
      expect(frame(b, "welcome")).toMatchObject({
        peerId: welcome.peerId,
        resumed: true,
      });
    });
  });

  describe("cluster-wide reads", () => {
    it("finds a peer this instance never saw, for moderation and the snapshot", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const foreignPeer = randomUUID();
      await pinVoiceRoom(channel, "livekit");
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name, sharing_screen)
         VALUES ($1, $2, $3, $4, 'Elsewhere', TRUE)`,
        [foreignPeer, channel, userId, randomUUID()],
      );

      expect(await findVoiceChannelForUser(userId, new Set([channel]))).toBe(
        channel,
      );
      expect(await findVoiceChannelForUser(userId, new Set([randomUUID()]))).toBe(
        null,
      );
      expect(await findVoicePeerIdentities(userId, channel)).toEqual(
        new Map([[foreignPeer, userId]]),
      );

      const snapshot = await getVoiceActivitySnapshot();
      expect(snapshot.rooms).toEqual([
        {
          voiceChannelId: channel,
          participants: 1,
          sharingScreen: 1,
          transport: "livekit",
          openedAt: expect.any(String),
        },
      ]);
      expect(Date.parse(snapshot.rooms[0]!.openedAt!)).not.toBeNaN();
      expect(snapshot.participants).toBe(1);
    });

    it("reads only the local map with the flag off", async () => {
      process.env.VOICE_REGISTRY = "off";
      const channel = randomUUID();
      const userId = randomUUID();
      await pinVoiceRoom(channel, "livekit");
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
         VALUES ($1, $2, $3, $4, 'Elsewhere')`,
        [randomUUID(), channel, userId, randomUUID()],
      );

      expect(await findVoiceChannelForUser(userId, new Set([channel]))).toBe(
        null,
      );
      expect((await getVoiceActivitySnapshot()).participants).toBe(0);
    });

    it("still says which transport a locally-held room is on with the flag off, but not when it opened", async () => {
      // The registry row above (`livekit`) is not consulted with the flag
      // off: the local map is the source, and this process pinned the room
      // itself when the peer below joined. Nothing is configured for
      // LiveKit in this suite, so the pin resolves to mesh.
      process.env.VOICE_REGISTRY = "off";
      const channel = randomUUID();
      const userId = randomUUID();
      await join(recorder(), userId, channel);

      const snapshot = await getVoiceActivitySnapshot();
      expect(snapshot.rooms).toEqual([
        {
          voiceChannelId: channel,
          participants: 1,
          sharingScreen: 0,
          transport: "mesh",
          openedAt: null,
        },
      ]);
    });
  });

  describe("instance heartbeat", () => {
    it("announces the instance and lets it age out after the TTL", async () => {
      const instance = randomUUID();
      await heartbeatVoiceInstance(instance, "abc");
      expect(
        (await listLiveVoiceInstances()).map((row) => row.instanceId),
      ).toContain(instance);

      await getPool().query(
        `UPDATE voice_instances
            SET heartbeat_at = NOW() - ($2::bigint * INTERVAL '1 millisecond')
          WHERE instance_id = $1`,
        [instance, INSTANCE_TTL_MS + 1_000],
      );
      expect(
        (await listLiveVoiceInstances()).map((row) => row.instanceId),
      ).not.toContain(instance);

      // A heartbeat brings it back; a withdrawal removes it outright.
      await heartbeatVoiceInstance(instance, "abc");
      expect(
        (await listLiveVoiceInstances()).map((row) => row.instanceId),
      ).toContain(instance);
      await withdrawVoiceInstance(instance);
      expect(await count("voice_instances", "instance_id = $1", [instance])).toBe(
        0,
      );
    });

    it("the loop writes this instance's row at once and withdraws it on stop", async () => {
      const stop = startVoiceInstanceHeartbeat(60_000);
      // The first beat is fired synchronously; give its query a moment.
      for (let i = 0; i < 50; i++) {
        if ((await count("voice_instances", "instance_id = $1", [INSTANCE_ID])) === 1) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(
        await count("voice_instances", "instance_id = $1", [INSTANCE_ID]),
      ).toBe(1);

      await stop();
      expect(
        await count("voice_instances", "instance_id = $1", [INSTANCE_ID]),
      ).toBe(0);
    });
  });
});
