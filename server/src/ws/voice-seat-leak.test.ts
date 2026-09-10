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
 * SEATS THAT OUTLIVE THE PERSON.
 *
 * On the night of 2026-09-08, ten of nineteen live voice rooms held exactly
 * one person each, `orphaned_at` NULL, the oldest for fifteen hours. One of
 * them belonged to somebody who had force-quit the app twenty minutes
 * earlier. The rows said the seats were live, the process agreed, and no
 * number anywhere said otherwise.
 *
 * The mechanism, proven from production: a peer row write that lands AFTER
 * the DELETE of the same peer re-INSERTs the row with `orphaned_at` NULL and
 * a LIVE `instance_id` on it. From there nothing can ever remove it. There is
 * no peer in the map, so no socket close, no orphan timer and no `removePeer`
 * will ever fire for it; and `reconcileVoiceRegistry` refuses by design to
 * touch a row owned by an instance that is answering its heartbeat. The seat
 * is immortal.
 *
 * Hard evidence, `peer_id b88cd6c6`: `voice.leave` logged at 21:56:41.568 and
 * `voice_retired_peers.retired_at` at 21:56:41.566, against a `voice_peers`
 * row whose `joined_at` is 21:56:41.574. The row was inserted eight
 * milliseconds after its own delete, carrying `muted: true` from the
 * `set-voice-state` frame the client sent just before it hung up.
 *
 * So this suite pins three things, in the order a seat actually dies:
 *   1. writes for one channel are ORDERED, so a late frame cannot overtake a
 *      hangup (`trackRowWrite` takes a thunk now, and that is why);
 *   2. a write for a peer the map no longer holds is REFUSED, so a handler
 *      that awaited something cannot resurrect a seat it no longer owns;
 *   3. whatever still gets through is SWEPT, because a guard is not a proof,
 *      and counted, because the whole reason this ran for months is that
 *      working and silently-not-working looked identical.
 *
 * Plus the chain that is supposed to release a seat when nobody says
 * goodbye: heartbeat misses, terminate, close, orphan, release.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

/**
 * The seam that lets a test stand in the middle of a handler's `await`. The
 * identity refresh reads the channel before it writes the row, which is
 * exactly the shape of every stale-write path: read the peer, await
 * something, write the peer.
 */
const servers = vi.hoisted(() => ({
  duringGetChannel: null as null | (() => Promise<void>),
}));

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
  getChannel: async () => {
    const hook = servers.duringGetChannel;
    if (hook) {
      servers.duringGetChannel = null;
      await hook();
    }
    return { kind: "server", type: "voice" };
  },
  getChannelAudience: async () => null,
  getServerVoiceProfile: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve()),
}));

// The resume token is an HMAC of the Clerk secret; without one no `welcome`
// carries a token and every resume in this file would silently cold-join.
process.env.CLERK_SECRET_KEY ??= "sk_test_voice_seat_leak";

const { getPool, initDb, closePool } = await import("../db.js");
const {
  getVoiceActivitySnapshot,
  handleVoiceMessage,
  refreshVoiceIdentity,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetSeatHealthLog,
  resetVoiceRoomTransports,
  runVoiceReconcile,
} = await import("./voice.js");
const {
  settleVoiceRegistryWrites,
  sweepOwnStaleVoicePeers,
  VOICE_OWN_ROW_GRACE_MS,
} = await import("../voice/registry.js");
const { MAX_MISSED_PONGS, startHeartbeat, trackSocketLiveness } = await import(
  "./index.js"
);
const { mintVoiceResumeToken, VOICE_RESUME_TTL_MS } = await import(
  "./voice-resume-token.js"
);
const { deleteAuthenticatedSocket, setAuthenticatedSocket, SOCKET_CAPS } =
  await import("./sockets.js");
const { INSTANCE_ID } = await import("../lib/bus.js");

interface Frame {
  type: string;
  [key: string]: unknown;
}

/**
 * A socket the heartbeat can actually kill. `ws` fires `close` after
 * `terminate()`, and `server/src/index.ts` hangs `removeVoicePeerBySocket` off
 * that event; both halves are here so a test can drive the real chain from a
 * missed pong all the way to a deleted row.
 */
