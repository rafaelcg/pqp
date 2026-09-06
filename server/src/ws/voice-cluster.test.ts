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
import type { WatchPartyState } from "@pqp/shared";
import type { DbUser } from "../db.js";
import { createMemoryHub, type BusFrame } from "../lib/bus.js";

/**
 * Voice across two instances: milestone M2 of
 * `docs/plans/MULTI_INSTANCE_VOICE.md`.
 *
 * The same harness as `cluster.test.ts` (two module graphs over one memory
 * hub, so `peers`, the roster queue and the bus subscriptions are genuinely
 * separate), plus the thing chat never needed: a real Postgres, because the
 * rows are what a `voice.room` frame tells the other instance to re-read.
 * The two graphs each open their own pool on `TEST_DATABASE_URL`, which is
 * exactly two machines sharing one database.
 *
 * What is pinned: a join, a leave, a state toggle and a rename on A reach
 * the room peers and the audience sockets on B; a watch-party write on A
 * reaches B's room, and a write on B that lost in the row (B missed the
 * frame) is refused and handed the row's winner; a socket authenticating on
 * B is sent A's rooms; and with either switch off, nothing crosses and the
 * flag-off instance behaves exactly as today.
 *
 * Skips without a database, like `voice-registry.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const naming = vi.hoisted(() => ({ shown: new Map<string, string>() }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { id: string; display_name: string },
  ) => naming.shown.get(user.id) ?? user.display_name,
  canAccessChannel: async () => true,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  // Everyone can see every channel: a roster that failed to cross would be
  // visible here rather than hidden by a scoping rule.
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
  getServerVoiceProfile: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
}));

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  registry: RegistryModule;
  db: DbModule;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

let hub = createMemoryHub();
let onTheWire: BusFrame[] = [];
const pools: DbModule[] = [];
const booted: Instance[] = [];

async function bootInstance(connected = true): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const registry = (await import("../voice/registry.js")) as RegistryModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  const instance = { bus, voice, sockets, registry, db };
  pools.push(db);
  booted.push(instance);
  return instance;
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

function frames(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
}

interface RosterFrame {
  participants: { peerId: string; displayName: string; muted: boolean }[];
}

function lastRoster(rec: Recorder, channel: string): RosterFrame | undefined {
  const all = frames(rec, "voice-roster").filter(
    (f) => f.voiceChannelId === channel,
  );
  return all[all.length - 1] as unknown as RosterFrame | undefined;
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

/** A socket that only watches the channel list: the roster's audience. */
function watcher(instance: Instance): Recorder {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(randomUUID()));
  return rec;
}

async function join(
  instance: Instance,
  userId: string,
  channel: string,
): Promise<Recorder & { peerId: string; resumeToken: string }> {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  const welcome = frames(rec, "welcome")[0];
  if (!welcome) {
    throw new Error("join was refused");
  }
  return {
    ...rec,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
  };
}

async function settle(): Promise<void> {
  for (const instance of booted) {
    await instance.registry.settleVoiceRegistryWrites();
  }
}

