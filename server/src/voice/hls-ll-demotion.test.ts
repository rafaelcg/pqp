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

/**
 * THE FIRST REAL LL-HLS PARTY IN PRODUCTION, AND THE THREE THINGS IT BROKE.
 *
 * 2026-09-14, 21:50 UTC, two `pqp-api` machines with `VOICE_REGISTRY=postgres`
 * and `CLUSTER_BUS=postgres` — the flags production actually sets, which is
 * pitfall 12's whole lesson, so this file runs on a real Postgres with the
 * registry ON rather than on a fake.
 *
 *  (1) `pqp-remuxd` demoted the session fourteen seconds in and said so on
 *      `GET /sessions`. Nothing on this side was asking: the row stayed open
 *      with `mode = 'll'`, viewers kept the LL playlist, the conventional
 *      ladder never started, and the audience had no picture at all.
 *  (2) Two machines booted three seconds apart against one open LL row and
 *      both acted on it — one resumed the remux session, the other ended the
 *      row and stopped the session as an orphan.
 *  (3) The mode re-check only ever ran on the machine a viewer's frame
 *      happened to land on, which is not the machine holding the transcode.
 *
 * The control API is faked over HTTP (`setHlsRemuxTestHooks`), because what
 * is being pinned is what `pqp-api` DOES with the box's answer, not the
 * box's own watchdog, which has its own tests in Go.
 *
 * Case (3) lives in `server/src/ws/voice-hls-reconcile-relay.test.ts`: it
 * needs two whole module graphs over one bus, which is the socket layer's
 * harness rather than this one.
 *
 * Skips without a database, like every other suite here.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/log.js")>();
  return { ...actual, logEvent };
});

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  adoptLlHlsSessions,
  deriveLlSessionId,
  llDemotedRecently,
  llHasRoom,
  llHlsActivity,
  reconcileLlHlsNow,
  requestedHlsModeForChannel,
  resetHlsRemuxForTests,
  setHlsRemuxTestHooks,
  sweepLlDemotions,
} = await import("./hls-remux.js");
const { hlsOwnerInstanceId, resetHlsOwnershipForTests } = await import(
  "./hls-ownership.js"
);

const CONTROL_URL = "https://egress.example.test:8443";
const ORIGIN_URL = "https://hls-origin.example.test";
const SECRET = "test-remux-secret";

/** One session as `GET /sessions` reports it, demoted or not. */
interface FakeSession {
  sessionId: string;
  room: string;
  channelId: string;
  demoted?: boolean;
  demotedReason?: string | null;
  state?: string;
}

