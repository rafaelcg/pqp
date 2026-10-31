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
  type MockInstance,
} from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * `voice.resumeRefused`: the server says so when it declines a resume.
 *
 * Production, 2026-10-24: 210 joins in one LiveKit room, every one cold, and
 * no way to tell from the log whether the client never asked to resume or the
 * server said no, because a refused resume was seated cold without a word.
 * Each place that declines now logs one line with the reason, bounded per
 * reason and room (a reconnect herd refuses hundreds in a second).
 *
 * Run with the flags production sets, `CLUSTER_BUS=postgres` and
 * `VOICE_REGISTRY=postgres`, on a real Postgres: the retired-id and row
 * decisions only exist with the registry on (pitfall 12). TEST_DATABASE_URL
 * wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const backend = vi.hoisted(() => ({ configured: "livekit" as "mesh" | "livekit" }));

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
  handleVoiceMessage,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { settleVoiceRegistryWrites } = await import("../voice/registry.js");
const { createMemoryHub, createMemoryTransport, setBusTransport } = await import(
  "../lib/bus.js"
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

/** The `voice.resumeRefused` lines logged so far, as field maps. */
function refusals(log: MockInstance<typeof console.log>): Record<string, string>[] {
  return log.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[pqp] voice.resumeRefused "))
    .map((line) =>
      Object.fromEntries(
        line
          .slice("[pqp] voice.resumeRefused ".length)
          .split(" ")
          .map((pair) => {
            const at = pair.indexOf("=");
            return [pair.slice(0, at), pair.slice(at + 1)];
          }),
      ),
    );
}

const realNow = Date.now.bind(Date);

const previous = {
  registry: process.env.VOICE_REGISTRY,
  bus: process.env.CLUSTER_BUS,
};

describeDb("voice.resumeRefused", () => {
  let log: MockInstance<typeof console.log>;
  let clock = 0;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.CLUSTER_BUS = "postgres";
    setBusTransport(createMemoryTransport(createMemoryHub()));
    backend.configured = "livekit";
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    clock = 0;
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_audience_mode, voice_audience_speakers, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    resetVoicePeers();
    process.env.VOICE_REGISTRY = previous.registry;
    process.env.CLUSTER_BUS = previous.bus;
    vi.restoreAllMocks();
  });

  /** A listener's seat in a LiveKit room, then its socket drops. */
  async function orphanedSeat(channel: string, userId: string) {
    const first = await join(recorder(), userId, channel);
    const welcome = frame(first, "welcome")!;
    expect(welcome.transport).toBe("livekit");
    removeVoicePeerBySocket(first.socket);
    await settleVoiceRegistryWrites();
    return {
      peerId: welcome.peerId as string,
      token: welcome.resumeToken as string,
    };
  }

  it("says nothing when the resume is accepted", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const { peerId, token } = await orphanedSeat(channel, userId);

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });

    expect(frame(again, "welcome")).toMatchObject({ peerId, resumed: true });
    expect(refusals(log)).toEqual([]);
  });

  it("says nothing for a first join, which asked for nothing", async () => {
    await join(recorder(), randomUUID(), randomUUID());
    expect(refusals(log)).toEqual([]);
  });

  it("names a token the server cannot verify", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const { peerId } = await orphanedSeat(channel, userId);

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: "not.a-token",
    });

    expect(frame(again, "welcome")?.resumed).toBeUndefined();
    expect(refusals(log)).toEqual([
      {
        reason: "token-invalid",
        userId,
        voiceChannelId: channel,
        peerId,
      },
    ]);
  });

  it("names a resume that arrived with a peer id and no token", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const { peerId } = await orphanedSeat(channel, userId);

    await join(recorder(), userId, channel, { resumePeerId: peerId });

    expect(refusals(log).map((r) => r.reason)).toEqual(["token-missing"]);
  });

  it("names a client that cannot run the transport the token remembers", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const { peerId, token } = await orphanedSeat(channel, userId);

    await join(recorder(), userId, channel, {
      transports: ["mesh"],
      resumePeerId: peerId,
      resumeToken: token,
    });

    expect(refusals(log)).toMatchObject([
      { reason: "capability-missing", peerId, transport: "livekit" },
    ]);
  });

  it("names a seat that was hung up (the leave a client sends before it joins again)", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(recorder(), userId, channel);
    const welcome = frame(first, "welcome")!;
    await leave(first, userId);
    // A restart, or the other machine: the retired id lives in the table.
    resetVoicePeers();

    const again = await join(recorder(), userId, channel, {
      resumePeerId: welcome.peerId as string,
      resumeToken: welcome.resumeToken as string,
    });

    expect(frame(again, "welcome")?.peerId).not.toBe(welcome.peerId);
    expect(refusals(log)).toMatchObject([
      { reason: "peer-retired", peerId: welcome.peerId },
    ]);
  });

  it("names a room pinned to another transport", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const { peerId, token } = await orphanedSeat(channel, userId);
    // The room emptied and reopened on mesh while the seat was held.
    resetVoicePeers();
    resetVoiceRoomTransports();
    await getPool().query(
      `TRUNCATE voice_rooms, voice_audience_mode, voice_audience_speakers, voice_peers, voice_server_mutes, voice_raised_hands`,
    );
    backend.configured = "mesh";
    await join(recorder(), randomUUID(), channel);

    const again = await join(recorder(), userId, channel, {
      resumePeerId: peerId,
      resumeToken: token,
    });

    expect(frame(again, "welcome")?.resumed).toBeUndefined();
    expect(refusals(log)).toMatchObject([
      {
        reason: "transport-pinned-elsewhere",
        peerId,
        transport: "livekit",
        pinned: "mesh",
      },
    ]);
  });

  it("logs one line per reason and room per window, and counts the rest", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock);
    const channel = randomUUID();
    const other = randomUUID();
    const userId = randomUUID();
    const { peerId } = await orphanedSeat(channel, userId);
    const refuse = (room: string) =>
      join(recorder(), userId, room, {
        resumePeerId: peerId,
        resumeToken: "x.y",
      });

    await refuse(channel);
    await refuse(channel);
    await refuse(channel);
    expect(refusals(log)).toHaveLength(1);
    expect(refusals(log)[0]).not.toHaveProperty("suppressed");

    // Another room is its own bucket.
    await refuse(other);
    expect(refusals(log)).toHaveLength(2);

    // Past the window the next line carries what the window swallowed.
    clock += 11_000;
    await refuse(channel);
    expect(refusals(log)).toHaveLength(3);
    expect(refusals(log)[2]).toMatchObject({
      reason: "token-invalid",
      voiceChannelId: channel,
      suppressed: "2",
    });
  });

  it("bounds the table, because the room id in the key is the client's", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock);
    const refuse = () =>
      join(recorder(), randomUUID(), randomUUID(), {
        resumePeerId: randomUUID(),
        resumeToken: "x.y",
      });

    for (let i = 0; i < 26; i += 1) {
      await Promise.all(Array.from({ length: 20 }, refuse));
    }
    // Past the cap nothing more is logged, and nothing is scanned either.
    expect(refusals(log)).toHaveLength(500);

    // The window turns: the table is swept once and logging resumes.
    clock += 11_000;
    await refuse();
    expect(refusals(log)).toHaveLength(501);
  }, 60_000);
});
