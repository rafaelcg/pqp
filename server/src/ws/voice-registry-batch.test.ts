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
import type { VoiceParticipant } from "@pqp/shared";
import type { VoicePeerWrite } from "../voice/registry.js";

/**
 * THE VOICE HANDLER WITH `VOICE_REGISTRY_BATCH` ON, AGAINST A REAL POSTGRES.
 *
 * `voice/registry-batch.test.ts` proves the coalescer itself: the statement
 * count, the ordering rules, the failure path. This file proves the two
 * things that are only true if `ws/voice.ts` is wired to it correctly.
 *
 *  1. THE PITFALL-13 GUARD REACHES THE FLUSH. Batching opens a window
 *     between a row write being asked for and the statement going out, and a
 *     seat can leave inside it. `writePeerRow` hands the registry a
 *     `stillSeated` closure over its own map so the check can be re-asked at
 *     the moment the row is written; if that closure ever stops being wired,
 *     the immortal-seat bug of 2026-09-08 comes back and nothing else would
 *     notice. So the closure is asserted directly, before and after a leave.
 *
 *  2. THE WIRE DOES NOT MOVE. The same sequence of events produces the same
 *     roster frames with the flag on and with it off, byte for byte once the
 *     random ids are normalised. Batching is a change to when rows are
 *     written, and a client must not be able to tell.
 *
 * Skips without a database, like the other registry suites.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const backend = vi.hoisted(() => ({ configured: "livekit" as "mesh" | "livekit" }));

/** The last `VoicePeerWrite` the handler asked the registry to write, per peer. */
const seen = vi.hoisted(() => ({ writes: new Map<string, unknown>() }));

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
  resolveRingableConversation: async () => null,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    has: () => true,
    userIds: [],
  }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 500 }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
}));

/**
 * The real registry, with one seam: every peer write is recorded on its way
 * through, so the test can hold the exact object the handler built and ask
 * its `stillSeated` closure whatever it likes, later.
 */
vi.mock("../voice/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/registry.js")>();
  return {
    ...actual,
    upsertVoicePeer: (peer: VoicePeerWrite) => {
      seen.writes.set(peer.peerId, peer);
      return actual.upsertVoicePeer(peer);
    },
  };
});

const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);

const { getPool, initDb, closePool } = await import("../db.js");
const {
  forgetSentRoster,
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sendAllVoiceRosters,
} = await import("./voice.js");
const { settleVoiceRegistryWrites } = await import("../voice/registry.js");
const { resetVoiceRegistryBatch } = await import("../voice/registry-batch.js");
const {
  SOCKET_CAPS,
  setAuthenticatedSocket,
  deleteAuthenticatedSocket,
} = await import("./sockets.js");

interface Frame {
  type: string;
  [key: string]: unknown;
}

class Client {
  readonly socket: WebSocket;
  readonly user: DbUser;
  readonly frames: Frame[] = [];

  constructor(
    readonly channelId: string,
    delta: boolean,
  ) {
    this.user = {
      id: randomUUID(),
      display_name: "Seat",
      avatar_url: null,
    } as unknown as DbUser;
    this.socket = {
      readyState: 1,
      send: (payload: string) => {
        this.frames.push(JSON.parse(payload) as Frame);
      },
      on: () => {},
    } as unknown as WebSocket;
    setAuthenticatedSocket(
      this.socket,
      this.user,
      delta ? [SOCKET_CAPS.voiceRosterDelta] : [],
    );
  }

  peerId(): string {
    return this.frames.find((f) => f.type === "welcome")?.peerId as string;
  }

  rosterFrames(): Frame[] {
    return this.frames.filter(
      (f) =>
        (f.type === "voice-roster" || f.type === "voice-roster-delta") &&
        f.voiceChannelId === this.channelId,
    );
  }
}

const open: Client[] = [];

function client(channelId: string, delta = true): Client {
  const c = new Client(channelId, delta);
  open.push(c);
  return c;
}

async function join(c: Client): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    {
      type: "join-voice-room",
      voiceChannelId: c.channelId,
      transports: ["mesh", "livekit"],
    },
  );
}

async function setMuted(c: Client, muted: boolean): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "set-voice-state", muted, deafened: false },
  );
}

async function leave(c: Client): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "leave-voice-room" },
  );
}

/**
 * Every uuid replaced by `id-1`, `id-2`, … in order of first appearance, so
 * two runs of the same script compare as text. Nothing else is touched: a
 * field that genuinely differs between the two paths still shows up.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalise(frames: Frame[]): string {
  const ids = new Map<string, string>();
  return JSON.stringify(frames).replace(UUID, (match) => {
    let alias = ids.get(match);
    if (!alias) {
      alias = `id-${ids.size + 1}`;
      ids.set(match, alias);
    }
    return alias;
  });
}

/** One scripted call, start to finish, on a fresh channel. */
async function runScript(): Promise<string> {
  const channel = randomUUID();
  const observer = client(channel);
  const a = client(channel);
  const b = client(channel);
  await join(a);
  await join(b);
  await setMuted(a, true);
  await setMuted(a, false);
  await leave(b);
  await leave(a);
  await settleVoiceRegistryWrites();
  return normalise(observer.rosterFrames());
}

const previousRegistry = process.env.VOICE_REGISTRY;
const previousBatch = process.env.VOICE_REGISTRY_BATCH;
const previousBatchMs = process.env.VOICE_REGISTRY_BATCH_MS;