function party(rev: number, actorId: string, extra: Partial<WatchPartyState> = {}): WatchPartyState {
  return {
    videoId: "dQw4w9WgXcQ",
    status: "playing",
    positionMs: 0,
    atMs: Date.now(),
    rev,
    actorId,
    ...extra,
  };
}

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("voice across two instances", () => {
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
    hub = createMemoryHub();
    onTheWire = [];
    hub.listeners.add((frame) => onTheWire.push(frame));
    naming.shown.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = pools[0]!;
    await db
      .getPool()
      .query(`TRUNCATE voice_rooms, voice_peers, voice_retired_peers, voice_instances`);
  });

  afterEach(async () => {
    await settle();
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      await instance.bus.closeBus();
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  describe("roster and room events", () => {
    it("a join on A reaches the room and the audience on B", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnB = watcher(b);
      const inRoomOnB = await join(b, randomUUID(), channel);

      const joiner = await join(a, randomUUID(), channel);

      // The room frame, to B's peer in the call.
      await waitFor(
        () => frames(inRoomOnB, "peer-joined").length === 1,
        "peer-joined on B",
      );
      expect(frames(inRoomOnB, "peer-joined")[0]?.peer).toMatchObject({
        peerId: joiner.peerId,
      });
      // The roster, rebuilt from the rows, to everyone on B who can see the
      // channel: both peers, whichever machine holds them.
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 2,
        "roster with both peers on B",
      );
      expect(
        lastRoster(sidebarOnB, channel)?.participants.map((p) => p.peerId).sort(),
      ).toEqual([inRoomOnB.peerId, joiner.peerId].sort());
      // And the joiner's own welcome listed B's peer, from the rows.
      expect(
        (frames(joiner, "welcome")[0]?.peers as { peerId: string }[]).map(
          (p) => p.peerId,
        ),
      ).toEqual([inRoomOnB.peerId]);
    });

    it("a leave on A removes the peer on B", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnB = watcher(b);
      const inRoomOnB = await join(b, randomUUID(), channel);
      const userA = randomUUID();
      const leaver = await join(a, userA, channel);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 2,
        "both on B",
      );

      await a.voice.handleVoiceMessage(
        { socket: leaver.socket, user: asUser(userA) },
        { type: "leave-voice-room" },
      );

      await waitFor(
        () => frames(inRoomOnB, "peer-left").length === 1,
        "peer-left on B",
      );
      expect(frames(inRoomOnB, "peer-left")[0]?.peerId).toBe(leaver.peerId);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 1,
        "roster without the leaver on B",
      );
      expect(lastRoster(sidebarOnB, channel)?.participants[0]?.peerId).toBe(
        inRoomOnB.peerId,
      );
    });

    it("a state toggle on A shows on B's roster", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnB = watcher(b);
      await join(b, randomUUID(), channel);
      const userA = randomUUID();
      const peerA = await join(a, userA, channel);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 2,
        "both on B",
      );

      await a.voice.handleVoiceMessage(
        { socket: peerA.socket, user: asUser(userA) },
        { type: "set-voice-state", muted: true, deafened: false },
      );

      await waitFor(
        () =>
          lastRoster(sidebarOnB, channel)?.participants.find(
            (p) => p.peerId === peerA.peerId,
          )?.muted === true,
        "muted badge on B",
      );
    });

    it("a rename on A crosses as peer-updated and relabels B's own seat for the same person", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userId = randomUUID();
      const sidebarOnB = watcher(b);
      const bystanderOnB = await join(b, randomUUID(), channel);
      // The same person, one tab per machine.
      const seatOnB = await join(b, userId, channel);
      const seatOnA = await join(a, userId, channel);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 3,
        "all three on B",
      );

      naming.shown.set(userId, "Renamed");
      await a.voice.refreshVoiceIdentity(userId, {
        display_name: "Renamed",
        avatar_url: null,
      });

      // Both of this person's seats are relabelled in B's room: A's via the
      // room frame, B's via the identity frame (B's own local half).
      await waitFor(
        () =>
          new Set(
            frames(bystanderOnB, "peer-updated").map(
              (f) => (f.peer as { peerId: string }).peerId,
            ),
          ).size === 2,
        "peer-updated for both seats on B",
      );
      for (const update of frames(bystanderOnB, "peer-updated")) {
        expect(update.peer).toMatchObject({ displayName: "Renamed" });
      }
      await waitFor(
        () =>
          lastRoster(sidebarOnB, channel)
            ?.participants.filter((p) => p.displayName === "Renamed")
            .length === 2,
        "roster on B with both seats renamed",
      );
      await settle();
      const rows = await pools[0]!.getPool().query<{ display_name: string }>(
        `SELECT display_name FROM voice_peers WHERE peer_id = ANY($1::uuid[])`,
        [[seatOnA.peerId, seatOnB.peerId]],
      );
      expect(rows.rows.map((r) => r.display_name)).toEqual(["Renamed", "Renamed"]);
    });

    it("does not republish a frame it received", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await join(b, randomUUID(), channel);
      onTheWire.length = 0;

      await join(a, randomUUID(), channel);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // One `voice.room` from A. If B answered it, this would be two (and
      // without the origin guard it would never stop).
      expect(onTheWire.filter((f) => f.topic === "voice.room")).toHaveLength(1);
    });

    it("sends a socket authenticating on B the rooms A holds", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const peerA = await join(a, randomUUID(), channel);
      await settle();

      const fresh = recorder();
      await b.voice.sendAllVoiceRosters(fresh.socket, asUser(randomUUID()));

      expect(lastRoster(fresh, channel)?.participants.map((p) => p.peerId)).toEqual([
        peerA.peerId,
      ]);
    });
  });

  describe("watch party", () => {
    it("a write on A reaches the room on B, and a mid-film joiner on B is handed it", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userA = randomUUID();
      const host = await join(a, userA, channel);
      const viewerOnB = await join(b, randomUUID(), channel);

      const state = party(1, host.peerId);
      await a.voice.handleVoiceMessage(
        { socket: host.socket, user: asUser(userA) },
        { type: "set-watch-party", state },
      );

      // The echo on A, the crossing on B.
      expect(frames(host, "watch-party")[0]?.state).toMatchObject({ rev: 1 });
      await waitFor(
        () => frames(viewerOnB, "watch-party").length === 1,
        "watch-party on B",
      );
      expect(frames(viewerOnB, "watch-party")[0]?.state).toMatchObject({
        rev: 1,
        videoId: state.videoId,
      });

      // A third person joins on B after the fact: the row, not a frame.
      const late = await join(b, randomUUID(), channel);
      expect(frames(late, "watch-party")[0]?.state).toMatchObject({ rev: 1 });
    });

    it("refuses a write that lost in the row when B missed the frame", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userA = randomUUID();
      const userB = randomUUID();
      const host = await join(a, userA, channel);
      const writerOnB = await join(b, userB, channel);
      const bystanderOnB = await join(b, randomUUID(), channel);

      await a.voice.handleVoiceMessage(
        { socket: host.socket, user: asUser(userA) },
        { type: "set-watch-party", state: party(1, host.peerId) },
      );
      await waitFor(
        () => frames(writerOnB, "watch-party").length === 1,
        "rev 1 on B",
      );

      // B goes deaf (a bus blip); A moves the film on without B hearing.
      await b.bus.closeBus();
      await a.voice.handleVoiceMessage(
        { socket: host.socket, user: asUser(userA) },
        {
          type: "set-watch-party",
          state: party(5, host.peerId, { positionMs: 90_000 }),
        },
      );
      expect(frames(writerOnB, "watch-party")).toHaveLength(1);

      // B's cache still holds rev 1, so locally rev 3 looks fresh. The row
      // knows better.
      bystanderOnB.frames.length = 0;
      await b.voice.handleVoiceMessage(
        { socket: writerOnB.socket, user: asUser(userB) },
        {
          type: "set-watch-party",
          state: party(3, writerOnB.peerId, { positionMs: 10_000 }),
        },
      );

      // The loser is handed the winner, alone; the room hears nothing.
      const answer = frames(writerOnB, "watch-party")[1];
      expect(answer?.state).toMatchObject({ rev: 5, positionMs: 90_000 });
      expect(frames(bystanderOnB, "watch-party")).toHaveLength(0);
      const row = await pools[0]!.getPool().query<{ watch_party_rev: string }>(
        `SELECT watch_party_rev FROM voice_rooms WHERE channel_id = $1`,
        [channel],
      );
      expect(Number(row.rows[0]?.watch_party_rev)).toBe(5);
    });

    it("a teardown on A ends the party on B", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userA = randomUUID();
      const host = await join(a, userA, channel);
      const viewerOnB = await join(b, randomUUID(), channel);
      await a.voice.handleVoiceMessage(
        { socket: host.socket, user: asUser(userA) },
        { type: "set-watch-party", state: party(1, host.peerId) },
      );
      await waitFor(() => frames(viewerOnB, "watch-party").length === 1, "start");

      await a.voice.handleVoiceMessage(
        { socket: host.socket, user: asUser(userA) },
        { type: "set-watch-party", state: null },
      );

      await waitFor(() => frames(viewerOnB, "watch-party").length === 2, "end");
      expect(frames(viewerOnB, "watch-party")[1]?.state).toBeNull();
      const row = await pools[0]!.getPool().query<{ watch_party: unknown }>(
        `SELECT watch_party FROM voice_rooms WHERE channel_id = $1`,
        [channel],
      );
      expect(row.rows[0]?.watch_party).toBeNull();
    });
  });

  describe("with a switch off", () => {
    it("registry on, bus off: rows are written and nothing crosses", async () => {
      const channel = randomUUID();
      const a = await bootInstance(false);
      const b = await bootInstance(false);
      const sidebarOnB = watcher(b);
      const inRoomOnB = await join(b, randomUUID(), channel);
      sidebarOnB.frames.length = 0;

      const peerA = await join(a, randomUUID(), channel);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTheWire).toEqual([]);
      expect(frames(inRoomOnB, "peer-joined")).toHaveLength(0);
      expect(sidebarOnB.frames).toEqual([]);
      // The rows still describe the whole cluster, which is what the
      // periodic reconcile of M3 rebuilds from when the bus returns.
      const rows = await pools[0]!.getPool().query<{ peer_id: string }>(
        `SELECT peer_id FROM voice_peers WHERE channel_id = $1`,
        [channel],
      );
      expect(rows.rows.map((r) => r.peer_id).sort()).toEqual(
        [inRoomOnB.peerId, peerA.peerId].sort(),
      );
    });

    it("bus on, registry off: no voice frames, no rows, today's behaviour", async () => {
      process.env.VOICE_REGISTRY = "off";
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnA = watcher(a);
      const sidebarOnB = watcher(b);
      const inRoomOnB = await join(b, randomUUID(), channel);
      sidebarOnB.frames.length = 0;

      const peerA = await join(a, randomUUID(), channel);
      await a.voice.handleVoiceMessage(
        { socket: peerA.socket, user: asUser("x") },
        { type: "set-watch-party", state: party(1, peerA.peerId) },
      );
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTheWire.filter((f) => f.topic.startsWith("voice."))).toEqual([]);
      expect(frames(inRoomOnB, "peer-joined")).toHaveLength(0);
      expect(frames(inRoomOnB, "watch-party")).toHaveLength(0);
      expect(sidebarOnB.frames).toEqual([]);
      // A is its own world: its roster is its own map.
      expect(lastRoster(sidebarOnA, channel)?.participants.map((p) => p.peerId)).toEqual([
        peerA.peerId,
      ]);
      expect(
        (await pools[0]!.getPool().query(`SELECT 1 FROM voice_peers`)).rowCount,
      ).toBe(0);
    });
  });
});