class FakeSocket {
  readyState = 1;
  frames: Frame[] = [];
  pings = 0;
  terminated = 0;
  private closeHandlers: (() => void)[] = [];
  private pongHandlers: (() => void)[] = [];

  send(payload: string) {
    this.frames.push(JSON.parse(payload) as Frame);
  }

  on(event: string, handler: () => void) {
    if (event === "close") {
      this.closeHandlers.push(handler);
    }
    if (event === "pong") {
      this.pongHandlers.push(handler);
    }
  }

  ping() {
    this.pings += 1;
  }

  /** What a browser answers for free, at protocol level. */
  pong() {
    for (const handler of this.pongHandlers) {
      handler();
    }
  }

  terminate() {
    this.terminated += 1;
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  frame(type: string): Frame | undefined {
    return this.frames.find((f) => f.type === type);
  }
}

function asSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

async function join(
  socket: FakeSocket,
  userId: string,
  voiceChannelId: string,
  extra: { resumePeerId?: string; resumeToken?: string } = {},
): Promise<string> {
  await handleVoiceMessage(
    { socket: asSocket(socket), user: asUser(userId) },
    {
      type: "join-voice-room",
      voiceChannelId,
      resume: true,
      transports: ["mesh", "livekit"],
      ...(extra.resumePeerId ? { resumePeerId: extra.resumePeerId } : {}),
      ...(extra.resumeToken ? { resumeToken: extra.resumeToken } : {}),
    },
  );
  await settleRows();
  return socket.frame("welcome")?.peerId as string;
}

/**
 * `settleVoiceRegistryWrites` drains the writes that have STARTED. Now that
 * a channel's writes are chained, the next one starts a microtask after the
 * previous settles, so a single drain can return through a momentary gap.
 * Draining repeatedly with a tick between closes it.
 */
async function settleRows(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await settleVoiceRegistryWrites();
    // Microtasks only: this has to work under fake timers, and the gap it is
    // closing is a `.then` hop, not a delay.
    await Promise.resolve();
    await Promise.resolve();
  }
}

async function peerRow(peerId: string) {
  const result = await getPool().query(
    `SELECT peer_id, channel_id, muted, orphaned_at, joined_at
       FROM voice_peers WHERE peer_id = $1`,
    [peerId],
  );
  return result.rows[0] as
    | {
        peer_id: string;
        channel_id: string;
        muted: boolean;
        orphaned_at: Date | null;
        joined_at: Date;
      }
    | undefined;
}

/**
 * The seat is STILL THERE and marked orphaned.
 *
 * Deliberately not `expect(row?.orphaned_at).not.toBeNull()`, which is how the
 * first version of the LiveKit case below passed while proving nothing: when
 * the row has been deleted, `?.` yields `undefined`, `undefined` is not
 * `null`, and the assertion waves through the exact failure it was written to
 * catch. Assert the row exists, then assert the stamp.
 */
async function expectHeldAsOrphan(peerId: string) {
  const row = await peerRow(peerId);
  expect(row).toBeDefined();
  expect(row?.orphaned_at).toBeInstanceOf(Date);
}

/**
 * Bounded poll for a row to disappear. Used where the room has a write held
 * open on purpose, so the ordinary settle seams would wait on the very thing
 * the test is holding.
 */
