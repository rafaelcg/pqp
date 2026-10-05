import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * AUDIENCE MODE ACROSS TWO API MACHINES (`docs/plans/AUDIENCE_MODE.md`).
 *
 * Production runs two API containers sharing Postgres over `CLUSTER_BUS`, with
 * `VOICE_REGISTRY=postgres`, so this is the configuration that matters
 * (CLAUDE.md pitfall 12: test with the flag production sets). Two module
 * graphs over one memory hub and one real database, exactly as
 * `voice-cluster.test.ts` does, plus the stateful fake SFU of
 * `voice-audience.test.ts` shared by both, because the point is that a toggle
 * on one machine silences a person whose socket is on the other one at the
 * media server itself.
 *
 * Skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const SERVER = "22222222-2222-4222-8222-222222222222";

const bits = vi.hoisted(() => ({ byUser: new Map<string, bigint>() }));

vi.mock("../services/permissions.js", async () => {
  const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
  const forUser = (userId: string) => bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE;
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) => forUser(userId),
    resolveMemberChannelPermissions: async (_serverId: string, userId: string) => ({
      permissions: forUser(userId),
      nickname: null,
    }),
  };
});

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (_serverId: string | null, user: { display_name: string }) =>
    user.display_name,
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

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: "voice",
    server_id: "22222222-2222-4222-8222-222222222222",
    parent_id: null,
    voice_transport: "livekit",
  }),
  getChannelAudience: async () => ({ serverId: null, kind: "server", has: () => true }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 40 }),
}));

interface FakeParticipant {
  identity: string;
  metadata: string;
  permission: { canPublish: boolean; canPublishSources: number[] };
  tracks: { sid: string; source: number; type: number; muted: boolean }[];
}

const sfu = vi.hoisted(() => ({ rooms: new Map<string, Map<string, unknown>>() }));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    ...actual,
    RoomServiceClient: class {
      async listParticipants(room: string) {
        return [...(sfu.rooms.get(room)?.values() ?? [])].map((p) => clone(p));
      }
      async updateParticipant(
        room: string,
        identity: string,
        options: { permission: { canPublish: boolean; canPublishSources?: number[] } },
      ) {
        const p = sfu.rooms.get(room)?.get(identity) as FakeParticipant | undefined;
        if (!p) {
          throw Object.assign(new Error("participant not found"), { status: 404 });
        }
        p.permission = {
          canPublish: options.permission.canPublish,
          canPublishSources: options.permission.canPublishSources ?? [],
        };
        return clone(p);
      }
      async mutePublishedTrack(room: string, identity: string, sid: string, muted: boolean) {
        const p = sfu.rooms.get(room)?.get(identity) as FakeParticipant | undefined;
        const track = p?.tracks.find((t) => t.sid === sid);
        if (track) {
          track.muted = muted;
        }
      }
    },
  };
});

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");
type SpeakModule = typeof import("../voice/speak.js");
type BackendsModule = typeof import("../voice/backends.js");
type AdminModule = typeof import("../voice/admin.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  registry: RegistryModule;
  db: DbModule;
  speak: SpeakModule;
  backends: BackendsModule;
  admin: AdminModule;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Seat {
  socket: WebSocket;
  frames: Frame[];
  userId: string;
  peerId: string;
  resumeToken: string;
}

let hub = createMemoryHub();
const pools: DbModule[] = [];
const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const registry = (await import("../voice/registry.js")) as RegistryModule;
  const speak = (await import("../voice/speak.js")) as SpeakModule;
  const backends = (await import("../voice/backends.js")) as BackendsModule;
  const admin = (await import("../voice/admin.js")) as AdminModule;
  const fanout = await import("./fanout.js");
  fanout.setCoalesceImmediate(true);
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, voice, sockets, registry, db, speak, backends, admin };
  booted.push(instance);
  return instance;
}

function asUser(id: string): DbUser {
  return { id, display_name: `User ${id.slice(0, 8)}`, avatar_url: null } as unknown as DbUser;
}

async function join(
  instance: Instance,
  userId: string,
  channel: string,
  extra: { resumePeerId?: string; resumeToken?: string } = {},
): Promise<Seat> {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  instance.sockets.setAuthenticatedSocket(socket, asUser(userId));
  await instance.voice.handleVoiceMessage(
    { socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: channel, resume: true, ...extra },
  );
  const welcome = frames.find((f) => f.type === "welcome");
  if (!welcome) {
    throw new Error(`join refused: ${JSON.stringify(frames)}`);
  }
  return {
    socket,
    frames,
    userId,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
  };
}

