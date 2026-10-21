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
 * THE VIDEO BUDGET IS ONE BOX'S, through the real join and camera handlers,
 * against a real Postgres, with `VOICE_REGISTRY=postgres` ON and a region
 * configured the way production configures them (CLAUDE.md pitfall 12: the
 * flag that changes the path is the flag the test sets).
 *
 * 2026-10-20, 23:00 to 01:00 UTC: 56 cameras refused at `loadMbps` 524 to 605
 * against 600 while the media box measured about 25% loaded. `readRoomLoads`
 * summed every SFU room on the cluster, whichever box it was pinned to, and
 * compared one number with one budget. Here a room on Miami and a room on Sao
 * Paulo each carry 27 Mbit/s of cameras against a budget of 30 per box:
 *
 * - flag on, a camera on the Miami room is admitted while the Sao Paulo room
 *   is full, and the other way round; flag off it is refused (the cluster sum);
 * - the rooms the process holds no seat in (the other API replica's) are
 *   priced from `voice_rooms.sfu_region`, not from an in-process pin;
 * - `VOICE_PROMOTION_MAX_SFU_MBPS_MIA` closes or widens only Miami;
 * - the refusal's log line says which box and how crowded it was.
 *
 * The flat camera price is pinned (`SFU_VIDEO_PRICE_CALIBRATED=off`) so the
 * numbers are the ones in the comments; the calibrated price has its own
 * tests in `voice-promotion.test.ts` and `voice/promotion.test.ts`.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "livekit",
  isLiveKitConfigured: () => true,
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

const channelTypes = vi.hoisted(() => new Map<string, string>());

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: channelTypes.get(id) ?? "voice",
    server_id: null,
  }),
  getChannelAudience: async () => null,
  // No server row: the transport policy answers `livekit`, so every room here
  // is an SFU room and the region is picked from the first joiner's country.
  getServerVoiceProfile: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
  cancelSfuPrivateResweep: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

const { getPool, initDb, closePool } = await import("../db.js");
const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { listVoiceRoster, settleVoiceRegistryWrites } = await import(
  "../voice/registry.js"
);
const { resetRegionAudience } = await import("../voice/region-audience.js");
const { createMemoryHub, createMemoryTransport, setBusTransport } = await import(
  "../lib/bus.js"
);
const { noteSocketCountry, pinnedRoomRegion, SFU_REGION_CAP } = await import(
  "../voice/regions.js"
);
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "./sockets.js"
);

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

const opened: Seat[] = [];

async function join(country: string, channel: string): Promise<Seat> {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  const id = randomUUID();
  const user = {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
  noteSocketCountry(socket, { "cf-ipcountry": country });
  setAuthenticatedSocket(socket, user, [SFU_REGION_CAP]);
  await handleVoiceMessage(
    { socket, user },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      resume: true,
      transports: ["mesh", "livekit"],
    },
  );
  await settleVoiceRegistryWrites();
  const welcome = frames.find((frame) => frame.type === "welcome");
  if (!welcome) {
    throw new Error(`join refused: ${JSON.stringify(frames)}`);
  }
  const seat = { socket, frames, user, peerId: welcome.peerId as string };
  opened.push(seat);
  return seat;
}

async function room(
  country: string,
  size: number,
  channel: string = randomUUID(),
): Promise<{ channel: string; people: Seat[] }> {
  const people: Seat[] = [];
  for (let at = 0; at < size; at += 1) {
    people.push(await join(country, channel));
  }
  return { channel, people };
}

async function cameraOn(person: Seat): Promise<boolean> {
  const before = person.frames.filter((f) => f.type === "camera-denied").length;
  await handleVoiceMessage(
    { socket: person.socket, user: person.user },
    { type: "set-camera", streamId: `stream-${person.peerId}` },
  );
  await settleVoiceRegistryWrites();
  return person.frames.filter((f) => f.type === "camera-denied").length === before;
}

const SAVED = [
  "VOICE_REGISTRY",
  "CLUSTER_BUS",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_REGIONS",
  "LIVEKIT_REGION_COUNTRIES",
  "VOICE_PROMOTION_MAX_SFU_MBPS",
  "VOICE_PROMOTION_MAX_SFU_MBPS_MIA",
  "SFU_VIDEO_BUDGET_PER_BOX",
  "SFU_VIDEO_PRICE_CALIBRATED",
  "CLERK_SECRET_KEY",
] as const;
const saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));