async function waitForRowGone(peerId: string, timeoutMs = 4_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await peerRow(peerId))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function count(table: string, where = "TRUE", params: unknown[] = []) {
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * A row exactly as the leak leaves one: this instance's id on it, no peer
 * behind it, `orphaned_at` NULL, older than the grace. Written straight to
 * the table because no code path is supposed to be able to produce it any
 * more, which is the point of the sweep.
 */
async function plantGhost(options: {
  channelId?: string;
  instanceId?: string;
  userId?: string;
  ageMs?: number;
  orphaned?: boolean;
} = {}): Promise<{ peerId: string; channelId: string; userId: string }> {
  const peerId = randomUUID();
  const channelId = options.channelId ?? randomUUID();
  const userId = options.userId ?? randomUUID();
  const ageMs = options.ageMs ?? VOICE_OWN_ROW_GRACE_MS * 2;
  await getPool().query(
    `INSERT INTO voice_rooms (channel_id, transport)
     VALUES ($1, 'mesh') ON CONFLICT (channel_id) DO NOTHING`,
    [channelId],
  );
  await getPool().query(
    `INSERT INTO voice_peers
       (peer_id, channel_id, user_id, instance_id, display_name,
        can_resume, orphaned_at, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Ghost', TRUE,
             CASE WHEN $6::boolean
                  THEN NOW() - ($5::bigint * INTERVAL '1 millisecond')
                  ELSE NULL END,
             NOW() - ($5::bigint * INTERVAL '1 millisecond'),
             NOW() - ($5::bigint * INTERVAL '1 millisecond'))`,
    [
      peerId,
      channelId,
      userId,
      options.instanceId ?? INSTANCE_ID,
      ageMs,
      options.orphaned === true,
    ],
  );
  return { peerId, channelId, userId };
}

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("voice seats that outlive the person", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    backend.configured = "mesh";
    servers.duringGetChannel = null;
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    resetSeatHealthLog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await settleVoiceRegistryWrites();
    resetVoicePeers();
    servers.duringGetChannel = null;
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  describe("a write that lands after the hangup", () => {
    /**
     * THE PRODUCTION BUG, reproduced. The client mutes itself and hangs up in
     * the same breath; the mute's UPSERT is slow, the hangup's DELETE is not.
     * Before `trackRowWrite` took a thunk, both statements were already in
     * flight on two pooled connections and the database was free to run them
     * in the wrong order, which it did.
     */
    it("does not resurrect the row when the state write is slower than the delete", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, userId, channel);
      expect(await peerRow(peerId)).toBeDefined();

      // Make the peer UPSERT reach Postgres late. The delay is on the way IN,
      // so it delays execution, not just the promise: exactly what a busy
      // pool does to one statement and not another.
      const pool = getPool();
      const passThrough = pool.query.bind(pool) as (
        text: unknown,
        params?: unknown,
      ) => Promise<unknown>;
      vi.spyOn(pool, "query").mockImplementation((async (
        text: unknown,
        params?: unknown,
      ) => {
        if (
          typeof text === "string" &&
          text.includes("INSERT INTO voice_peers")
        ) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return passThrough(text, params);
      }) as never);

      const session = { socket: asSocket(socket), user: asUser(userId) };
      // Two frames off one socket with nothing awaited between them, which is
      // how `ws/index.ts` dispatches them: `void onMessage(...)`, no
      // per-socket serialisation.
      const state = handleVoiceMessage(session, {
        type: "set-voice-state",
        muted: true,
        deafened: false,
      });
      const hangup = handleVoiceMessage(session, { type: "leave-voice-room" });
      await Promise.all([state, hangup]);
      await settleRows();

      expect(await peerRow(peerId)).toBeUndefined();
      expect(await count("voice_peers")).toBe(0);
      expect(await count("voice_rooms")).toBe(0);
      // And the id is retired, so a resume for it cold-joins rather than
      // reconstructing itself back into the room.
      expect(await count("voice_retired_peers", "peer_id = $1", [peerId])).toBe(
        1,
      );
    });

    /**
     * And the fix must not become the bug. Ordering is per PEER: two people
     * in one room write different rows and never race, so one person's slow
     * statement must not stand in front of anybody else's, and above all not
     * in front of their hangup. A room-wide queue would leave a seat occupied
     * while its leave waited behind a backlog, which is this whole ticket.
     */
    it("lets one peer's leave land while another peer's write is still stuck", async () => {
      const channel = randomUUID();
      const slowUser = randomUUID();
      const quickUser = randomUUID();
      const slowSocket = new FakeSocket();
      const quickSocket = new FakeSocket();
      const slowPeer = await join(slowSocket, slowUser, channel);
      const quickPeer = await join(quickSocket, quickUser, channel);

      // Hold the slow peer's next UPSERT open until this test releases it.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pool = getPool();
      const passThrough = pool.query.bind(pool) as (
        text: unknown,
        params?: unknown,
      ) => Promise<unknown>;
      vi.spyOn(pool, "query").mockImplementation((async (
        text: unknown,
        params?: unknown,
      ) => {
        if (
          typeof text === "string" &&
          text.includes("INSERT INTO voice_peers") &&
          Array.isArray(params) &&
          params[0] === slowPeer
        ) {
          await held;
        }
        return passThrough(text, params);
      }) as never);

      // The slow peer mutes; its row write is now stuck in the pool.
      const stuck = handleVoiceMessage(
        { socket: asSocket(slowSocket), user: asUser(slowUser) },
        { type: "set-voice-state", muted: true, deafened: false },
      );
      // The other person hangs up while it is stuck. Deliberately NOT
      // `settleRows`: the room still has a write in flight on purpose, so
      // anything that drains the room would wait for the thing being held.
      // Polling the row is the honest question, "did the delete get out?".
      await handleVoiceMessage(
        { socket: asSocket(quickSocket), user: asUser(quickUser) },
        { type: "leave-voice-room" },
      );
      const gone = await waitForRowGone(quickPeer);

      release();
      await stuck;
      await settleRows();

      // Their seat went while the room was blocked; the slow write still lands.
      expect(gone).toBe(true);
      expect((await peerRow(slowPeer))?.muted).toBe(true);
    });

    /**
     * The room row has to go with the last seat even when the last two seats
     * leave together. `deleteVoicePeer` used to do both halves in one CTE, on
     * one snapshot, so two simultaneous last-leaves each saw the other still
     * seated and neither cleared the room. Harmless while a room's writes were
     * single-file; reachable the moment they stopped being.
     */
    it("clears the room row when the last two seats leave at once", async () => {
      const channel = randomUUID();
      const one = randomUUID();
      const two = randomUUID();
      const socketOne = new FakeSocket();
      const socketTwo = new FakeSocket();
      await join(socketOne, one, channel);
      await join(socketTwo, two, channel);
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(1);

      await Promise.all([
        handleVoiceMessage(
          { socket: asSocket(socketOne), user: asUser(one) },
          { type: "leave-voice-room" },
        ),
        handleVoiceMessage(
          { socket: asSocket(socketTwo), user: asUser(two) },
          { type: "leave-voice-room" },
        ),
      ]);
      await settleRows();

      expect(await count("voice_peers", "channel_id = $1", [channel])).toBe(0);
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(0);
    });
  });

  describe("a write from a seat that is already gone", () => {
    /**
     * The other way in, and the one a guard has to cover: a handler that read
     * the peer, awaited something, and came back to write a row for a seat
     * that was hung up while it waited. The identity refresh is the seam used
     * here because its await is a plain channel read, but every handler that
     * awaits has the same shape.
     */
    it("refuses the row write, and says so on the dashboard", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, userId, channel);

      const before = (await getVoiceActivitySnapshot()).seats;
      expect(before).not.toBeNull();

      // Hang up in the middle of the refresh's `await getChannel(...)`, which
      // is after it captured the peer and before it writes the row.
      servers.duringGetChannel = async () => {
        await handleVoiceMessage(
          { socket: asSocket(socket), user: asUser(userId) },
          { type: "leave-voice-room" },
        );
        await settleRows();
      };
      await refreshVoiceIdentity(userId, {
        display_name: "Renomeado",
        avatar_url: null,
      });
      await settleRows();

      expect(await peerRow(peerId)).toBeUndefined();
      expect(await count("voice_peers")).toBe(0);

      const after = (await getVoiceActivitySnapshot()).seats;
      expect(after?.staleRowWritesRefused).toBeGreaterThan(
        before?.staleRowWritesRefused ?? 0,
      );
    });
  });

  describe("the sweep for rows this instance owns and no longer holds", () => {
    it("deletes a ghost, retires its id and unpins its room", async () => {
      const ghost = await plantGhost();

      const swept = await sweepOwnStaleVoicePeers([]);

      expect(swept).toEqual([
        { peerId: ghost.peerId, channelId: ghost.channelId },
      ]);
      expect(await peerRow(ghost.peerId)).toBeUndefined();
      expect(
        await count("voice_retired_peers", "peer_id = $1", [ghost.peerId]),
      ).toBe(1);
      expect(
        await count("voice_rooms", "channel_id = $1", [ghost.channelId]),
      ).toBe(0);
    });

    it("never touches a seat this instance holds, a fresh row, or another instance's", async () => {
      const channel = randomUUID();
      const socket = new FakeSocket();
      const held = await join(socket, randomUUID(), channel);
      // Backdate the held seat past the grace: age alone must not condemn a
      // row, or every quiet call would be swept out of its own room.
      await getPool().query(
        `UPDATE voice_peers SET updated_at = NOW() - INTERVAL '1 day'
          WHERE peer_id = $1`,
        [held],
      );
      const fresh = await plantGhost({ ageMs: 0 });
      const foreign = await plantGhost({ instanceId: randomUUID() });

      const swept = await sweepOwnStaleVoicePeers([held]);

      expect(swept).toEqual([]);
      expect(await peerRow(held)).toBeDefined();
      expect(await peerRow(fresh.peerId)).toBeDefined();
      expect(await peerRow(foreign.peerId)).toBeDefined();
    });

    it("leaves the room row alone while somebody real is still in it", async () => {
      const channel = randomUUID();
      const socket = new FakeSocket();
      const held = await join(socket, randomUUID(), channel);
      const ghost = await plantGhost({ channelId: channel });

      await sweepOwnStaleVoicePeers([held]);

      expect(await peerRow(ghost.peerId)).toBeUndefined();
      expect(await peerRow(held)).toBeDefined();
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(1);
    });

    /**
     * THE REGRESSION THIS SWEEP COULD HAVE CAUSED, and the reason the query
     * says `orphaned_at IS NULL`.
     *
     * A closed socket's seat is deliberately held for `VOICE_RESUME_TTL_MS`
     * (90s) so a refresh mid-call keeps its place. The sweep's grace is 60s
     * on a 15s beat, so the two windows overlap: a sweep that only asked
     * "is this row old and unheld?" would delete and retire a resumable seat
     * somewhere between sixty and ninety seconds in, and the person coming
     * back would find their place gone. That is the behaviour this codebase
     * has worked hardest to protect, and it must not be the price of the fix.
     */
    it("leaves an orphan inside its resume window alone, and it is still resumable", async () => {
      const channel = randomUUID();
      const orphan = await plantGhost({
        channelId: channel,
        ageMs: 75_000,
        orphaned: true,
      });
      expect(75_000).toBeGreaterThan(VOICE_OWN_ROW_GRACE_MS);
      expect(75_000).toBeLessThan(VOICE_RESUME_TTL_MS);

      // Both the direct sweep and the beat that runs it in production.
      expect(await sweepOwnStaleVoicePeers([])).toEqual([]);
      expect((await runVoiceReconcile()).ghosts).toBe(0);

      expect(await peerRow(orphan.peerId)).toBeDefined();
      expect(
        await count("voice_retired_peers", "peer_id = $1", [orphan.peerId]),
      ).toBe(0);

      // And the seat still does what it is held for: the person comes back.
      const token = mintVoiceResumeToken({
        userId: orphan.userId,
        peerId: orphan.peerId,
        voiceChannelId: channel,
        transport: "mesh",
      });
      const back = new FakeSocket();
      const resumed = await join(back, orphan.userId, channel, {
        resumePeerId: orphan.peerId,
        resumeToken: token as string,
      });

      expect(resumed).toBe(orphan.peerId);
      expect(back.frame("welcome")).toMatchObject({ resumed: true });
      expect((await peerRow(orphan.peerId))?.orphaned_at).toBeNull();
    });

    it("runs on the reconcile beat and counts what it found", async () => {
      const ghost = await plantGhost();
      const before = (await getVoiceActivitySnapshot()).seats;

      const result = await runVoiceReconcile();

      expect(result.ghosts).toBe(1);
      expect(await peerRow(ghost.peerId)).toBeUndefined();
      const after = (await getVoiceActivitySnapshot()).seats;
      expect(after?.ghostsSwept).toBe((before?.ghostsSwept ?? 0) + 1);
    });

    it("counts a seat nobody has written to in an hour", async () => {
      await plantGhost({ ageMs: 3 * 60 * 60_000 });

      const seats = (await getVoiceActivitySnapshot()).seats;

      expect(seats?.idleOverAnHour).toBe(1);
      expect(seats?.oldestIdleMinutes).toBeGreaterThanOrEqual(170);
    });

    /**
     * THE NUMBERS HAVE TO BE IN THE LOGS, not only on a pull endpoint.
     *
     * `GET /api/admin/metrics` is polled by the dashboard and written down
     * nowhere, so until this line existed nothing in Loki carried these
     * counters and no panel or alert could be built on them. The decision
     * they exist for, when to set `VOICE_MESH_RESUME_REQUIRES_CAP`, is a
     * ratio watched over days as browsers cycle onto a new bundle, which is
     * not something you read off an instantaneous dashboard.
     */
    it("writes the seat numbers to the logs on the reconcile beat", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      await plantGhost({ ageMs: 3 * 60 * 60_000 });

      await runVoiceReconcile();

      const line = lines.find((text) => text.includes("voice.seats"));
      expect(line).toBeDefined();
      expect(line).toContain("idleOverAnHour=");
      expect(line).toContain("meshResumeSockets=");
      expect(line).toContain("sockets=");
      expect(line).toContain("ghostsSwept=");
      expect(line).toContain("requiresCap=");
    });

    it("writes it once an hour, not on every beat", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });

      await runVoiceReconcile();
      await runVoiceReconcile();
      await runVoiceReconcile();

      expect(lines.filter((t) => t.includes("voice.seats"))).toHaveLength(1);
    });

    it("reports no seat numbers at all with the registry off", async () => {
      delete process.env.VOICE_REGISTRY;

      expect((await getVoiceActivitySnapshot()).seats).toBeNull();
    });
  });

  describe("the socket that never says goodbye", () => {
    /**
     * The whole chain, on the path a force-quit phone actually takes: no
     * close frame, no `leave-voice-room`, nothing but silence. The heartbeat
     * has to notice, terminate, and let the close handler do the rest.
     */
    it("terminates the socket, orphans the seat, and releases it on schedule", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, userId, channel);
      socket.on("close", () => removeVoicePeerBySocket(asSocket(socket)));

      // Fake timers stay on from here to the end of the test: the orphan
      // timer is created by the close handler that the reaper triggers, so
      // swapping the clock back mid-way would throw away the very timer this
      // is about to wait for.
      vi.useFakeTimers();
      trackSocketLiveness(asSocket(socket));
      const stop = startHeartbeat([asSocket(socket)], 30_000);

      // The first tick is the ping nobody answers; each one after is a strike.
      await vi.advanceTimersByTimeAsync(30_000);
      for (let strike = 0; strike < MAX_MISSED_PONGS - 1; strike += 1) {
        expect(socket.terminated).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(socket.terminated).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(socket.terminated).toBe(1);
      stop();
      await settleRows();

      // The seat is held, not gone: a refresh mid-call still gets its 90s.
      await expectHeldAsOrphan(peerId);

      await vi.advanceTimersByTimeAsync(VOICE_RESUME_TTL_MS + 1_000);
      await settleRows();

      expect(await peerRow(peerId)).toBeUndefined();
      expect(await count("voice_peers")).toBe(0);
      expect(await count("voice_rooms")).toBe(0);
    });

    it("never reaps a socket that keeps answering", async () => {
      const channel = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, randomUUID(), channel);
      socket.on("close", () => removeVoicePeerBySocket(asSocket(socket)));

      vi.useFakeTimers();
      trackSocketLiveness(asSocket(socket));
      const stop = startHeartbeat([asSocket(socket)], 30_000);
      for (let tick = 0; tick < MAX_MISSED_PONGS * 4; tick += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        socket.pong();
      }
      stop();
      vi.useRealTimers();
      await settleRows();

      expect(socket.terminated).toBe(0);
      expect((await peerRow(peerId))?.orphaned_at).toBeNull();
    });
  });

  /**
   * A HOLD NOBODY CAN REDEEM IS A GHOST IN SOMEBODY ELSE'S CALL.
   *
   * `join-voice-room.resume` says "I can hold media across a signalling
   * drop", and its own schema says phones omit it. On 2026-09-08 an iOS build
   * sent it for every room, having asked `GET /api/voice/backend` what a NEW
   * room on this deployment would be pinned to instead of what THIS room is.
   * Production runs LiveKit, so it said yes to mesh rooms as well, and that
   * build cannot keep the promise on mesh: it tears the peer connections down
   * and cold rejoins with a new id. Every conversation call is mesh by
   * policy, so every DM call from an iPhone left a phantom for ninety
   * seconds. #411 fixes the client; this is the half that also reaches the
   * builds already on people's phones.
   */
  describe("holding a mesh seat for a client that cannot redeem it", () => {
    const previousFlag = process.env.VOICE_MESH_RESUME_REQUIRES_CAP;

    afterEach(() => {
      if (previousFlag === undefined) {
        delete process.env.VOICE_MESH_RESUME_REQUIRES_CAP;
      } else {
        process.env.VOICE_MESH_RESUME_REQUIRES_CAP = previousFlag;
      }
    });

    /** Register the socket the way `handleWsConnection` does, with caps. */
    function authenticate(socket: FakeSocket, userId: string, caps: string[]) {
      setAuthenticatedSocket(asSocket(socket), asUser(userId), caps);
    }

    it("holds nothing for a phone in a mesh room once the rule is on", async () => {
      process.env.VOICE_MESH_RESUME_REQUIRES_CAP = "true";
      const channel = randomUUID();
      const userId = randomUUID();
      const phone = new FakeSocket();
      authenticate(phone, userId, ["voice-roster-delta"]);
      const peerId = await join(phone, userId, channel);
      expect(await peerRow(peerId)).toBeDefined();

      // The phone drops. It declared `resume`, but it never declared that it
      // can rebuild mesh media, so the seat goes now rather than in 90s.
      removeVoicePeerBySocket(asSocket(phone));
      await settleRows();

      expect(await peerRow(peerId)).toBeUndefined();
      expect(await count("voice_peers", "channel_id = $1", [channel])).toBe(0);
      expect(await count("voice_rooms", "channel_id = $1", [channel])).toBe(0);
      deleteAuthenticatedSocket(asSocket(phone));
    });

    it("still holds the seat for a browser, which is what the window is for", async () => {
      process.env.VOICE_MESH_RESUME_REQUIRES_CAP = "true";
      const channel = randomUUID();
      const userId = randomUUID();
      const tab = new FakeSocket();
      authenticate(tab, userId, [
        "voice-roster-delta",
        SOCKET_CAPS.meshResume,
      ]);
      const peerId = await join(tab, userId, channel);
      const resumeToken = tab.frame("welcome")?.resumeToken as string;

      removeVoicePeerBySocket(asSocket(tab));
      await settleRows();

      // Held, and redeemable: pitfall 11's behaviour, untouched.
      await expectHeldAsOrphan(peerId);
      const back = new FakeSocket();
      const resumed = await join(back, userId, channel, {
        resumePeerId: peerId,
        resumeToken,
      });
      expect(resumed).toBe(peerId);
      expect(back.frame("welcome")).toMatchObject({ peerId, resumed: true });
      deleteAuthenticatedSocket(asSocket(tab));
    });

    it("leaves a LiveKit room alone, where the promise is keepable", async () => {
      process.env.VOICE_MESH_RESUME_REQUIRES_CAP = "true";
      backend.configured = "livekit";
      const channel = randomUUID();
      const userId = randomUUID();
      const phone = new FakeSocket();
      authenticate(phone, userId, ["voice-roster-delta"]);
      const peerId = await join(phone, userId, channel);
      expect(peerId).toBeDefined();

      removeVoicePeerBySocket(asSocket(phone));
      await settleRows();

      // iOS keeps a LiveKit call across an API restart today and must keep on
      // doing so: that media is a separate connection and is still up.
      await expectHeldAsOrphan(peerId);
      deleteAuthenticatedSocket(asSocket(phone));
    });

    it("changes nothing at all while the flag is off, which is how it ships", async () => {
      delete process.env.VOICE_MESH_RESUME_REQUIRES_CAP;
      const channel = randomUUID();
      const userId = randomUUID();
      const phone = new FakeSocket();
      authenticate(phone, userId, ["voice-roster-delta"]);
      const peerId = await join(phone, userId, channel);

      removeVoicePeerBySocket(asSocket(phone));
      await settleRows();

      await expectHeldAsOrphan(peerId);
      deleteAuthenticatedSocket(asSocket(phone));
    });

    it("counts the refusals, so the flip can be read rather than assumed", async () => {
      process.env.VOICE_MESH_RESUME_REQUIRES_CAP = "true";
      const before = (await getVoiceActivitySnapshot()).seats;
      const channel = randomUUID();
      const userId = randomUUID();
      const phone = new FakeSocket();
      authenticate(phone, userId, ["voice-roster-delta"]);
      await join(phone, userId, channel);
      removeVoicePeerBySocket(asSocket(phone));
      await settleRows();

      const after = (await getVoiceActivitySnapshot()).seats;
      expect(after?.meshHoldsRefused).toBe((before?.meshHoldsRefused ?? 0) + 1);
      deleteAuthenticatedSocket(asSocket(phone));
    });
  });

  describe("resume against the grace period", () => {
    it("keeps the seat when the client comes back inside the window", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, userId, channel);
      const resumeToken = socket.frame("welcome")?.resumeToken as string;

      removeVoicePeerBySocket(asSocket(socket));
      await settleRows();
      await expectHeldAsOrphan(peerId);

      const back = new FakeSocket();
      const resumed = await join(back, userId, channel, {
        resumePeerId: peerId,
        resumeToken,
      });

      expect(resumed).toBe(peerId);
      expect(back.frame("welcome")).toMatchObject({ peerId, resumed: true });
      expect((await peerRow(peerId))?.orphaned_at).toBeNull();
      expect(await count("voice_peers")).toBe(1);
    });

    it("does not resurrect a seat that was already released", async () => {
      const channel = randomUUID();
      const userId = randomUUID();
      const socket = new FakeSocket();
      const peerId = await join(socket, userId, channel);
      const resumeToken = socket.frame("welcome")?.resumeToken as string;

      // Before the orphan, not after: the 90s release is a `setTimeout` the
      // close handler creates, and a clock swapped in later never sees it.
      vi.useFakeTimers();
      removeVoicePeerBySocket(asSocket(socket));
      await settleRows();
      await vi.advanceTimersByTimeAsync(VOICE_RESUME_TTL_MS + 1_000);
      await settleRows();
      expect(await peerRow(peerId)).toBeUndefined();
      // The seat is released, so the clock has done its job. Back to the real
      // one for the rejoin, which is ordinary handler work over a real pool.
      vi.useRealTimers();

      // The token is good for hours; the seat is not. A late resume has to
      // cold-join into a new id, never rebuild the retired one.
      const back = new FakeSocket();
      const rejoined = await join(back, userId, channel, {
        resumePeerId: peerId,
        resumeToken,
      });

      expect(rejoined).not.toBe(peerId);
      // `resumed` is omitted rather than false on a cold join, which is the
      // wire contract: absent means "this is a new seat".
      expect(back.frame("welcome")?.resumed).toBeUndefined();
      expect(await peerRow(peerId)).toBeUndefined();
      expect(await count("voice_peers")).toBe(1);
    });
  });
});