async function connect(instance: Instance, seat: Seat, channel: string): Promise<void> {
  const row = { id: channel, kind: "server", type: "voice", server_id: SERVER, parent_id: null };
  const grant = await instance.speak.resolveVoicePublish(row, channel, seat.userId);
  const publish = instance.backends.liveKitPublishGrant(grant);
  let participants = sfu.rooms.get(channel);
  if (!participants) {
    participants = new Map();
    sfu.rooms.set(channel, participants);
  }
  const p: FakeParticipant = {
    identity: seat.peerId,
    metadata: instance.backends.participantMetadataFor(seat.userId),
    permission: {
      canPublish: publish.canPublish ?? false,
      canPublishSources: (publish.canPublishSources as number[] | undefined) ?? [],
    },
    tracks: [],
  };
  participants.set(seat.peerId, p);
  tryToSpeak(seat, channel);
}

const MIC = 2; // TrackSource.MICROPHONE
const AUDIO = 0; // TrackType.AUDIO

function micAllowed(p: FakeParticipant): boolean {
  return (
    p.permission.canPublish &&
    (p.permission.canPublishSources.length === 0 || p.permission.canPublishSources.includes(MIC))
  );
}

function tryToSpeak(seat: Seat, channel: string): boolean {
  const p = sfu.rooms.get(channel)!.get(seat.peerId) as FakeParticipant;
  if (!micAllowed(p)) {
    return false;
  }
  const mic = p.tracks.find((t) => t.source === MIC);
  if (mic) {
    mic.muted = false;
  } else {
    p.tracks.push({ sid: `MIC_${seat.peerId}`, source: MIC, type: AUDIO, muted: false });
  }
  return true;
}

function audible(seat: Seat, channel: string): boolean {
  const p = sfu.rooms.get(channel)!.get(seat.peerId) as FakeParticipant;
  return micAllowed(p) && p.tracks.some((t) => t.source === MIC && !t.muted);
}

function last(seat: Seat, type: string): Frame | undefined {
  return seat.frames.filter((f) => f.type === type).at(-1);
}