describeDb("LL-HLS demotion and row ownership across two machines", () => {
  /** What the fake box currently holds, keyed by its own session id. */
  let boxSessions: Map<string, FakeSession>;
  /** Every `DELETE /sessions/:id` the API sent, in order. */
  let stopped: string[];
  /** Every `POST /sessions` the API sent. */
  let started: string[];
  let channelA: string;
  let partyId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions, channel_sessions,
                voice_instances RESTART IDENTITY CASCADE`,
    );
    logEvent.mockClear();
    resetHlsRemuxForTests();
    resetHlsOwnershipForTests();
    process.env.VOICE_REGISTRY = "postgres";
    process.env.LIVE_HLS_LL = "true";
    process.env.LIVE_HLS_REMUX_CONTROL_URL = CONTROL_URL;
    process.env.LIVE_HLS_REMUX_CONTROL_SECRET = SECRET;
    process.env.LIVE_HLS_REMUX_ORIGIN_URL = ORIGIN_URL;

    boxSessions = new Map();
    stopped = [];
    started = [];
    setHlsRemuxTestHooks({ fetch: fakeControlApi });

    const user = await upsertUser({
      clerkId: "clerk_ll_demotion",
      displayName: "LL Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channels = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'party', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelA = channels.rows[0]!.id;
    const party = await getPool().query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, title, status, created_by, low_latency_requested)
       VALUES ($1, 'Sessao', 'live', $2, TRUE) RETURNING id`,
      [channelA, user.id],
    );
    partyId = party.rows[0]!.id;
  });

  afterEach(() => {
    resetHlsRemuxForTests();
    resetHlsOwnershipForTests();
    delete process.env.VOICE_REGISTRY;
    delete process.env.LIVE_HLS_LL;
    delete process.env.LIVE_HLS_REMUX_CONTROL_URL;
    delete process.env.LIVE_HLS_REMUX_CONTROL_SECRET;
    delete process.env.LIVE_HLS_REMUX_ORIGIN_URL;
  });

  /**
   * `pqp-remuxd`'s three routes, over the same `fetch` seam the real client
   * uses — signature and all, because the point is to exercise the client,
   * not to bypass it.
   */
  async function fakeControlApi(url: string, init: RequestInit): Promise<Response> {
    const path = url.slice(CONTROL_URL.length);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/sessions") {
      return new Response(
        JSON.stringify({
          sessions: [...boxSessions.values()].map((session) => ({
            sessionId: session.sessionId,
            room: session.room,
            channelId: session.channelId,
            subscribed: true,
            startedAtMs: 1_700_000_000_000,
            lastPartAtMs: null,
            lastIdrAtMs: null,
            openSegmentMs: null,
            partsWritten: 0,
            bytesServed: 0,
            state: session.state ?? (session.demoted ? "demoted" : "running"),
            demoted: session.demoted ?? false,
            demotedReason: session.demotedReason ?? null,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "POST" && path === "/sessions") {
      const body = JSON.parse(String(init.body)) as {
        sessionId: string;
        room: string;
        channelId: string;
      };
      started.push(body.sessionId);
      boxSessions.set(body.sessionId, {
        sessionId: body.sessionId,
        room: body.room,
        channelId: body.channelId,
      });
      return new Response(
        JSON.stringify({
          sessionId: body.sessionId,
          room: body.room,
          channelId: body.channelId,
          subscribed: true,
          startedAtMs: 1_700_000_000_000,
          lastPartAtMs: null,
          lastIdrAtMs: null,
          openSegmentMs: null,
          partsWritten: 0,
          bytesServed: 0,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "DELETE" && path.startsWith("/sessions/")) {
      const id = path.slice("/sessions/".length);
      stopped.push(id);
      boxSessions.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  /** A heartbeat row for another machine, as fresh (or as stale) as asked. */
  async function heartbeat(instanceId: string, secondsAgo: number): Promise<void> {
    await getPool().query(
      `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at)
       VALUES ($1, 'test', NOW() - ($2 || ' seconds')::interval)
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, secondsAgo],
    );
  }

  /** An open LL row for `channelA`, exactly as `startLlSession` writes one. */
  async function makeLlRow(options: {
    startedAt: number;
    instanceId: string | null;
    presenterPeerId?: string | null;
  }): Promise<{ id: string; remuxSessionId: string }> {
    const remuxSessionId = deriveLlSessionId(channelA, options.startedAt);
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, mode, remux_session_id,
          presenter_peer_id, part_target_ms, origin_base_url, instance_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 'll', $4, $5, 500, $6, $7)
       RETURNING id`,
      [
        channelA,
        `live/${channelA}/${options.startedAt}-ll`,
        options.startedAt,
        remuxSessionId,
        options.presenterPeerId === undefined ? "peer-1" : options.presenterPeerId,
        ORIGIN_URL,
        options.instanceId,
      ],
    );
    return { id: row.rows[0]!.id, remuxSessionId };
  }

  async function rowById(id: string): Promise<{
    ended_at: Date | null;
    instance_id: string | null;
    stopping_at: Date | null;
  }> {
    const result = await getPool().query<{
      ended_at: Date | null;
      instance_id: string | null;
      stopping_at: Date | null;
    }>(
      `SELECT ended_at, instance_id, stopping_at FROM hls_sessions WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

  // -------------------------------------------------------------------------
  // (1) The demotion contract
  // -------------------------------------------------------------------------

  it("(1a) ends the LL row, counts the demotion and asks for a reconcile when the box gives up", async () => {
    const stream = await reconcileLlHlsNow(channelA, "peer-1");
    expect(stream?.mode).toBe("ll");
    expect(llHasRoom(channelA)).toBe(true);
    const sessionId = started[0]!;

    // The box's watchdog gives up: pipeline closed, session still listed with
    // its reason, exactly as `tools/pqp-remux/README.md` promises.
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "idr-gap-exceeded",
      state: "demoted",
    });

    const fellBack = await sweepLlDemotions();

    // The channel is handed back for the conventional ladder to be started
    // (the monitor tick turns this into a `notifyChanged`, which is a
    // `pushLiveHls`, which reconciles the rungs).
    expect(fellBack).toEqual([channelA]);
    // The counter that sat at zero through the incident it was invented for.
    expect(llHlsActivity().demoted).toBe(1);
    expect(llHlsActivity().sessions).toBe(0);
    expect(llHasRoom(channelA)).toBe(false);
    // With the box's own word for it, never one invented here.
    expect(logEvent).toHaveBeenCalledWith("voice.hlsLlDemoted", {
      channelId: channelA,
      reason: "idr-gap-exceeded",
    });
    // The session is stopped on the box and the row is closed, so retention
    // collects it and no viewer is handed an LL playlist nothing writes.
    expect(stopped).toEqual([sessionId]);
    const rows = await getPool().query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM hls_sessions WHERE channel_id = $1 AND mode = 'll'`,
      [channelA],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.ended_at).not.toBeNull();
  });

  it("(1a-bis) treats a session the box no longer holds the same way, healing the in-memory map", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    // The remux process restarted, or somebody DELETEd it: `llRooms` is now
    // the only thing that believes this session exists. That is the state
    // machine B was left in by the 2026-09-14 boot race.
    boxSessions.delete(sessionId);

    const fellBack = await sweepLlDemotions();

    expect(fellBack).toEqual([channelA]);
    expect(llHasRoom(channelA)).toBe(false);
    expect(llHlsActivity().sessions).toBe(0);
    expect(logEvent).toHaveBeenCalledWith("voice.hlsLlDemoted", {
      channelId: channelA,
      reason: "session-gone",
    });
  });

  it("(1a-fail-closed) changes nothing when the control API cannot be asked", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    setHlsRemuxTestHooks({
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    const fellBack = await sweepLlDemotions();

    // Demoting a healthy party because one HTTP request timed out is a
    // rebuffer for every viewer. The next tick is ten seconds away.
    expect(fellBack).toEqual([]);
    expect(llHasRoom(channelA)).toBe(true);
    expect(llHlsActivity().demoted).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlHealthPollFailed",
      expect.objectContaining({ sessions: 1 }),
    );
  });

  it("(1b) does not re-select LL for the same party after a demotion", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    expect(await requestedHlsModeForChannel(channelA)).toBe(true);

    await sweepLlDemotions();

    // The durable half: every reconcile on EVERY machine now resolves
    // `conventional` for the rest of this party.
    expect(await requestedHlsModeForChannel(channelA)).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRequestCleared",
      expect.objectContaining({ channelId: channelA, reason: "demoted:part-stuck" }),
    );
    // And the memo, which holds on this machine even before that write is
    // read back — the window the fallback used to loop through.
    expect(llDemotedRecently(channelA)).toBe(true);
    // Five minutes on, the same window the box's own watchdog uses, a fresh
    // episode is allowed again.
    expect(llDemotedRecently(channelA, Date.now() + 6 * 60_000)).toBe(false);

    // The next "Ir ao vivo" for this channel writes the column again, which
    // is what makes a demotion last the party and not a minute longer.
    await getPool().query(
      `UPDATE channel_sessions SET low_latency_requested = TRUE WHERE id = $1`,
      [partyId],
    );
    expect(await requestedHlsModeForChannel(channelA)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (2) Who owns an LL row
  // -------------------------------------------------------------------------

  it("(2a) lets exactly one of two booting machines claim an expired LL row", async () => {
    // The pre-restart process, long gone: its heartbeat is well past the 45 s
    // TTL, so the row looks free to both machines coming up.
    const deadOwner = randomUUID();
    await heartbeat(deadOwner, 300);
    const startedAt = Date.now() - 30_000;
    const { id, remuxSessionId } = await makeLlRow({
      startedAt,
      instanceId: deadOwner,
    });
    boxSessions.set(remuxSessionId, {
      sessionId: remuxSessionId,
      room: channelA,
      channelId: channelA,
    });

    // MACHINE B, which in the incident got there first.
    const machineB = randomUUID();
    await heartbeat(machineB, 0);
    const claimed = await getPool().query(
      `UPDATE hls_sessions SET instance_id = $2 WHERE id = $1`,
      [id, machineB],
    );
    expect(claimed.rowCount).toBe(1);

    // MACHINE A boots three seconds later and runs its own LL boot sweep.
    const result = await adoptLlHlsSessions();

    // It neither adopts the session B is driving nor stops it as an orphan,
    // and the row still names B. Before this, A ended the row (its owner
    // looked expired) and DELETEd the session B had just resumed.
    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 0 });
    expect(llHasRoom(channelA)).toBe(false);
    expect(stopped).toEqual([]);
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    expect(row.instance_id).toBe(machineB);
    // And the guard says so out loud rather than being invisible (pitfall 12).
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSkippedOwnedElsewhere",
      expect.objectContaining({ site: "ll-boot", ownerInstanceId: machineB }),
    );
  });

  it("(2a-bis) adopts and re-stamps a row whose owner really is gone", async () => {
    const deadOwner = randomUUID();
    await heartbeat(deadOwner, 300);
    const startedAt = Date.now() - 30_000;
    const { id, remuxSessionId } = await makeLlRow({
      startedAt,
      instanceId: deadOwner,
    });
    boxSessions.set(remuxSessionId, {
      sessionId: remuxSessionId,
      room: channelA,
      channelId: channelA,
    });

    const result = await adoptLlHlsSessions();

    // Nobody alive is driving it, so this machine takes it AND says so on the
    // row: the next machine to boot must not read a dead instance's id.
    expect(result?.adopted).toBe(1);
    expect(llHasRoom(channelA)).toBe(true);
    expect(stopped).toEqual([]);
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    expect(row.instance_id).toBe(hlsOwnerInstanceId());
  });

  it("(2b) never stops a remux session whose row a live instance owns", async () => {
    const machineB = randomUUID();
    await heartbeat(machineB, 1);
    const startedAt = Date.now() - 10_000;
    const { id, remuxSessionId } = await makeLlRow({
      startedAt,
      instanceId: machineB,
    });
    boxSessions.set(remuxSessionId, {
      sessionId: remuxSessionId,
      room: channelA,
      channelId: channelA,
    });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 0 });
    expect(stopped).toEqual([]);
    expect(boxSessions.has(remuxSessionId)).toBe(true);
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    expect(row.instance_id).toBe(machineB);
  });

  it("(2b-bis) leaves a row another machine wrote seconds ago alone, heartbeat or no heartbeat", async () => {
    // The window between `startLlSession`'s INSERT and its POST: a healthy
    // start with a row and no remote session yet, on a machine whose own
    // heartbeat has not been written either (both are booting).
    const machineB = randomUUID();
    const { id } = await makeLlRow({
      startedAt: Date.now() - 2_000,
      instanceId: machineB,
    });

    const result = await adoptLlHlsSessions();

    expect(result?.ended).toBe(0);
    expect((await rowById(id)).ended_at).toBeNull();
  });

  it("(2b-ter) still ends an abandoned row once it is past the boot grace", async () => {
    const deadOwner = randomUUID();
    await heartbeat(deadOwner, 300);
    // Old enough that no start could still be in flight, and the box holds
    // nothing for it.
    const { id } = await makeLlRow({
      startedAt: Date.now() - 10 * 60_000,
      instanceId: deadOwner,
    });

    const result = await adoptLlHlsSessions();

    expect(result?.ended).toBe(1);
    expect((await rowById(id)).ended_at).not.toBeNull();
  });

  it("(2c) refuses to start on top of a row a live instance owns", async () => {
    const machineB = randomUUID();
    await heartbeat(machineB, 1);
    const { id } = await makeLlRow({
      startedAt: Date.now() - 10_000,
      instanceId: machineB,
      presenterPeerId: "peer-2",
    });

    // A different presenter: the old rule would have torn B's row down to
    // make room for this one.
    const stream = await reconcileLlHlsNow(channelA, "peer-1");

    expect(stream).toBeNull();
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    expect(row.stopping_at).toBeNull();
    expect(row.instance_id).toBe(machineB);
    expect(logEvent).toHaveBeenCalledWith("voice.hlsLlStartFailed", {
      channelId: channelA,
      reason: "row-owned-elsewhere",
    });
  });

  it("(2c-bis) the conventional boot sweep does not touch LL rows at all", async () => {
    const { reconcileStaleHlsSessions } = await import("./hls-cleanup.js");
    const { setLiveHlsTestHooks, resetLiveHlsForTests } = await import(
      "./hls-egress.js"
    );
    // The media server lists nothing, which is always true of an LL row: it
    // has no LiveKit egress behind it. That is what used to end it.
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "unused" }),
        stopEgress: async () => {},
        listEgress: async () => [],
      },
    });
    const { id } = await makeLlRow({
      startedAt: Date.now() - 30_000,
      instanceId: hlsOwnerInstanceId(),
    });

    const result = await reconcileStaleHlsSessions();

    expect(result.ended).toBe(0);
    expect((await rowById(id)).ended_at).toBeNull();
    resetLiveHlsForTests();
  });
});