describeDb("the voice handler with the registry write coalescer", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
    process.env.VOICE_REGISTRY = previousRegistry;
    process.env.VOICE_REGISTRY_BATCH = previousBatch;
    process.env.VOICE_REGISTRY_BATCH_MS = previousBatchMs;
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    delete process.env.VOICE_REGISTRY_BATCH;
    // A window of zero is still a window: the flush is a macrotask later, so
    // everything a tick enqueues shares it. It keeps the suite quick without
    // pretending the write is synchronous.
    process.env.VOICE_REGISTRY_BATCH_MS = "0";
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const c of open.splice(0)) {
      deleteAuthenticatedSocket(c.socket);
    }
    seen.writes.clear();
    resetVoiceRegistryBatch();
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    backend.configured = "livekit";
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    resetVoiceRegistryBatch();
    resetVoicePeers();
    vi.restoreAllMocks();
  });

  /**
   * The wiring pitfall 13 depends on. `writePeerRow` refuses a stale write
   * when it issues one; with batching the write is issued a window later, so
   * the registry has to be able to ask the same question again. It can only
   * do that through the closure the handler passes, and this is the assertion
   * that the closure exists and tells the truth on both sides of a leave.
   */
  it("hands the registry a seat check that goes false when the peer leaves", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const channel = randomUUID();
    const a = client(channel);
    await join(a);
    await settleVoiceRegistryWrites();

    const write = seen.writes.get(a.peerId()) as VoicePeerWrite | undefined;
    expect(write).toBeDefined();
    expect(write?.stillSeated).toBeTypeOf("function");
    expect(write?.stillSeated?.()).toBe(true);

    await leave(a);
    await settleVoiceRegistryWrites();
    // The same object the handler built, asked again: the seat is gone, so a
    // flush holding this write would drop it instead of writing the row back.
    expect(write?.stillSeated?.()).toBe(false);

    const rows = await getPool().query(
      `SELECT 1 FROM voice_peers WHERE peer_id = $1`,
      [a.peerId()],
    );
    expect(rows.rowCount).toBe(0);
  });

  /** The rows are the same at the end of the same call, batched or not. */
  it("ends a call with the same rows either way", async () => {
    for (const batch of ["off", "on"]) {
      process.env.VOICE_REGISTRY_BATCH = batch;
      resetVoiceRegistryBatch();
      resetVoicePeers();
      forgetSentRoster("");
      const channel = randomUUID();
      const a = client(channel);
      const b = client(channel);
      await join(a);
      await join(b);
      await settleVoiceRegistryWrites();
      const seated = await getPool().query(
        `SELECT COUNT(*)::text AS n FROM voice_peers WHERE channel_id = $1`,
        [channel],
      );
      expect(Number(seated.rows[0]?.n)).toBe(2);

      await leave(a);
      await leave(b);
      await settleVoiceRegistryWrites();
      const empty = await getPool().query(
        `SELECT COUNT(*)::text AS n FROM voice_peers WHERE channel_id = $1`,
        [channel],
      );
      expect(Number(empty.rows[0]?.n)).toBe(0);
      const room = await getPool().query(
        `SELECT 1 FROM voice_rooms WHERE channel_id = $1`,
        [channel],
      );
      expect(room.rowCount).toBe(0);
    }
  });

  /**
   * THE WIRE DOES NOT MOVE. Same script, same frames, once the random ids are
   * normalised away. If batching ever changed the ORDER a roster is built in,
   * or let a read run ahead of the write it reports, the two strings would
   * differ and this is the only place that would say so.
   */
  it("sends byte-identical roster frames with the flag on and off", async () => {
    process.env.VOICE_REGISTRY_BATCH = "off";
    const unbatched = await runScript();

    process.env.VOICE_REGISTRY_BATCH = "on";
    resetVoiceRegistryBatch();
    resetVoicePeers();
    resetVoiceRoomTransports();
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
    const batched = await runScript();

    expect(batched).toBe(unbatched);
    // And it was a real call, not two empty ones compared with each other.
    expect(unbatched).toContain("voice-roster-delta");
  });

  /** A resume still finds the id retired, even though the retire was batched. */
  it("retires a hung-up id through the batch", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const channel = randomUUID();
    const a = client(channel);
    await join(a);
    const peerId = a.peerId();
    await leave(a);
    await settleVoiceRegistryWrites();

    const retired = await getPool().query(
      `SELECT 1 FROM voice_retired_peers WHERE peer_id = $1`,
      [peerId],
    );
    expect(retired.rowCount).toBe(1);
  });

  /** A fresh socket's whole-cluster roster read is unaffected by batching. */
  it("serves a cold socket the rows the batch wrote", async () => {
    process.env.VOICE_REGISTRY_BATCH = "on";
    const channel = randomUUID();
    const a = client(channel);
    const b = client(channel);
    await join(a);
    await join(b);
    await settleVoiceRegistryWrites();

    const probe = client(channel, false);
    await sendAllVoiceRosters(probe.socket, probe.user);
    const roster = probe.frames
      .filter(
        (f) => f.type === "voice-roster" && f.voiceChannelId === channel,
      )
      .at(-1);
    const peers = (roster?.participants as VoiceParticipant[] | undefined) ?? [];
    expect(peers.map((p) => p.peerId).sort()).toEqual(
      [a.peerId(), b.peerId()].sort(),
    );
  });
});