describeDb("the video budget is per box", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
    for (const name of SAVED) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.CLUSTER_BUS = "postgres";
    setBusTransport(createMemoryTransport(createMemoryHub()));
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.example.test";
    process.env.LIVEKIT_REGION_COUNTRIES = "US:mia";
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "30";
    delete process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA;
    delete process.env.SFU_VIDEO_BUDGET_PER_BOX;
    process.env.SFU_VIDEO_PRICE_CALIBRATED = "off";
    process.env.CLERK_SECRET_KEY ??= "sk_test_video_box";
    channelTypes.clear();
    resetRegionAudience();
    resetVoicePeers();
    resetVoiceRoomTransports();
    resetVoiceRateLimits();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_audience_mode, voice_audience_speakers, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    for (const seat of opened) {
      deleteAuthenticatedSocket(seat.socket);
    }
    opened.length = 0;
    resetVoicePeers();
    resetVoiceRoomTransports();
    setBusTransport(null);
    vi.restoreAllMocks();
  });

  /** A full Sao Paulo room (6 people, 3 cameras: 6 * 3 * 1.5 = 27 of 30), whose seats this process then forgets, as the other replica's. */
  async function fullSaoRoomOnTheOtherReplica(): Promise<void> {
    const sao = await room("BR", 6);
    for (const person of sao.people.slice(0, 3)) {
      expect(await cameraOn(person)).toBe(true);
    }
    const stored = await getPool().query<{ sfu_region: string | null }>(
      `SELECT sfu_region FROM voice_rooms WHERE channel_id = $1`,
      [sao.channel],
    );
    expect(stored.rows[0]?.sfu_region).toBe("sao");
    resetVoicePeers();
    resetVoiceRoomTransports();
    resetVoiceRateLimits();
  }

  it("admits cameras on a Miami room while the Sao Paulo room is full", async () => {
    await fullSaoRoomOnTheOtherReplica();
    const mia = await room("US", 6);
    expect(pinnedRoomRegion(mia.channel)).toBe("mia");
    // Three cameras: 9, 18, 27 of Miami's 30. The cluster sum would refuse
    // the first one (27 of Sao Paulo already there plus 9).
    for (const person of mia.people.slice(0, 3)) {
      expect(await cameraOn(person)).toBe(true);
    }
  });

  it("refuses the same Miami camera with the flag off: today's cluster-wide sum", async () => {
    process.env.SFU_VIDEO_BUDGET_PER_BOX = "off";
    await fullSaoRoomOnTheOtherReplica();
    const mia = await room("US", 6);
    expect(await cameraOn(mia.people[0]!)).toBe(false);
  });

  it("still refuses a camera that overfills ITS OWN box, and the other box does not notice", async () => {
    await fullSaoRoomOnTheOtherReplica();
    const sao = await room("BR", 6);
    const mia = await room("US", 6);
    // Sao Paulo already carries 27 from the other replica's room: the first
    // camera of this Sao room is 9 more, 36 of 30.
    expect(await cameraOn(sao.people[0]!)).toBe(false);
    // Miami is empty of video, whatever Sao Paulo says.
    expect(await cameraOn(mia.people[0]!)).toBe(true);
  });

  it("closes or widens only the box a regional budget names", async () => {
    process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA = "0";
    const mia = await room("US", 6);
    const sao = await room("BR", 6);
    expect(await cameraOn(mia.people[0]!)).toBe(false);
    expect(await cameraOn(sao.people[0]!)).toBe(true);

    process.env.VOICE_PROMOTION_MAX_SFU_MBPS_MIA = "500";
    expect(await cameraOn(mia.people[0]!)).toBe(true);
    expect(await cameraOn(mia.people[1]!)).toBe(true);
    expect(await cameraOn(mia.people[2]!)).toBe(true);
    expect(await cameraOn(mia.people[3]!)).toBe(true);
  });

  it("says which box and how crowded it was, counts only", async () => {
    await fullSaoRoomOnTheOtherReplica();
    const sao = await room("BR", 6);
    const log = vi.mocked(console.log);
    expect(await cameraOn(sao.people[0]!)).toBe(false);
    const line = log.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("voice.videoAdmissionRefused"));
    expect(line).toBeDefined();
    expect(line).toContain("region=sao");
    expect(line).toContain("perBox=true");
    expect(line).toContain("loadMbps=27");
    expect(line).toContain("roomsOnBox=2");
    expect(line).toContain("peopleOnBox=12");
    expect(line).not.toContain("User ");
  });

  describe("a watch party room keeps the flat camera tariff", () => {
    /** A real `watch_party` channel row, so the roster's own join can see the type. */
    async function watchPartyChannel(): Promise<string> {
      const pool = getPool();
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (clerk_id, display_name) VALUES ($1, 'Owner') RETURNING id`,
        [`clerk_box_${randomUUID()}`],
      );
      const server = await pool.query<{ id: string }>(
        `INSERT INTO servers (name, owner_id) VALUES ('party', $1) RETURNING id`,
        [user.rows[0]!.id],
      );
      const channel = randomUUID();
      await pool.query(
        `INSERT INTO channels (id, server_id, name, type, position)
         VALUES ($1, $2, 'sala', 'watch_party', 0)`,
        [channel, server.rows[0]!.id],
      );
      channelTypes.set(channel, "watch_party");
      return channel;
    }

    it("says so on the roster the other replica reads", async () => {
      const channel = await watchPartyChannel();
      await room("BR", 2, channel);
      expect((await listVoiceRoster(channel))?.watchParty).toBe(true);
      const plain = await room("BR", 2);
      expect((await listVoiceRoster(plain.channel))?.watchParty).toBe(false);
    });

    it("prices a small party's cameras flat while an ordinary room of the same shape is calibrated", async () => {
      process.env.SFU_VIDEO_PRICE_CALIBRATED = "on";
      process.env.VOICE_PROMOTION_MAX_SFU_MBPS = "30";
      // Different boxes, so neither room is judged on the other's load.
      const party = await room("BR", 6, await watchPartyChannel());
      const plain = await room("US", 6);
      for (const person of party.people.slice(0, 3)) {
        expect(await cameraOn(person)).toBe(true);
      }
      // Flat: the fourth camera is 6 * 4 * 1.5 = 36 of 30.
      expect(await cameraOn(party.people[3]!)).toBe(false);
      // Calibrated: 6 * (1.5 + 3 * 0.4) = 16.2 of 30.
      for (const person of plain.people.slice(0, 4)) {
        expect(await cameraOn(person)).toBe(true);
      }
    });
  });
});