async function settle(): Promise<void> {
  for (const instance of booted) {
    await instance.registry.settleVoiceRegistryWrites();
  }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const previous = {
  registry: process.env.VOICE_REGISTRY,
  clerk: process.env.CLERK_SECRET_KEY,
};

describeDb("audience mode across two instances", () => {
  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    pools.push(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((db) => db.closePool().catch(() => {})));
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.VOICE_PROMOTION_ROOM_SIZE = "0";
    process.env.AUDIENCE_MODE = "true";
    process.env.CLERK_SECRET_KEY = "sk_test_voice_audience_cluster";
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    hub = createMemoryHub();
    bits.byUser.clear();
    sfu.rooms.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await pools[0]!
      .getPool()
      .query(
        `TRUNCATE voice_rooms, voice_audience_mode, voice_audience_speakers, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
      );
  });

  afterEach(async () => {
    await settle();
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      instance.admin.stopSfuResweeps();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previous.registry;
    process.env.CLERK_SECRET_KEY = previous.clerk;
    for (const name of [
      "VOICE_PROMOTION_ROOM_SIZE",
      "AUDIENCE_MODE",
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
    ]) {
      delete process.env[name];
    }
    vi.restoreAllMocks();
  });

  /** A host on A, a member on B, both connected to the SFU. */
  async function stage() {
    const channel = randomUUID();
    const host = randomUUID();
    const member = randomUUID();
    bits.byUser.set(host, (1n << 64n) - 1n);
    const a = await bootInstance();
    const b = await bootInstance();
    const hostOnA = await join(a, host, channel);
    const memberOnB = await join(b, member, channel);
    await settle();
    await connect(a, hostOnA, channel);
    await connect(b, memberOnB, channel);
    return { channel, host, member, a, b, hostOnA, memberOnB };
  }

  it("a toggle on A silences, at the media server, a member whose socket is on B, and B tells them why", async () => {
    const { channel, host, a, hostOnA, memberOnB } = await stage();
    expect(audible(memberOnB, channel)).toBe(true);

    const result = await a.voice.setVoiceAudienceMode(channel, true, host);
    expect(result.enforcement).toEqual({ transport: "livekit", pendingUserIds: [], unreachable: false });
    // The SFU half ran on A against the SFU's own list, which has B's seat.
    expect(audible(memberOnB, channel)).toBe(false);
    expect(tryToSpeak(memberOnB, channel)).toBe(false);
    expect(audible(hostOnA, channel)).toBe(true);
    // The row is the truth.
    const rows = await pools[0]!
      .getPool()
      .query<{ enabled_by: string }>(`SELECT enabled_by FROM voice_audience_mode WHERE channel_id = $1`, [
        channel,
      ]);
    expect(rows.rows).toEqual([{ enabled_by: host }]);
    // B heard the hint, re-read the row and told its own seat.
    await waitFor(() => last(memberOnB, "voice-speak-changed") !== undefined, "speak-changed on B");
    expect(last(memberOnB, "voice-speak-changed")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
    });
    await waitFor(() => last(memberOnB, "voice-audience")?.change !== undefined, "state on B");
    expect(last(memberOnB, "voice-audience")).toMatchObject({
      audience: { byUserId: host },
      change: { kind: "on", byUserId: host },
    });
  });

  it("a machine that never heard the toggle still seats a joiner locked, from the row", async () => {
    const { channel, host, a } = await stage();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    const c = await bootInstance();
    const late = await join(c, randomUUID(), channel);
    expect(late.frames.find((f) => f.type === "welcome")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
      audience: { byUserId: host },
    });
    await connect(c, late, channel);
    expect(audible(late, channel)).toBe(false);
  });

  it("a moderator turning it off on B gives B's member the microphone back", async () => {
    const { channel, host, a, b, memberOnB } = await stage();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    const off = await b.voice.setVoiceAudienceMode(channel, false, host);
    expect(off.audience).toBeNull();
    expect(tryToSpeak(memberOnB, channel)).toBe(true);
    await waitFor(
      () => last(memberOnB, "voice-speak-changed")?.canSpeak === true,
      "speak restored on B",
    );
    const rows = await pools[0]!
      .getPool()
      .query(`SELECT 1 FROM voice_audience_mode WHERE channel_id = $1`, [channel]);
    expect(rows.rowCount).toBe(0);
  });

  it("an invitation made on A reaches the member on B, and the media server lets them speak", async () => {
    const { channel, host, member, a, memberOnB } = await stage();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    const granted = await a.voice.setVoiceAudienceSpeaker(channel, member, true, host);
    expect(granted.audience!.speakerUserIds).toEqual([member]);
    expect(tryToSpeak(memberOnB, channel)).toBe(true);
    await waitFor(
      () => last(memberOnB, "voice-speak-changed")?.canSpeak === true,
      "invitation on B",
    );
    expect(last(memberOnB, "voice-speak-changed")).toMatchObject({ canSpeak: true, canStream: false });
  });

  it("a resume onto the other machine comes back locked with the reason", async () => {
    const { channel, host, member, a, b, memberOnB } = await stage();
    b.voice.removeVoicePeerBySocket(memberOnB.socket);
    await settle();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    // The participant whose socket is gone was still silenced at the SFU.
    expect(audible(memberOnB, channel)).toBe(false);
    const back = await join(a, member, channel, {
      resumePeerId: memberOnB.peerId,
      resumeToken: memberOnB.resumeToken,
    });
    expect(back.frames.find((f) => f.type === "welcome")).toMatchObject({
      peerId: memberOnB.peerId,
      canSpeak: false,
      speakReason: "audience",
    });
  });

  it("when the host leaves A, B's sweep reads the rows, finds nobody who runs the stage, and turns it off", async () => {
    const { channel, host, a, b, hostOnA, memberOnB } = await stage();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    await a.voice.handleVoiceMessage(
      { socket: hostOnA.socket, user: asUser(host) },
      { type: "leave-voice-room" },
    );
    await settle();
    await b.voice.sweepAudienceModes();
    await waitFor(
      () => last(memberOnB, "voice-audience")?.audience === null,
      "audience off on B",
    );
    expect(last(memberOnB, "voice-audience")).toMatchObject({
      change: { kind: "off", reason: "no-host" },
    });
    expect(tryToSpeak(memberOnB, channel)).toBe(true);
  });

  it("does not end while a moderator on B is still in the call", async () => {
    const { channel, host, a, b, hostOnA, memberOnB } = await stage();
    const mod = randomUUID();
    const { Permission, PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
    bits.byUser.set(mod, PERMISSION_DEFAULT_EVERYONE | Permission.MUTE_MEMBERS);
    await join(b, mod, channel);
    await settle();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    await a.voice.handleVoiceMessage(
      { socket: hostOnA.socket, user: asUser(host) },
      { type: "leave-voice-room" },
    );
    await settle();
    await b.voice.sweepAudienceModes();
    expect(last(memberOnB, "voice-audience")?.audience).not.toBeNull();
    const rows = await pools[0]!
      .getPool()
      .query(`SELECT 1 FROM voice_audience_mode WHERE channel_id = $1`, [channel]);
    expect(rows.rowCount).toBe(1);
  });

  it("ends with the call: the rows cascade when the room empties", async () => {
    const { channel, host, member, a, b, hostOnA, memberOnB } = await stage();
    await a.voice.setVoiceAudienceMode(channel, true, host);
    await a.voice.setVoiceAudienceSpeaker(channel, member, true, host);
    await a.voice.handleVoiceMessage(
      { socket: hostOnA.socket, user: asUser(host) },
      { type: "leave-voice-room" },
    );
    await b.voice.handleVoiceMessage(
      { socket: memberOnB.socket, user: asUser(member) },
      { type: "leave-voice-room" },
    );
    await settle();
    const pool = pools[0]!.getPool();
    expect((await pool.query(`SELECT 1 FROM voice_audience_mode`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM voice_audience_speakers`)).rowCount).toBe(0);
  });
});
