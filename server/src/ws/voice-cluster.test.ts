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
 * Voice across two instances: milestones M2 and M3 of
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
 * M3 (the "resume across instances" and "reconcile" groups): a resume on B
 * for a seat A still holds adopts it with no `peer-left` anywhere; a seat
 * whose instance died by lease is orphaned, comes back if the client
 * returns within the resume window and is removed with `peer-left` on the
 * survivor after it; a hangup on A is refused as a resume on B; the beacon
 * on B retires a seat A holds; two instances running the reconcile at once
 * announce each departure once. Time is shifted in SQL (`heartbeat_at`,
 * `orphaned_at`) rather than with fake timers, because the sweep's clock is
 * the database's `NOW()`.
 *
 * M4 (the "moderation" group): a kick, a disconnect with notice, a channel
 * deletion and a channel turned private, each requested on A for a socket
 * B holds, drop the peer on B (the notice first, when there is one), take
 * the row, announce the departure once, and run the SFU half exactly once,
 * on A. Rings are in `voice-calls.test.ts`.
 *
 * The two-machine prerequisites (the "mesh across instances" and
 * "moderator mutes across instances" groups): a mesh room pinned on A
 * seats and resumes on B with offer, answer and ICE crossing on
 * `voice.signal`, never a `voice-join-refused`; a fresh room still opens on
 * the SFU while two are live; a frame never crosses into another room; the
 * ceiling counts both machines; the operator counters climb; a moderator's
 * mute set on A holds on B, survives a resume and a rejoin through a third
 * process, and dies with the room.
 *
 * Skips without a database, like `voice-registry.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const naming = vi.hoisted(() => ({ shown: new Map<string, string>() }));

/**
 * Mesh by default, so the M2 and M4 groups run the transport they were
 * written against. The M3 group runs on LiveKit, production's transport;
 * the two-machine groups flip this per test.
 */
const backend = vi.hoisted(() => ({
  configured: "mesh" as "mesh" | "livekit",
  /** What `getServerVoiceProfile` answers; null is the configured default. */
  profile: null as { isCommunity: boolean; memberCount: number } | null,
}));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
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
  resolveMemberChannelPermissions: async () => ({
    permissions: (1n << 64n) - 1n,
    nickname: null,
  }),
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
  getServerVoiceProfile: async () => backend.profile,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");
type AdminModule = typeof import("../voice/admin.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  registry: RegistryModule;
  db: DbModule;
  /** The (mocked) SFU half, per graph: which instance ran it is the point. */
  admin: AdminModule;
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
  const admin = (await import("../voice/admin.js")) as AdminModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  const instance = { bus, voice, sockets, registry, db, admin };
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
    throw new Error(`join was refused: ${JSON.stringify(rec.frames)}`);
  }
  return {
    ...rec,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
  };
}

/** The same audience socket, having negotiated `voice-roster-delta` at auth. */
function deltaWatcher(instance: Instance): Recorder {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(randomUUID()), [
    instance.sockets.SOCKET_CAPS.voiceRosterDelta,
  ]);
  return rec;
}

interface DeltaFrame {
  seq: number;
  size: number;
  joined?: { peerId: string }[];
  updated?: { peerId: string; muted: boolean }[];
  left?: string[];
}

function deltas(rec: Recorder, channel: string): DeltaFrame[] {
  return frames(rec, "voice-roster-delta").filter(
    (f) => f.voiceChannelId === channel,
  ) as unknown as DeltaFrame[];
}

async function settle(): Promise<void> {
  for (const instance of booted) {
    await instance.registry.settleVoiceRegistryWrites();
  }
}

/** Make an instance's lease look `secondsAgo` old (dead past 45 s). */
async function ageLease(instance: Instance, secondsAgo: number): Promise<void> {
  await pools[0]!.getPool().query(
    `UPDATE voice_instances
        SET heartbeat_at = NOW() - ($2::int * INTERVAL '1 second')
      WHERE instance_id = $1`,
    [instance.bus.INSTANCE_ID, secondsAgo],
  );
}

async function ageOrphan(peerId: string, secondsAgo: number): Promise<void> {
  await pools[0]!.getPool().query(
    `UPDATE voice_peers
        SET orphaned_at = NOW() - ($2::int * INTERVAL '1 second')
      WHERE peer_id = $1`,
    [peerId, secondsAgo],
  );
}

async function peerRow(
  peerId: string,
): Promise<{ instance_id: string; orphaned_at: Date | null } | undefined> {
  const result = await pools[0]!.getPool().query<{
    instance_id: string;
    orphaned_at: Date | null;
  }>(`SELECT instance_id, orphaned_at FROM voice_peers WHERE peer_id = $1`, [
    peerId,
  ]);
  return result.rows[0];
}

async function resume(
  instance: Instance,
  userId: string,
  channel: string,
  peerId: string,
  resumeToken: string,
): Promise<Recorder> {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      resume: true,
      resumePeerId: peerId,
      resumeToken,
    },
  );
  return rec;
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
      .query(`TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_retired_peers, voice_instances`);
  });

  afterEach(async () => {
    await settle();
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      await instance.bus.closeBus();
      // Each instance is its own pool. Closed here, not in afterAll: forty
      // idle pools across the file is more than Postgres' default hundred
      // connections, and a write that cannot get one is swallowed into a
      // (mocked) log, which shows up as a row that is simply not there.
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    backend.configured = "mesh";
    backend.profile = null;
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

    it("a join, a toggle and a leave on A reach a B watcher that asked for deltas as deltas", async () => {
      // The registry path used to send no deltas at all: the local event
      // queue could not describe a change made on the other machine, so
      // every change went to every audience socket as a whole roster. Now
      // the rows are diffed against what B last sent, and A's peer is in the
      // rows and not in that memory, which is exactly a `joined`.
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnB = deltaWatcher(b);
      await join(b, randomUUID(), channel);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 1,
        "B's own roster on B",
      );

      const userA = randomUUID();
      const joiner = await join(a, userA, channel);
      await waitFor(() => deltas(sidebarOnB, channel).length === 1, "joined delta on B");
      expect(deltas(sidebarOnB, channel)[0]).toMatchObject({
        seq: 2,
        size: 2,
        joined: [{ peerId: joiner.peerId }],
      });
      expect(deltas(sidebarOnB, channel)[0]?.left).toBeUndefined();

      await a.voice.handleVoiceMessage(
        { socket: joiner.socket, user: asUser(userA) },
        { type: "set-voice-state", muted: true, deafened: false },
      );
      await waitFor(() => deltas(sidebarOnB, channel).length === 2, "updated delta on B");
      expect(deltas(sidebarOnB, channel)[1]).toMatchObject({
        seq: 3,
        size: 2,
        updated: [{ peerId: joiner.peerId, muted: true }],
      });

      await a.voice.handleVoiceMessage(
        { socket: joiner.socket, user: asUser(userA) },
        { type: "leave-voice-room" },
      );
      await waitFor(() => deltas(sidebarOnB, channel).length === 3, "left delta on B");
      expect(deltas(sidebarOnB, channel)[2]).toMatchObject({
        seq: 4,
        size: 1,
        left: [joiner.peerId],
      });
      // Three changes on A, one whole roster on B: the one that opened the room.
      expect(
        frames(sidebarOnB, "voice-roster").filter((f) => f.voiceChannelId === channel),
      ).toHaveLength(1);
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

  describe("resume across instances", () => {
    // On the SFU, which is what production runs; a mesh seat moving
    // machines is pinned by the "mesh across instances" group below. The
    // resume mechanics are the same on either transport.
    beforeEach(() => {
      backend.configured = "livekit";
    });

    it("a resume on B for a seat A still holds adopts it, with no peer-left anywhere", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      const userId = randomUUID();
      const bystanderOnA = await join(a, randomUUID(), channel);
      const bystanderOnB = await join(b, randomUUID(), channel);
      const seat = await join(a, userId, channel);
      await waitFor(
        () => frames(bystanderOnB, "peer-joined").length === 1,
        "the seat on B",
      );
      await settle();
      bystanderOnA.frames.length = 0;
      bystanderOnB.frames.length = 0;

      // The Wi-Fi blip: the client's next socket lands on B while A still
      // thinks the old one is live.
      const again = await resume(b, userId, channel, seat.peerId, seat.resumeToken);

      const welcome = frames(again, "welcome")[0];
      expect(welcome?.peerId).toBe(seat.peerId);
      expect(welcome?.resumed).toBe(true);
      // The seat is B's now, and A forgot it without a word.
      await settle();
      expect((await peerRow(seat.peerId))?.instance_id).toBe(b.bus.INSTANCE_ID);
      await waitFor(
        () => a.voice.getVoicePeer(seat.peerId) === null,
        "A to drop the seat",
      );
      expect(b.voice.getVoicePeer(seat.peerId)).toMatchObject({ userId });
      // A's room hears the person is (still) here, never that they left.
      await waitFor(
        () => frames(bystanderOnA, "peer-joined").length === 1,
        "peer-joined on A",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(bystanderOnA, "peer-left")).toHaveLength(0);
      expect(frames(bystanderOnB, "peer-left")).toHaveLength(0);
      // A's room still counts three, once each. Read through a fresh socket
      // rather than waited for on the wire: the seat changing hands changes
      // nothing about who is in the room, so A's roster run finds the rows
      // saying what its last frame said and, since the deltas, writes
      // nothing rather than restating the room to everyone.
      const probeOnA = recorder();
      await a.voice.sendAllVoiceRosters(probeOnA.socket, asUser(randomUUID()));
      expect(lastRoster(probeOnA, channel)?.participants).toHaveLength(3);
      expect(
        lastRoster(probeOnA, channel)?.participants.filter(
          (p) => p.peerId === seat.peerId,
        ),
      ).toHaveLength(1);
      // The old socket's eventual close is nothing now.
      a.voice.removeVoicePeerBySocket(seat.socket);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(bystanderOnA, "peer-left")).toHaveLength(0);
    });

    it("A dies by lease: the seat is orphaned, a resume within the window reattaches on B", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      const userId = randomUUID();
      const bystanderOnB = await join(b, randomUUID(), channel);
      const seat = await join(a, userId, channel);
      await waitFor(
        () => frames(bystanderOnB, "peer-joined").length === 1,
        "seat on B",
      );
      await settle();

      // A stops answering; 60 s later B's reconcile runs.
      await a.bus.closeBus();
      await ageLease(a, 60);
      bystanderOnB.frames.length = 0;
      const first = await b.voice.runVoiceReconcile();
      expect(first).toMatchObject({ orphaned: 1, removed: 0 });
      const row = await peerRow(seat.peerId);
      expect(row?.orphaned_at).not.toBeNull();
      // Still on the roster, socket gone, seat held.
      await settle();
      await waitFor(
        () => lastRoster(bystanderOnB, channel)?.participants.length === 2,
        "roster on B still lists the orphan",
      );
      expect(frames(bystanderOnB, "peer-left")).toHaveLength(0);
      // Once orphaned, a second pass is a no-op.
      expect(await b.voice.runVoiceReconcile()).toMatchObject({
        orphaned: 0,
        removed: 0,
      });

      // The client comes back, on the machine that is left.
      const again = await resume(b, userId, channel, seat.peerId, seat.resumeToken);
      expect(frames(again, "welcome")[0]?.peerId).toBe(seat.peerId);
      expect(frames(again, "welcome")[0]?.resumed).toBe(true);
      await settle();
      expect(await peerRow(seat.peerId)).toMatchObject({
        instance_id: b.bus.INSTANCE_ID,
        orphaned_at: null,
      });
      expect(frames(bystanderOnB, "peer-left")).toHaveLength(0);
      // The seat is B's own now; the reconcile leaves it alone.
      expect(await b.voice.runVoiceReconcile()).toMatchObject({
        orphaned: 0,
        removed: 0,
      });
    });

    it("A dies by lease: past the window the seat is removed with peer-left on B and the id retired", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      const userId = randomUUID();
      const sidebarOnB = watcher(b);
      const bystanderOnB = await join(b, randomUUID(), channel);
      const seat = await join(a, userId, channel);
      await waitFor(
        () => frames(bystanderOnB, "peer-joined").length === 1,
        "seat on B",
      );
      await settle();

      await a.bus.closeBus();
      // Dead two minutes: the orphan is stamped as of the last heartbeat,
      // which is already past the 90 s window, so one pass both orphans
      // and removes. The client was unreachable the whole time.
      await ageLease(a, 120);
      bystanderOnB.frames.length = 0;
      expect(await b.voice.runVoiceReconcile()).toMatchObject({
        orphaned: 1,
        removed: 1,
      });
      expect(await b.voice.runVoiceReconcile()).toMatchObject({
        orphaned: 0,
        removed: 0,
      });

      expect(frames(bystanderOnB, "peer-left")[0]?.peerId).toBe(seat.peerId);
      await waitFor(
        () => lastRoster(sidebarOnB, channel)?.participants.length === 1,
        "roster on B without the dead seat",
      );
      expect(await peerRow(seat.peerId)).toBeUndefined();
      // Retired: the token cannot rebuild the id on the survivor.
      const again = await resume(b, userId, channel, seat.peerId, seat.resumeToken);
      expect(frames(again, "welcome")[0]?.peerId).not.toBe(seat.peerId);
      expect(frames(again, "welcome")[0]?.resumed).toBeUndefined();
      // And the dead lease is gone.
      const leases = await pools[0]!.getPool().query(
        `SELECT 1 FROM voice_instances WHERE instance_id = $1`,
        [a.bus.INSTANCE_ID],
      );
      expect(leases.rowCount).toBe(0);
    });

    it("sweeps a room row nobody is in, once it is old enough", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await pools[0]!.getPool().query(
        `INSERT INTO voice_rooms (channel_id, transport, created_at)
         VALUES ($1, 'mesh', NOW() - INTERVAL '5 minutes'),
                ($2, 'mesh', NOW())`,
        [channel, randomUUID()],
      );
      expect(await a.voice.runVoiceReconcile()).toMatchObject({ roomsSwept: 1 });
      const rooms = await pools[0]!.getPool().query(`SELECT 1 FROM voice_rooms`);
      expect(rooms.rowCount).toBe(1);
    });

    it("a hangup on A is refused as a resume on B", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userId = randomUUID();
      const seat = await join(a, userId, channel);
      await a.voice.handleVoiceMessage(
        { socket: seat.socket, user: asUser(userId) },
        { type: "leave-voice-room" },
      );
      await settle();

      const again = await resume(b, userId, channel, seat.peerId, seat.resumeToken);
      expect(frames(again, "welcome")[0]?.peerId).not.toBe(seat.peerId);
      expect(frames(again, "welcome")[0]?.resumed).toBeUndefined();
    });

    it("the beacon on B retires a seat A holds, and A forgets it without a second peer-left", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const userId = randomUUID();
      const bystanderOnA = await join(a, randomUUID(), channel);
      const bystanderOnB = await join(b, randomUUID(), channel);
      const seat = await join(a, userId, channel);
      await waitFor(
        () => frames(bystanderOnB, "peer-joined").length === 1,
        "seat on B",
      );
      await settle();
      // The tab closes: `/ws` is already gone, the beacon lands on B.
      a.voice.removeVoicePeerBySocket(seat.socket);
      bystanderOnA.frames.length = 0;
      bystanderOnB.frames.length = 0;

      await expect(
        b.voice.leaveVoiceByResumeToken(seat.peerId, seat.resumeToken),
      ).resolves.toBe(true);

      await settle();
      expect(await peerRow(seat.peerId)).toBeUndefined();
      expect(frames(bystanderOnB, "peer-left")[0]?.peerId).toBe(seat.peerId);
      await waitFor(
        () => frames(bystanderOnA, "peer-left").length === 1,
        "peer-left on A",
      );
      await waitFor(
        () => a.voice.getVoicePeer(seat.peerId) === null,
        "A to drop the seat",
      );
      // A's orphan timer is gone with the entry: nothing fires later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(bystanderOnA, "peer-left")).toHaveLength(1);
      // Twice is nothing, and a forged token is nothing.
      await expect(
        b.voice.leaveVoiceByResumeToken(seat.peerId, seat.resumeToken),
      ).resolves.toBe(false);
      // Retired everywhere.
      const again = await resume(a, userId, channel, seat.peerId, seat.resumeToken);
      expect(frames(again, "welcome")[0]?.peerId).not.toBe(seat.peerId);
    });

    it("the beacon refuses a token that does not match the row", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const seat = await join(a, randomUUID(), channel);
      const other = await join(a, randomUUID(), randomUUID());
      await settle();
      await expect(
        b.voice.leaveVoiceByResumeToken(seat.peerId, other.resumeToken),
      ).resolves.toBe(false);
      expect(await peerRow(seat.peerId)).toBeDefined();
    });

    it("two instances racing the reconcile announce each departure once", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const c = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      await c.registry.heartbeatVoiceInstance();
      const bystanderOnB = await join(b, randomUUID(), channel);
      const bystanderOnC = await join(c, randomUUID(), channel);
      const seats = [
        await join(a, randomUUID(), channel),
        await join(a, randomUUID(), channel),
      ];
      await waitFor(
        () => frames(bystanderOnB, "peer-joined").length === 3,
        "everyone on B",
      );
      await settle();

      await a.bus.closeBus();
      await ageLease(a, 60);
      for (const seat of seats) {
        await ageOrphan(seat.peerId, 120);
      }
      // Already stamped as orphans (by A's close handlers, say) and past the
      // window: one pass removes. Both survivors run it in the same instant.
      bystanderOnB.frames.length = 0;
      bystanderOnC.frames.length = 0;
      onTheWire.length = 0;
      const [onB, onC] = await Promise.all([
        b.voice.runVoiceReconcile(),
        c.voice.runVoiceReconcile(),
      ]);
      expect(onB.removed + onC.removed).toBe(2);

      await settle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const gone = seats.map((s) => s.peerId).sort();
      expect(frames(bystanderOnB, "peer-left").map((f) => f.peerId).sort()).toEqual(gone);
      expect(frames(bystanderOnC, "peer-left").map((f) => f.peerId).sort()).toEqual(gone);
      expect(
        onTheWire.filter((f) => f.topic === "voice.room" && (f.data as { kind: string }).kind === "left"),
      ).toHaveLength(2);
      const rows = await pools[0]!.getPool().query(
        `SELECT 1 FROM voice_peers WHERE channel_id = $1`,
        [channel],
      );
      expect(rows.rowCount).toBe(2);
    });
  });

  describe("moderation", () => {
    // `vi.mock` registers one factory per file, and `vi.resetModules` does
    // not re-run it: every graph gets the same mocked `admin.js`, so its
    // call log is the cluster's, which is exactly what "the SFU half ran
    // once" has to be checked against.
    function sfuCalls<F extends "evictSfuUser" | "evictSfuRoom" | "evictSfuUsersExcept">(
      instance: Instance,
      fn: F,
    ): Parameters<AdminModule[F]>[] {
      return vi.mocked(instance.admin[fn]).mock.calls as Parameters<AdminModule[F]>[];
    }

    beforeEach(async () => {
      const shared = await import("../voice/admin.js");
      for (const fn of [shared.evictSfuUser, shared.evictSfuRoom, shared.evictSfuUsersExcept]) {
        vi.mocked(fn).mockClear();
      }
    });

    it("a kick on A of a user whose socket is on B drops them on B and evicts on the SFU once", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnA = watcher(a);
      const target = randomUUID();
      const bystanderOnB = await join(b, randomUUID(), channel);
      const targetOnB = await join(b, target, channel);
      await waitFor(
        () => lastRoster(sidebarOnA, channel)?.participants.length === 2,
        "both on A's roster",
      );
      bystanderOnB.frames.length = 0;

      a.voice.evictVoiceUser(target, new Set([channel]));

      await waitFor(
        () => frames(bystanderOnB, "peer-left").length === 1,
        "peer-left on B",
      );
      expect(frames(bystanderOnB, "peer-left")[0]?.peerId).toBe(targetOnB.peerId);
      expect(b.voice.getVoicePeer(targetOnB.peerId)).toBeNull();
      // The SFU half ran once in the cluster, after the rows were read, with
      // B's peer id in the identity hint.
      await waitFor(() => sfuCalls(a, "evictSfuUser").length === 1, "SFU once");
      const [userId, rooms, known] = sfuCalls(a, "evictSfuUser")[0]!;
      expect(userId).toBe(target);
      expect(rooms).toEqual([channel]);
      expect(known.get(targetOnB.peerId)).toBe(target);
      await settle();
      expect(await peerRow(targetOnB.peerId)).toBeUndefined();
      await waitFor(
        () => lastRoster(sidebarOnA, channel)?.participants.length === 1,
        "roster without the target on A",
      );
      // Announced once: B forgot the seat silently, A released the row.
      expect(frames(bystanderOnB, "peer-left")).toHaveLength(1);
      expect(sfuCalls(b, "evictSfuUser")).toHaveLength(1);
      // A retired id: the kicked seat cannot come back on either machine.
      const again = await resume(b, target, channel, targetOnB.peerId, targetOnB.resumeToken);
      expect(frames(again, "welcome")[0]?.resumed).toBeUndefined();
    });

    it("a disconnect on A tells the target on B before dropping them", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const target = randomUUID();
      const targetOnB = await join(b, target, channel);
      await join(b, randomUUID(), channel);
      await settle();

      expect(await a.voice.findVoiceChannelForUser(target, new Set([channel]))).toBe(channel);
      const known = await a.voice.findVoicePeerIdentities(target, channel);
      expect(known.get(targetOnB.peerId)).toBe(target);
      a.voice.disconnectVoiceUser(target, channel, { message: "Out." }, known);

      await waitFor(
        () => frames(targetOnB, "voice-moderation").length === 1,
        "the notice on B",
      );
      expect(frames(targetOnB, "voice-moderation")[0]).toMatchObject({
        action: "disconnected",
        voiceChannelId: channel,
        message: "Out.",
      });
      expect(b.voice.getVoicePeer(targetOnB.peerId)).toBeNull();
      await waitFor(() => sfuCalls(a, "evictSfuUser").length === 1, "SFU once");
      await settle();
      expect(await peerRow(targetOnB.peerId)).toBeUndefined();
    });

    it("an SFU mute notice on A reaches the target on B, who stays", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const target = randomUUID();
      const targetOnB = await join(b, target, channel);

      a.voice.notifyVoiceModeration(target, channel, {
        action: "muted",
        message: "Quiet.",
      });

      await waitFor(
        () => frames(targetOnB, "voice-moderation").length === 1,
        "the notice on B",
      );
      expect(frames(targetOnB, "voice-moderation")[0]).toMatchObject({
        action: "muted",
        message: "Quiet.",
      });
      expect(b.voice.getVoicePeer(targetOnB.peerId)).not.toBeNull();
    });

    it("a channel deletion on A empties the room on B, SFU once", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const one = await join(b, randomUUID(), channel);
      const two = await join(b, randomUUID(), channel);
      await join(a, randomUUID(), channel);
      await settle();

      a.voice.evictVoiceChannel(channel);

      await waitFor(
        () =>
          b.voice.getVoicePeer(one.peerId) === null &&
          b.voice.getVoicePeer(two.peerId) === null,
        "B's room emptied",
      );
      await waitFor(() => sfuCalls(a, "evictSfuRoom").length === 1, "SFU once");
      await settle();
      expect(await peerRow(one.peerId)).toBeUndefined();
      expect(await peerRow(two.peerId)).toBeUndefined();
      const room = await pools[0]!
        .getPool()
        .query(`SELECT 1 FROM voice_rooms WHERE channel_id = $1`, [channel]);
      expect(room.rowCount).toBe(0);
    });

    it("a channel turned private on A keeps the allowed on B and drops the rest", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const keep = randomUUID();
      const kept = await join(b, keep, channel);
      const dropped = await join(b, randomUUID(), channel);
      await settle();
      kept.frames.length = 0;

      a.voice.evictVoiceUsersExcept(channel, new Set([keep]));

      await waitFor(() => frames(kept, "peer-left").length === 1, "peer-left on B");
      expect(frames(kept, "peer-left")[0]?.peerId).toBe(dropped.peerId);
      expect(b.voice.getVoicePeer(kept.peerId)).not.toBeNull();
      expect(b.voice.getVoicePeer(dropped.peerId)).toBeNull();
      await waitFor(() => sfuCalls(a, "evictSfuUsersExcept").length === 1, "SFU once");
      await settle();
      expect(await peerRow(kept.peerId)).toBeDefined();
      expect(await peerRow(dropped.peerId)).toBeUndefined();
      const [, allowed, known] = sfuCalls(a, "evictSfuUsersExcept")[0]!;
      expect([...allowed]).toEqual([keep]);
      expect(known.get(dropped.peerId)).toBeDefined();
    });
  });

  describe("mesh across instances", () => {
    // What the 2026-09-07 window paid for: a mesh room pinned on one machine
    // hung up every resume that landed on the other. Now the pin is adopted
    // and the signaling crosses on `voice.signal`; the SFU is still where a
    // FRESH room goes while two are live and one is configured.
    const small = { isCommunity: false, memberCount: 3 };

    async function roomRow(channel: string): Promise<string | undefined> {
      const result = await pools[0]!.getPool().query<{ transport: string }>(
        `SELECT transport FROM voice_rooms WHERE channel_id = $1`,
        [channel],
      );
      return result.rows[0]?.transport;
    }

    async function signal(
      instance: Instance,
      from: Recorder & { peerId: string },
      frame: Frame,
    ): Promise<void> {
      await instance.voice.handleVoiceMessage(
        { socket: from.socket, user: asUser(randomUUID()) },
        { ...frame, from: from.peerId } as never,
      );
    }

    it("two live instances, no SFU: a mesh room opened on A seats a joiner on B, and the offer, answer and ICE cross", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      const onA = await join(a, randomUUID(), channel);
      expect(frames(onA, "welcome")[0]?.transport).toBe("mesh");
      await settle();

      const b = await bootInstance();
      await b.registry.heartbeatVoiceInstance();
      const onB = await join(b, randomUUID(), channel);
      // Seated, on the room's transport, told about A's peer, never refused.
      const welcome = frames(onB, "welcome")[0];
      expect(welcome?.transport).toBe("mesh");
      expect(
        (welcome?.peers as { peerId: string }[]).map((p) => p.peerId),
      ).toEqual([onA.peerId]);
      expect(frames(onB, "voice-join-refused")).toHaveLength(0);
      expect(await roomRow(channel)).toBe("mesh");
      await waitFor(
        () => frames(onA, "peer-joined").length === 1,
        "A's peer to hear about B's",
      );

      // The joiner offers to the peer it was told about, on the other machine.
      await signal(b, onB, { type: "offer", to: onA.peerId, sdp: "v=0 offer" });
      await waitFor(() => frames(onA, "offer").length === 1, "the offer on A");
      expect(frames(onA, "offer")[0]).toMatchObject({
        from: onB.peerId,
        to: onA.peerId,
        sdp: "v=0 offer",
      });
      await signal(a, onA, { type: "answer", to: onB.peerId, sdp: "v=0 answer" });
      await waitFor(() => frames(onB, "answer").length === 1, "the answer on B");
      expect(frames(onB, "answer")[0]).toMatchObject({ from: onA.peerId });
      await signal(a, onA, {
        type: "ice-candidate",
        to: onB.peerId,
        candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 1 typ host" },
      });
      await waitFor(() => frames(onB, "ice-candidate").length === 1, "ICE on B");

      // A frame for a peer held here never touches the bus.
      onTheWire.length = 0;
      const secondOnA = await join(a, randomUUID(), channel);
      await signal(a, secondOnA, { type: "offer", to: onA.peerId, sdp: "local" });
      expect(frames(onA, "offer").filter((f) => f.sdp === "local")).toHaveLength(1);
      expect(onTheWire.filter((f) => f.topic === "voice.signal")).toHaveLength(0);
    });

    it("a mesh resume on B for a seat A holds adopts the pin, keeps the seat and talks to A's peers", async () => {
      // An SFU is configured, so the old guard would have forced LiveKit and
      // turned the resume cold; the room is pinned mesh and stays so.
      backend.configured = "livekit";
      backend.profile = small;
      const channel = randomUUID();
      const a = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      const bystanderOnA = await join(a, randomUUID(), channel);
      const userId = randomUUID();
      const seat = await join(a, userId, channel);
      expect(frames(seat, "welcome")[0]?.transport).toBe("mesh");
      await settle();

      const b = await bootInstance();
      await b.registry.heartbeatVoiceInstance();
      const again = await resume(b, userId, channel, seat.peerId, seat.resumeToken);
      const welcome = frames(again, "welcome")[0];
      expect(frames(again, "voice-join-refused")).toHaveLength(0);
      expect(welcome?.resumed).toBe(true);
      expect(welcome?.peerId).toBe(seat.peerId);
      expect(welcome?.transport).toBe("mesh");
      expect(await roomRow(channel)).toBe("mesh");
      await settle();
      expect((await peerRow(seat.peerId))?.instance_id).toBe(b.bus.INSTANCE_ID);
      await waitFor(() => a.voice.getVoicePeer(seat.peerId) === null, "A drops the seat");

      // The resumed client re-offers to the bystander it still hears.
      const resumed = { ...again, peerId: seat.peerId };
      await signal(b, resumed, { type: "offer", to: bystanderOnA.peerId, sdp: "again" });
      await waitFor(
        () => frames(bystanderOnA, "offer").some((f) => f.sdp === "again"),
        "the re-offer on A",
      );
      await signal(a, bystanderOnA, { type: "answer", to: seat.peerId, sdp: "back" });
      await waitFor(() => frames(again, "answer").length === 1, "the answer on B");
    });

    it("a fresh room with two live instances and an SFU opens on LiveKit", async () => {
      backend.configured = "livekit";
      backend.profile = small;
      const channel = randomUUID();
      const a = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      // Control: alone, a three-member server is a mesh room.
      const alone = await join(a, randomUUID(), randomUUID());
      expect(frames(alone, "welcome")[0]?.transport).toBe("mesh");

      const b = await bootInstance();
      await b.registry.heartbeatVoiceInstance();
      const onA = await join(a, randomUUID(), channel);
      expect(frames(onA, "welcome")[0]?.transport).toBe("livekit");
      await settle();
      expect(await roomRow(channel)).toBe("livekit");
      const onB = await join(b, randomUUID(), channel);
      expect(frames(onB, "welcome")[0]?.transport).toBe("livekit");

      // B's shutdown withdraws its lease ahead of closing its sockets, and
      // the next fresh room on A is a mesh room again.
      await b.registry.withdrawVoiceInstance();
      const after = await join(a, randomUUID(), randomUUID());
      expect(frames(after, "welcome")[0]?.transport).toBe("mesh");
    });

    it("a signaling frame never crosses into another room", async () => {
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      const victimOnA = await join(a, randomUUID(), randomUUID());
      const attackerOnB = await join(b, randomUUID(), randomUUID());
      await settle();

      await signal(b, attackerOnB, { type: "offer", to: victimOnA.peerId, sdp: "x" });
      // The frame did cross (B cannot know the room of an id it does not
      // hold); A dropped it against its own map.
      await waitFor(
        () => onTheWire.some((f) => f.topic === "voice.signal"),
        "the frame on the wire",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(victimOnA, "offer")).toHaveLength(0);
    });

    it("the mesh ceiling counts the seats on both machines", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      for (let i = 0; i < 4; i += 1) {
        await join(a, randomUUID(), channel);
        await join(b, randomUUID(), channel);
      }
      await settle();
      const rec = recorder();
      const ninth = randomUUID();
      b.sockets.setAuthenticatedSocket(rec.socket, asUser(ninth));
      await b.voice.handleVoiceMessage(
        { socket: rec.socket, user: asUser(ninth) },
        { type: "join-voice-room", voiceChannelId: channel, resume: true },
      );
      expect(frames(rec, "welcome")).toHaveLength(0);
      expect(frames(rec, "voice-room-full")[0]).toMatchObject({
        voiceChannelId: channel,
        limit: 8,
      });
    });

    it("the operator counters say what crossed", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      // Alone, nothing is counted: a hint published with nobody to receive
      // it is still a frame relayed, so only the receipt is checked here.
      const onA = await join(a, randomUUID(), channel);
      expect((await b.voice.getVoiceActivitySnapshot()).cluster.framesReceived).toBe(0);

      const onB = await join(b, randomUUID(), channel);
      await waitFor(() => frames(onA, "peer-joined").length === 1, "B's join on A");
      await signal(b, onB, { type: "offer", to: onA.peerId, sdp: "v=0" });
      await waitFor(() => frames(onA, "offer").length === 1, "the offer on A");

      const fromB = (await b.voice.getVoiceActivitySnapshot()).cluster;
      const onAside = (await a.voice.getVoiceActivitySnapshot()).cluster;
      // B published its join hint and the offer; A applied both to sockets it holds.
      expect(fromB.framesRelayed).toBeGreaterThanOrEqual(2);
      expect(onAside.framesReceived).toBeGreaterThanOrEqual(2);
      // And the other way: A's join hint reached nobody on B (B had no peer
      // in the room yet), so B's receipts are only what arrived since.
      expect(onAside.framesRelayed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("moderator mutes across instances", () => {
    interface MutedRoster {
      participants: { peerId: string; muted: boolean; serverMuted: boolean }[];
    }
    function rosterOn(rec: Recorder, channel: string): MutedRoster | undefined {
      return lastRoster(rec, channel) as unknown as MutedRoster | undefined;
    }

    it("a mute on A of a person seated on B lands on B's seat, every roster, and B refuses the unmute", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnA = watcher(a);
      const bystanderOnA = await join(a, randomUUID(), channel);
      const target = randomUUID();
      const targetOnB = await join(b, target, channel);
      await waitFor(
        () => rosterOn(sidebarOnA, channel)?.participants.length === 2,
        "both on A's roster",
      );
      await settle();

      await a.voice.setVoiceUserServerMuted(channel, target, true);

      await waitFor(
        () => b.voice.getVoicePeer(targetOnB.peerId)?.muted === true,
        "B's seat to be muted",
      );
      expect(b.voice.isVoiceUserServerMuted(channel, target)).toBe(true);
      await waitFor(
        () =>
          rosterOn(sidebarOnA, channel)?.participants.find(
            (p) => p.peerId === targetOnB.peerId,
          )?.serverMuted === true,
        "the flag on A's roster",
      );
      await waitFor(
        () =>
          rosterOn(bystanderOnA, channel)?.participants.find(
            (p) => p.peerId === targetOnB.peerId,
          )?.muted === true,
        "the forced mute on A's room roster",
      );
      // The row is the cluster's copy.
      const rows = await pools[0]!.getPool().query(
        `SELECT 1 FROM voice_server_mutes WHERE channel_id = $1 AND user_id = $2`,
        [channel, target],
      );
      expect(rows.rowCount).toBe(1);

      // B enforces it: the target's own unmute is refused where the socket is.
      await b.voice.handleVoiceMessage(
        { socket: targetOnB.socket, user: asUser(target) },
        { type: "set-voice-state", muted: false, deafened: false },
      );
      expect(b.voice.getVoicePeer(targetOnB.peerId)?.muted).toBe(true);

      // Cleared on A, the target may unmute on B.
      await a.voice.setVoiceUserServerMuted(channel, target, false);
      await waitFor(
        () => !b.voice.isVoiceUserServerMuted(channel, target),
        "B to forget the mute",
      );
      await b.voice.handleVoiceMessage(
        { socket: targetOnB.socket, user: asUser(target) },
        { type: "set-voice-state", muted: false, deafened: false },
      );
      expect(b.voice.getVoicePeer(targetOnB.peerId)?.muted).toBe(false);
    });

    it("the mute outlives the seat and the process: a resume and a rejoin elsewhere come back muted", async () => {
      backend.configured = "livekit";
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      await a.registry.heartbeatVoiceInstance();
      await b.registry.heartbeatVoiceInstance();
      await join(a, randomUUID(), channel);
      const target = randomUUID();
      const seat = await join(b, target, channel);
      await settle();
      await a.voice.setVoiceUserServerMuted(channel, target, true);
      await waitFor(() => b.voice.isVoiceUserServerMuted(channel, target), "on B");

      // The seat moves to A by resume: still muted, still flagged.
      const again = await resume(a, target, channel, seat.peerId, seat.resumeToken);
      const welcome = frames(again, "welcome")[0] as unknown as
        | { resumed?: boolean; self: { muted: boolean; serverMuted: boolean } }
        | undefined;
      expect(welcome?.resumed).toBe(true);
      expect(welcome?.self).toMatchObject({ muted: true, serverMuted: true });
      expect(a.voice.isVoiceUserServerMuted(channel, target)).toBe(true);

      // Hang up and come back through a process that never saw the mute.
      a.voice.removeVoicePeerBySocket(again.socket);
      await a.voice.leaveVoiceByResumeToken(seat.peerId, seat.resumeToken);
      await settle();
      const c = await bootInstance();
      await c.registry.heartbeatVoiceInstance();
      const fresh = await join(c, target, channel);
      const freshWelcome = frames(fresh, "welcome")[0] as unknown as
        | { self: { muted: boolean; serverMuted: boolean } }
        | undefined;
      expect(freshWelcome?.self).toMatchObject({ muted: true, serverMuted: true });
      await c.voice.handleVoiceMessage(
        { socket: fresh.socket, user: asUser(target) },
        { type: "set-voice-state", muted: false, deafened: false },
      );
      expect(c.voice.getVoicePeer(fresh.peerId)?.muted).toBe(true);
    });

    it("an emptied room forgets the mute everywhere", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const target = randomUUID();
      const seat = await join(b, target, channel);
      await settle();
      await a.voice.setVoiceUserServerMuted(channel, target, true);
      await waitFor(() => b.voice.isVoiceUserServerMuted(channel, target), "on B");

      b.voice.removeVoicePeerBySocket(seat.socket);
      await b.voice.leaveVoiceByResumeToken(seat.peerId, seat.resumeToken);
      await settle();
      const rows = await pools[0]!.getPool().query(
        `SELECT 1 FROM voice_server_mutes WHERE channel_id = $1`,
        [channel],
      );
      expect(rows.rowCount).toBe(0);
      const back = await join(a, target, channel);
      const welcome = frames(back, "welcome")[0] as unknown as
        | { self: { muted: boolean; serverMuted: boolean } }
        | undefined;
      expect(welcome?.self).toMatchObject({ muted: false, serverMuted: false });
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
      // M3's paths are as off as the rest: the reconcile touches nothing,
      // a resume for A's seat on B is a cold join, the beacon on B knows
      // nothing of A's seat, and no frame of any of it goes out.
      expect(await b.voice.runVoiceReconcile()).toEqual({
        orphaned: 0,
        removed: 0,
        roomsSwept: 0,
      });
      const again = await resume(b, "x", channel, peerA.peerId, peerA.resumeToken);
      expect(frames(again, "welcome")[0]?.peerId).not.toBe(peerA.peerId);
      expect(frames(again, "welcome")[0]?.resumed).toBeUndefined();
      await expect(
        b.voice.leaveVoiceByResumeToken(peerA.peerId, peerA.resumeToken),
      ).resolves.toBe(false);
      expect(a.voice.getVoicePeer(peerA.peerId)).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onTheWire.filter((f) => f.topic.startsWith("voice."))).toEqual([]);
    });
  });
});
