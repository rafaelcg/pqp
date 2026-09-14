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
import { createMemoryHub, type BusFrame } from "../lib/bus.js";

/**
 * THE IDLE HANGUP ACROSS TWO MACHINES.
 *
 * Same harness as `voice-cluster.test.ts`: two module graphs over one memory
 * hub (so `peers`, `idleAloneSweepRunning` and every other module-scoped
 * variable in `ws/voice.ts` are genuinely separate processes), both pointed
 * at one real Postgres via `TEST_DATABASE_URL` — exactly two `pqp-api`
 * machines sharing one database, `VOICE_REGISTRY=postgres` on.
 *
 * What this pins, against the five properties the multi-instance rebase of
 * #493 had to make true before two machines go live:
 *
 *  (a) each instance's sweep is a correct read against the registry, so
 *      running it unmodified on every instance is safe — never a "one
 *      instance must own this" singleton;
 *  (b) a sweep never disconnects a peer whose socket lives on the OTHER
 *      instance: a lone local peer next to a second occupant seated on the
 *      other machine is left alone entirely, and when the hangup does fire
 *      it reaches only the socket that is actually alone;
 *  (e) an orphaned seat (mid-resume) still counts as company for a
 *      neighbour's occupancy check, cluster-wide.
 *
 * (c) and (d) are covered by `voice-idle-alone.test.ts`, which does not
 * need two processes to prove.
 *
 * Skips without a database, like `voice-registry.test.ts` and
 * `voice-cluster.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh",
  isLiveKitConfigured: () => false,
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
  resolveRingableConversation: async () => null,
}));

/** "voice" for every channel unless the TOCTOU test below marks one a `watch_party`. */
const channelTypes = vi.hoisted(() => ({ byId: new Map<string, string>() }));

vi.mock("../services/servers.js", () => ({
  getChannel: async (channelId: string) => ({
    kind: "server",
    type: channelTypes.byId.get(channelId) ?? "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
}));

/**
 * `pending`, when set, is what every instance's `listActiveWatchPartyStatusesByChannel`
 * awaits instead of answering — the TOCTOU test below stalls it on purpose
 * to open a window between instance A's occupancy snapshot and its actual
 * disconnect decision, wide enough to let instance B's own join land in it.
 */
const watchPartyStatus = vi.hoisted(() => ({
  pending: null as Promise<Map<string, string>> | null,
}));

vi.mock("../services/watch-parties.js", () => ({
  listActiveWatchPartyStatusesByChannel: async () =>
    watchPartyStatus.pending ?? new Map<string, string>(),
  loadWatchPartySeat: async () => null,
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

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const registry = (await import("../voice/registry.js")) as RegistryModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, voice, sockets, registry, db };
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

function warnings(rec: Recorder): Frame[] {
  return frames(rec, "voice-idle-warning");
}

function hangups(rec: Recorder): Frame[] {
  return rec.frames.filter(
    (f) => f.type === "voice-moderation" && f.action === "disconnected",
  );
}

async function join(
  instance: Instance,
  userId: string,
  channel: string,
): Promise<Recorder> {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  if (!frames(rec, "welcome")[0]) {
    throw new Error(`join was refused: ${JSON.stringify(rec.frames)}`);
  }
  return rec;
}

async function settle(): Promise<void> {
  for (const instance of booted) {
    await instance.registry.settleVoiceRegistryWrites();
  }
}

const MINUTE = 60_000;
const previousFlag = process.env.VOICE_REGISTRY;
const previousLimit = process.env.VOICE_IDLE_ALONE_MINUTES;

describeDb("the idle hangup across two instances", () => {
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
    delete process.env.VOICE_IDLE_ALONE_MINUTES; // default 10 minutes
    hub = createMemoryHub();
    onTheWire = [];
    hub.listeners.add((frame) => onTheWire.push(frame));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = pools[0]!;
    await db
      .getPool()
      .query(
        `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
      );
  });

  afterEach(async () => {
    await settle();
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    if (previousLimit === undefined) {
      delete process.env.VOICE_IDLE_ALONE_MINUTES;
    } else {
      process.env.VOICE_IDLE_ALONE_MINUTES = previousLimit;
    }
    channelTypes.byId.clear();
    watchPartyStatus.pending = null;
    vi.restoreAllMocks();
  });

  it("(a)+(b): a lone local peer next to a same-room occupant on the OTHER instance is never disconnected", async () => {
    const channel = randomUUID();
    const T0 = Date.now();

    const a = await bootInstance();
    const b = await bootInstance();

    const alice = await join(a, randomUUID(), channel);
    const bob = await join(b, randomUUID(), channel);
    await settle();

    // Both instances see only ONE local occupant in this room, and both
    // must consult the registry to learn the truth: two people, cluster-
    // wide, so neither seat is alone.
    await a.voice.sweepIdleAloneSeats(T0);
    await b.voice.sweepIdleAloneSeats(T0);
    await a.voice.sweepIdleAloneSeats(T0 + 9 * MINUTE);
    await b.voice.sweepIdleAloneSeats(T0 + 9 * MINUTE);
    await a.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await b.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await a.voice.sweepIdleAloneSeats(T0 + 60 * MINUTE);
    await b.voice.sweepIdleAloneSeats(T0 + 60 * MINUTE);

    expect(warnings(alice)).toHaveLength(0);
    expect(warnings(bob)).toHaveLength(0);
    expect(hangups(alice)).toHaveLength(0);
    expect(hangups(bob)).toHaveLength(0);
  });

  it("(b): once the other instance's occupant leaves, only the instance actually holding the lone seat disconnects it", async () => {
    const channel = randomUUID();
    const T0 = Date.now();

    const a = await bootInstance();
    const b = await bootInstance();

    const aliceId = randomUUID();
    const alice = await join(a, aliceId, channel);
    const bobId = randomUUID();
    const bob = await join(b, bobId, channel);
    await settle();

    // Not alone yet: B's occupant is still seated.
    await a.voice.sweepIdleAloneSeats(T0);
    expect(warnings(alice)).toHaveLength(0);
    expect(hangups(alice)).toHaveLength(0);

    // Bob leaves via his OWN instance, B.
    await b.voice.handleVoiceMessage(
      { socket: bob.socket, user: asUser(bobId) },
      { type: "leave-voice-room" },
    );
    await settle();

    // Now A's sweep sees Alice genuinely alone, cluster-wide, and warns and
    // disconnects HER socket — A owns it. B has nobody left in this room to
    // sweep at all, so its own sweep is a no-op regardless of how many
    // times it runs.
    await a.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE); // clock starts
    await b.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE);
    await a.voice.sweepIdleAloneSeats(T0 + 19 * MINUTE);
    expect(warnings(alice)).toHaveLength(1);

    await a.voice.sweepIdleAloneSeats(T0 + 20 * MINUTE);
    expect(hangups(alice)).toHaveLength(1);
    // B never ran the disconnect: A's sweep issued it locally on A's own
    // socket, which is what `disconnectVoiceUser` does for the peer it
    // holds directly. B produced nothing about this room at all — it has
    // held no peer in it since Bob left.
  });

  it("(e): an orphaned (mid-resume) seat on one instance still counts as company for a peer on the other", async () => {
    const channel = randomUUID();
    const T0 = Date.now();

    const a = await bootInstance();
    const b = await bootInstance();

    const aliceId = randomUUID();
    const alice = await join(a, aliceId, channel);
    const bobId = randomUUID();
    const bob = await join(b, bobId, channel);
    await settle();

    // Bob's socket drops without an intentional leave: on the mesh path his
    // seat on B goes into the resume-window orphan state rather than
    // disappearing outright (pitfall 11 — a resume window is already a
    // timer, so the idle-alone sweep must not race it).
    b.voice.removeVoicePeerBySocket(bob.socket);
    await settle();

    // Alice's own instance must still see Bob's orphaned seat as an
    // occupant of the room (via the registry row, which an orphan keeps
    // until the resume window or the reconcile clears it) and must not
    // start her alone-clock while he might still come back.
    await a.voice.sweepIdleAloneSeats(T0);
    await a.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE);
    expect(warnings(alice)).toHaveLength(0);
    expect(hangups(alice)).toHaveLength(0);
  });

  /**
   * Farol's reliability finding on the first version of this fix: the
   * sweep computed occupancy ONCE per tick and used that cached number all
   * the way through to the actual `disconnectVoiceUser` call, with real
   * awaits (a watch-party read, here stalled on purpose) in between. On a
   * cluster, a join can land on the OTHER instance in exactly that window,
   * and the stale snapshot has no way to see it. `isStillAloneRightNow` is
   * the fix: a fresh, un-cached re-check immediately before the seat is
   * actually cut.
   *
   * The window here is real, not simulated: alice's occupancy snapshot on A
   * is taken while she is genuinely alone; Bob's join on B, and the
   * registry write it produces, both happen strictly AFTER that snapshot
   * and strictly BEFORE A's disconnect decision, because the stalled
   * watch-party read is what is holding A's sweep open across the exact
   * middle of that window.
   */
  it("(b) TOCTOU: a join on the OTHER instance during the sweep's own tick is honored, not the stale snapshot", async () => {
    const channel = randomUUID();
    const T0 = Date.now();
    channelTypes.byId.set(channel, "watch_party");

    const a = await bootInstance();
    const b = await bootInstance();

    const aliceId = randomUUID();
    const alice = await join(a, aliceId, channel);
    await settle();

    await a.voice.sweepIdleAloneSeats(T0); // alice's clock starts, genuinely alone

    let release: (() => void) | undefined;
    watchPartyStatus.pending = new Promise<Map<string, string>>((resolve) => {
      release = () => resolve(new Map()); // not live: the exemption does not apply
    });

    // Not awaited yet: this suspends inside `computeLiveWatchPartyRooms`,
    // which runs once for the whole tick, BEFORE any room's disconnect
    // decision — including alice's, whose elapsed time already exceeds the
    // limit at this timestamp.
    const sweep = a.voice.sweepIdleAloneSeats(T0 + 10 * MINUTE);

    // Bob joins the SAME room on instance B, and his row settles, entirely
    // inside A's suspended sweep.
    const bobId = randomUUID();
    const bob = await join(b, bobId, channel);
    await settle();

    release?.();
    await sweep;

    // The snapshot A's tick started with said "alone"; the fresh re-check
    // immediately before the cut saw Bob's row and refused it.
    expect(hangups(alice)).toHaveLength(0);
    expect(hangups(bob)).toHaveLength(0);
  });
});
