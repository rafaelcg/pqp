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
import { LIVE_HLS_MODE_LL, LIVE_HLS_MODE_PARAM } from "@pqp/shared";

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
  pendingLlDemotionCount,
  setRequestedHlsMode,
  llDemotedRecently,
  llDemotionPendingAttribution,
  llMemoSizesForTests,
  noteLlDemotion,
  llHasRoom,
  llHlsActivity,
  llStreamFor,
  reconcileLlHlsNow,
  liveHlsRequestForChannel,
  resolveHlsModeForChannel,
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
  /** What the box reports for this session's `partsWritten` (default 0). */
  partsWritten?: number;
}

describeDb("LL-HLS demotion and row ownership across two machines", () => {
  /** What the fake box currently holds, keyed by its own session id. */
  let boxSessions: Map<string, FakeSession>;
  /** Every `DELETE /sessions/:id` the API sent and the box accepted, in order. */
  let stopped: string[];
  /** Every `DELETE` attempt, accepted or not: what a backoff is measured in. */
  let stopAttempts: number;
  /** When true the box answers 500 to a stop, the way an unhappy one does. */
  let refuseStops: boolean;
  /** Every `POST /sessions` the API sent. */
  let started: string[];
  let channelA: string;
  let serverId: string;
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
    stopAttempts = 0;
    refuseStops = false;
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
    serverId = server.rows[0]!.id;
    const channels = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'party', 'voice', 0) RETURNING id`,
      [serverId],
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
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
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
            partsWritten: session.partsWritten ?? 0,
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
      stopAttempts += 1;
      if (refuseStops) {
        return new Response(JSON.stringify({ error: "busy" }), { status: 500 });
      }
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

  /**
   * The host ends the party and starts another one on the same channel --
   * the real sequence, because only one party may be live per channel at a
   * time. A NEW `channel_sessions` row is the whole point: its id is what
   * the demotion memo is keyed against, and a new party has never been in
   * it.
   */
  async function startNewerParty(
    options: { lowLatency?: boolean } = {},
  ): Promise<string> {
    const owner = await getPool().query<{ id: string }>(
      `SELECT created_by AS id FROM channel_sessions WHERE id = $1`,
      [partyId],
    );
    await getPool().query(
      `UPDATE channel_sessions SET status = 'ended' WHERE id = $1`,
      [partyId],
    );
    const newer = await getPool().query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, title, status, created_by, low_latency_requested)
       VALUES ($1, 'Outra', 'live', $2, $3) RETURNING id`,
      [channelA, owner.rows[0]!.id, options.lowLatency ?? true],
    );
    return newer.rows[0]!.id;
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

  it("(1a-ter) what the AUDIENCE is handed changes: an LL-marked master, then nothing from this driver", async () => {
    // The demotion contract's LAST mile, and the one that was still missing
    // on 2026-09-15. Ending the row and clearing the request is bookkeeping;
    // what a viewer's player does depends entirely on the frame reaching
    // them. So: while the session is live the URL it is handed IS an LL
    // master (`?mode=ll` — the edge Worker serves the LL playlist because
    // the request says so), it states its part target, and once the box has
    // given up this driver hands out nothing at all, which is what lets
    // `hls-egress.ts` start the conventional ladder and `pushLiveHls`
    // publish a frame whose `mode` has changed (`liveHlsFrameChanged`).
    const stream = await reconcileLlHlsNow(channelA, "peer-1");
    expect(stream?.mode).toBe("ll");
    expect(stream?.partTargetMs).toBeGreaterThan(0);
    const url = new URL(`https://api.example.test${stream!.hlsUrl}`);
    expect(url.searchParams.get(LIVE_HLS_MODE_PARAM)).toBe(LIVE_HLS_MODE_LL);
    expect(llStreamFor(channelA)?.hlsUrl).toBe(stream!.hlsUrl);

    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    await sweepLlDemotions();

    expect(llStreamFor(channelA)).toBeNull();
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

  it("(1a-readiness) demotes a session that never produces a part once the readiness window passes -- the backstop for the box's own no-video watchdog failing to fire (production d5559e70, 2026-09-16)", async () => {
    // The box reports the session present, subscribed, NOT demoted -- but
    // partsWritten stays 0 forever (the fake box's default), which is exactly
    // the production failure: an LL session that hangs before it ever attaches
    // to the presenter's track sits at zero parts for the whole party while
    // the box never flags it and the sweep leaves it alone every tick.
    await reconcileLlHlsNow(channelA, "peer-1");
    expect(llHasRoom(channelA)).toBe(true);

    const t0 = Date.now();
    // First observation: nothing demoted, the window has not passed.
    expect(await sweepLlDemotions(t0)).toEqual([]);
    expect(llHasRoom(channelA)).toBe(true);
    // Still zero parts a little past the readiness window (default 75s): the
    // backstop fires where the box's FirstPartTimeoutMs did not.
    const fellBack = await sweepLlDemotions(t0 + 76_000);
    expect(fellBack).toEqual([channelA]);
    expect(llHasRoom(channelA)).toBe(false);
    expect(logEvent).toHaveBeenCalledWith("voice.hlsLlDemoted", {
      channelId: channelA,
      reason: "no-video-timeout",
    });
  });

  it("(1a-readiness-safe) never demotes a session that HAS produced video, however long it then runs -- a source that went quiet is the box's sourceIdle case, not this backstop's", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    // This session produced parts, then (say) went quiet: partsWritten > 0,
    // lastPart old. The readiness backstop must never touch it.
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      partsWritten: 3,
    });

    const t0 = Date.now();
    expect(await sweepLlDemotions(t0)).toEqual([]);
    expect(await sweepLlDemotions(t0 + 10 * 60_000)).toEqual([]);
    expect(llHasRoom(channelA)).toBe(true);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsLlDemoted",
      expect.objectContaining({ reason: "no-video-timeout" }),
    );
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
    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({ requested: true });

    await sweepLlDemotions();

    // The durable half: every reconcile on EVERY machine now resolves
    // `conventional` for the rest of this party.
    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({ requested: false });
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRequestCleared",
      expect.objectContaining({ channelId: channelA, reason: "demoted:part-stuck" }),
    );
    // And the memo, which holds on this machine even before that write is
    // read back — the window the fallback used to loop through. Keyed by the
    // party, never the channel: it is a verdict about THIS party.
    expect(llDemotedRecently(partyId)).toBe(true);
    // Five minutes on, the same window the box's own watchdog uses, a fresh
    // episode is allowed again.
    expect(llDemotedRecently(partyId, Date.now() + 6 * 60_000)).toBe(false);

    // THE BELT, ON ITS OWN. Put the column back the way a write that lost a
    // race (or never landed) would leave it: this party still resolves
    // `conventional`, because the machine that demoted it remembers which
    // party it was.
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    await getPool().query(
      `UPDATE channel_sessions SET low_latency_requested = TRUE WHERE id = $1`,
      [partyId],
    );
    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({ requested: true });
    expect(await resolveHlsModeForChannel(channelA, serverId)).toMatchObject({
      mode: "conventional",
      requested: true,
      partySessionId: partyId,
      partyDemoted: true,
    });
  });

  it("(1b-bis) does not suppress a NEW party that asks for LL on the same channel", async () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "no-video",
    });
    await sweepLlDemotions();
    expect(llDemotedRecently(partyId)).toBe(true);

    // The host ends the party and starts another one, asking for LL again.
    // The memo is a verdict about a session that no longer exists, and
    // holding the new party to it for the rest of five minutes would be a
    // silent downgrade nobody could explain.
    const newerId = await startNewerParty();

    expect(llDemotedRecently(newerId)).toBe(false);
    expect(await resolveHlsModeForChannel(channelA, serverId)).toMatchObject({
      mode: "ll",
      requested: true,
      partySessionId: newerId,
      partyDemoted: false,
    });
  });

  /**
   * THE 2026-09-15 PRODUCTION FAILURE, on the two machines that produced it.
   *
   * Channel `d5559e70`: instance A demoted the LL session at 15:23:14 and
   * remembered it. At 15:26:52 the host created a NEW party with the switch
   * on; that HTTP request landed on instance B, which wrote
   * `low_latency_requested = true`. The share at 15:27:01 reconciled on A,
   * whose memo was keyed by CHANNEL and still set, so the API silently
   * started the conventional ladder for a party whose row said `true` -- no
   * `hlsLl*` line anywhere, and nothing saying why.
   *
   * "Instance B" here is the database write itself, because that is the
   * entirety of what B does: `setRequestedHlsMode` on the new party's row,
   * from a process that shares nothing in memory with A. The resolve then
   * runs on A, the machine holding the demotion.
   */
  it("(1b-ter) lets a party created on ANOTHER machine have LL after a demotion here", async () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    await sweepLlDemotions();
    expect(llDemotedRecently(partyId)).toBe(true);

    // Instance B: a new party row, then the goLive handler's own write.
    const newerId = await startNewerParty({ lowLatency: false });
    await setRequestedHlsMode(newerId, true);

    // Instance A, where the demotion lives, reconciles the share.
    const resolved = await resolveHlsModeForChannel(channelA, serverId, {
      sharing: true,
    });

    expect(resolved).toMatchObject({
      mode: "ll",
      requested: true,
      partySessionId: newerId,
      partyDemoted: false,
    });
    // And the demoted party is still demoted on this machine: scoping the
    // memo must not amount to dropping it.
    expect(llDemotedRecently(partyId)).toBe(true);
  });

  it("(1b-quater) says why on every mode decision, once per decision", async () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    await sweepLlDemotions();
    // The durable clear has already landed, so put the column back the way a
    // write that lost a race would leave it: the interesting line is the one
    // about a party that IS still asking and is refused anyway.
    await getPool().query(
      `UPDATE channel_sessions SET low_latency_requested = TRUE WHERE id = $1`,
      [partyId],
    );
    logEvent.mockClear();

    await resolveHlsModeForChannel(channelA, serverId, { sharing: true });

    // A conventional ladder starting for a party that ASKED for LL was the
    // silent part of the failure: one line, with each input that could have
    // said no (pitfall 16).
    expect(logEvent).toHaveBeenCalledWith("voice.hlsModeResolved", {
      channelId: channelA,
      partySessionId: partyId,
      requested: true,
      partyDemoted: true,
      demotionUnattributed: false,
      llAvailable: true,
      mode: "conventional",
      sharing: true,
    });

    // `reconcileLiveHlsNow` runs on every roster event; an unchanged
    // decision must not be a line every time.
    logEvent.mockClear();
    await resolveHlsModeForChannel(channelA, serverId, { sharing: true });
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsModeResolved",
      expect.anything(),
    );

    // A decision that CHANGES is said out loud straight away.
    const newerId = await startNewerParty();
    await resolveHlsModeForChannel(channelA, serverId, { sharing: true });
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsModeResolved",
      expect.objectContaining({ partySessionId: newerId, mode: "ll" }),
    );
  });

  /**
   * THE GAP A PARTY-KEYED MEMO OPENS, AND WHAT CLOSES IT.
   *
   * `hls_sessions.watch_party_session_id` is NULL for two reasons a row
   * cannot tell apart, so a demotion can be queued with no party to key the
   * memo by. Keyed by channel that never mattered; keyed by party it leaves
   * the window between the demotion and the attribution completely open, and
   * a reconcile in there starts LL straight back into the session the box
   * has just given up on (a Farol finding on this PR).
   */
  it("(1b-quinquies) holds LL off while a demotion has not yet learned whose party it was", async () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    await getPool().query(
      `UPDATE hls_sessions SET watch_party_session_id = NULL
        WHERE channel_id = $1 AND mode = 'll'`,
      [channelA],
    );
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "no-video",
    });
    // ONLY the attribution lookup fails -- the demotion itself is queued
    // exactly as it would be, and the queue backs off and tries again on the
    // next tick. Everything else still talks to the real database.
    const pool = getPool();
    const realQuery = pool.query.bind(pool) as typeof pool.query;
    const failing = vi
      .spyOn(pool, "query")
      .mockImplementation(((sql: string, params?: unknown[]) =>
        typeof sql === "string" && sql.includes("created_at <= to_timestamp")
          ? Promise.reject(new Error("connection terminated"))
          : realQuery(sql, params as never)) as typeof pool.query);
    await sweepLlDemotions();
    failing.mockRestore();

    expect(pendingLlDemotionCount()).toBe(1);
    // The party still says it wants LL, and nobody has memoed it, because
    // nobody knows yet that it is the one.
    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({
      requested: true,
      partySessionId: partyId,
    });
    expect(llDemotedRecently(partyId)).toBe(false);
    // And it is still refused, because a demotion on this channel could be
    // about this party and nothing has ruled that out.
    expect(await resolveHlsModeForChannel(channelA, serverId)).toMatchObject({
      mode: "conventional",
      requested: true,
      partyDemoted: false,
      demotionUnattributed: true,
    });

    // AND IT DOES NOT LAPSE WHILE THE DEMOTION IS STILL BEING RETRIED. The
    // first version expired this with the five-minute memo window while the
    // queue entry lives for half an hour, so a prolonged attribution failure
    // -- the very thing that produces an unattributed demotion -- reopened
    // the window at the five minute mark (a Farol finding on this PR).
    expect(pendingLlDemotionCount()).toBe(1);
    expect(
      llDemotionPendingAttribution(channelA, Date.now() - 60 * 60_000),
    ).toBe(true);

    // A party created AFTER the demoted session started could not be the one
    // it belonged to, so the same outstanding demotion does not touch it.
    const newerId = await startNewerParty();
    expect(await resolveHlsModeForChannel(channelA, serverId)).toMatchObject({
      mode: "ll",
      partySessionId: newerId,
      demotionUnattributed: false,
    });
  });

  /**
   * Both memos expire on a clock, so something that is not a write to them
   * has to sweep them -- including on a deployment with `LIVE_HLS_LL` on and
   * no remux control URL, which resolves modes (filling `lastModeResolved`)
   * and never demotes anything (a Farol finding on this PR).
   */
  it("(1b-sexies) sweeps both expiring memos on the tick, control URL or not", async () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    noteLlDemotion(partyId);
    await resolveHlsModeForChannel(channelA, serverId, { sharing: true });
    expect(llMemoSizesForTests()).toMatchObject({
      demotedParties: 1,
      modeDecisions: 1,
    });

    // A deployment with the flag on and no remux control URL resolves modes
    // -- filling the log memo -- and demotes nothing, so it returns below
    // without ever reaching a sweep placed after that check.
    delete process.env.LIVE_HLS_REMUX_CONTROL_URL;
    expect(await sweepLlDemotions(Date.now() + 6 * 60_000)).toEqual([]);

    // GONE, not merely ignored. Every other seam reads an expired entry and
    // an absent one the same way; the difference is a map that grows with
    // every party this process has ever demoted.
    expect(llMemoSizesForTests()).toMatchObject({
      demotedParties: 0,
      modeDecisions: 0,
    });
  });

  /**
   * THE WRITE PATH NEVER WALKS THE MAP, AT ANY SIZE.
   *
   * A threshold-triggered sweep on the write is the same quadratic shape one
   * threshold further out: once the map is large, every demotion pays for
   * every entry, and demotions arrive in bursts (a Farol finding on this
   * PR). `entriesScanned` counts what any full sweep has walked, so "the
   * write path does not scan" is an assertion rather than a claim.
   */
  it("(1b-septies) remembers a thousand demotions without ever scanning the map", async () => {
    for (let i = 0; i < 1000; i += 1) {
      noteLlDemotion(`party-${i}`);
    }

    const sizes = llMemoSizesForTests();
    expect(sizes.entriesScanned).toBe(0);
    expect(sizes.demotedParties).toBe(1000);
    expect(llDemotedRecently("party-0")).toBe(true);
    expect(llDemotedRecently("party-999")).toBe(true);
  });

  /**
   * A CAP MAY NEVER COST A LIVE VETO.
   *
   * Evicting the least recently written entry is only safe when it has
   * expired. Dropping a live one hands the party it is about straight back
   * onto LL inside the window the memo exists to cover -- and the condition
   * that fills this map is a burst of demotions, which is the database
   * failure the memo is the belt for (a Farol finding on this PR).
   */
  it("(1b-octies) refuses LL for everyone rather than drop a live veto", async () => {
    for (let i = 0; i < 1024; i += 1) {
      noteLlDemotion(`live-${i}`);
    }
    expect(llMemoSizesForTests().demotedParties).toBe(1024);

    noteLlDemotion("overflow");

    // Nothing was lost, and nothing grew.
    expect(llMemoSizesForTests()).toMatchObject({
      demotedParties: 1024,
      entriesScanned: 0,
    });
    expect(llDemotedRecently("live-0")).toBe(true);
    expect(llDemotedRecently("live-1023")).toBe(true);
    // And the party that could not be recorded is refused anyway: with the
    // memo saturated the answer for every party is no, until a sweep makes
    // room. Fail closed beats guessing which veto was safe to lose.
    expect(llDemotedRecently("overflow")).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlDemotionMemoFull",
      expect.objectContaining({ partySessionId: "overflow", cap: 1024 }),
    );

    // Once the entries expire, the sweep prunes them and the saturation goes
    // with the condition: a fresh party is eligible again.
    await sweepLlDemotions(Date.now() + 6 * 60_000);
    expect(llMemoSizesForTests().demotedParties).toBe(0);
    expect(llDemotedRecently("overflow")).toBe(false);
  });

  /**
   * A SWEEP THAT FREED NOTHING HAS NOT ENDED THE CONDITION.
   *
   * The fail-closed answer used to be cleared on every sweep, whether or not
   * the sweep had made room. A memo of live vetoes prunes to the same live
   * vetoes, so the flag lifted while the map was exactly as full as before,
   * and the party that could not be recorded was handed LL again -- the one
   * outcome the memo exists to prevent (a Farol finding on PR #630, merged
   * as a known edge case and fixed here).
   */
  it("(1b-decies) stays saturated while a sweep cannot free a single slot", async () => {
    for (let i = 0; i < 1024; i += 1) {
      noteLlDemotion(`live-${i}`);
    }
    noteLlDemotion("overflow");
    expect(llDemotedRecently("overflow")).toBe(true);

    // Every entry is still inside the window, so this sweep deletes nothing.
    await sweepLlDemotions();

    expect(llMemoSizesForTests().demotedParties).toBe(1024);
    expect(llDemotedRecently("overflow")).toBe(true);
    expect(llDemotedRecently("live-0")).toBe(true);

    // Nor does the flag's own five-minute expiry let it lapse underneath a
    // condition that is still true: a sweep inside the window re-states it.
    const almostLapsed = Date.now() + 4 * 60_000;
    await sweepLlDemotions(almostLapsed);
    expect(llDemotedRecently("overflow", almostLapsed + 2 * 60_000)).toBe(true);

    // It ends when a sweep finds room, and not before.
    const afterWindow = Date.now() + 6 * 60_000 + 4 * 60_000;
    await sweepLlDemotions(afterWindow);
    expect(llMemoSizesForTests().demotedParties).toBe(0);
    expect(llDemotedRecently("overflow", afterWindow)).toBe(false);
  });

  it("(1b-nonies) evicts an EXPIRED entry to make room, rather than saturating", async () => {
    const old = Date.now() - 6 * 60_000;
    noteLlDemotion("stale", old);
    for (let i = 0; i < 1023; i += 1) {
      noteLlDemotion(`live-${i}`);
    }
    expect(llMemoSizesForTests().demotedParties).toBe(1024);

    noteLlDemotion("fresh");

    // The expired one made way, in one constant-time look: insertion order
    // is write order, so the least recently written entry is the only
    // candidate that needs testing.
    expect(llMemoSizesForTests()).toMatchObject({
      demotedParties: 1024,
      entriesScanned: 0,
    });
    expect(llDemotedRecently("fresh")).toBe(true);
    expect(llDemotedRecently("live-0")).toBe(true);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsLlDemotionMemoFull",
      expect.anything(),
    );
  });

  it("(1c) never stops a demoted session whose row another live instance has taken", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    // This process was out of touch long enough for the other machine to take
    // the row and (as far as it is concerned) drive the party. Acting on a
    // stale `llRooms` entry here would DELETE the box session and rewrite a
    // live owner's row: the exact failure the rest of this change prevents,
    // arriving through the one path with no claim in front of it.
    const machineB = randomUUID();
    await heartbeat(machineB, 1);
    const taken = await getPool().query<{ id: string }>(
      `UPDATE hls_sessions SET instance_id = $2
        WHERE channel_id = $1 AND mode = 'll' AND ended_at IS NULL
        RETURNING id`,
      [channelA, machineB],
    );
    expect(taken.rowCount).toBe(1);

    const fellBack = await sweepLlDemotions();

    expect(fellBack).toEqual([]);
    expect(stopped).toEqual([]);
    expect(llHlsActivity().demoted).toBe(0);
    // The stale entry is dropped, so this process stops claiming a session it
    // does not own, and the row stays exactly as its owner left it.
    expect(llHasRoom(channelA)).toBe(false);
    const row = await rowById(taken.rows[0]!.id);
    expect(row.ended_at).toBeNull();
    expect(row.instance_id).toBe(machineB);
    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({ requested: true });
  });

  it("(1d) clears the party that asked for the session, not whatever is live now", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    // The host ends that party and starts ANOTHER one on the same channel,
    // asking for LL again, before the demotion cleanup runs (a retry after a
    // database failure, a slow tick). "The live party for this channel" is
    // now a different row from the one that asked for the demoted session,
    // and clearing it would silently downgrade a party that never had
    // anything go wrong. Only one party may be live per channel, so this is
    // the real sequence rather than a contrived one.
    const owner = await getPool().query<{ id: string }>(
      `SELECT created_by AS id FROM channel_sessions WHERE id = $1`,
      [partyId],
    );
    await getPool().query(
      `UPDATE channel_sessions SET status = 'ended' WHERE id = $1`,
      [partyId],
    );
    const newer = await getPool().query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, title, status, created_by, low_latency_requested)
       VALUES ($1, 'Outra', 'live', $2, TRUE) RETURNING id`,
      [channelA, owner.rows[0]!.id],
    );
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "idr-gap-exceeded",
    });

    await sweepLlDemotions();

    const rows = await getPool().query<{ id: string; low_latency_requested: boolean }>(
      `SELECT id, low_latency_requested FROM channel_sessions WHERE channel_id = $1`,
      [channelA],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.low_latency_requested]));
    // THE NEW PARTY KEEPS ITS REQUEST. The demoted session's own party is the
    // only one the clear may name, and it is not live any more, so the write
    // is a no-op rather than a downgrade of somebody else.
    expect(byId.get(newer.rows[0]!.id)).toBe(true);
    expect(byId.get(partyId)).toBe(true);
  });

  it("(1d-bis) still clears the request when the attribution lookup failed at start", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    // The SELECT that records which party asked failed when the session
    // started, so the row carries NULL. That is UNKNOWN, not "there was no
    // party": reading it the second way left `low_latency_requested` true for
    // the very party the demotion was about, and five minutes later a
    // reconcile started LL straight back into the same failure.
    await getPool().query(
      `UPDATE hls_sessions SET watch_party_session_id = NULL
        WHERE channel_id = $1 AND mode = 'll'`,
      [channelA],
    );
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "idr-gap-exceeded",
    });

    await sweepLlDemotions();

    expect(await liveHlsRequestForChannel(channelA)).toMatchObject({ requested: false });
    expect(pendingLlDemotionCount()).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlDemotionAttributed",
      expect.objectContaining({ channelId: channelA, partySessionId: partyId }),
    );
  });

  it("(1d-ter) does not attribute a demotion to a party that started after the session", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    await getPool().query(
      `UPDATE hls_sessions SET watch_party_session_id = NULL,
              started_at = NOW() - INTERVAL '1 hour'
        WHERE channel_id = $1 AND mode = 'll'`,
      [channelA],
    );
    // The party that could have asked is over; a brand-new one is live and
    // has asked for LL on its own account. It was created AFTER the demoted
    // session started, so it is not the one being demoted.
    const owner = await getPool().query<{ id: string }>(
      `SELECT created_by AS id FROM channel_sessions WHERE id = $1`,
      [partyId],
    );
    await getPool().query(
      `UPDATE channel_sessions SET status = 'ended',
              created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [partyId],
    );
    const newer = await getPool().query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, title, status, created_by, low_latency_requested)
       VALUES ($1, 'Outra', 'live', $2, TRUE) RETURNING id`,
      [channelA, owner.rows[0]!.id],
    );
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });

    // Three attempts is what the attribution is allowed before it gives up
    // and fails closed; up to then the newer party is left alone.
    await sweepLlDemotions();
    const stillAsking = await getPool().query<{ low_latency_requested: boolean }>(
      `SELECT low_latency_requested FROM channel_sessions WHERE id = $1`,
      [newer.rows[0]!.id],
    );
    expect(stillAsking.rows[0]!.low_latency_requested).toBe(true);
    expect(pendingLlDemotionCount()).toBe(1);
  });

  it("(1e) finishes the cleanup on a later tick when the box refuses the stop", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "part-stuck",
    });
    refuseStops = true;

    const first = await sweepLlDemotions();

    // The demotion is counted once and the ladder is asked for immediately --
    // the audience must not wait on the box agreeing to a DELETE -- but the
    // row is still open, so the cleanup is not done.
    expect(first).toEqual([channelA]);
    expect(llHlsActivity().demoted).toBe(1);
    expect(pendingLlDemotionCount()).toBe(1);
    const open = await getPool().query<{ id: string }>(
      `SELECT id FROM hls_sessions WHERE channel_id = $1 AND ended_at IS NULL`,
      [channelA],
    );
    expect(open.rowCount).toBe(1);

    // The box comes back. `retryStopOpenLlRow` paces itself off the row, so
    // age the stop the same way a real minute would.
    refuseStops = false;
    await getPool().query(
      `UPDATE hls_sessions SET stopping_at = NOW() - INTERVAL '1 minute'
        WHERE channel_id = $1 AND ended_at IS NULL`,
      [channelA],
    );

    const second = await sweepLlDemotions(Date.now() + 120_000);

    // Counted once, not twice: a retry finishes a demotion, it is not a new
    // one. And the queue drains rather than replaying forever.
    expect(second).toEqual([channelA]);
    expect(llHlsActivity().demoted).toBe(1);
    expect(pendingLlDemotionCount()).toBe(0);
    expect(stopped).toContain(sessionId);
    const after = await getPool().query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM hls_sessions WHERE channel_id = $1`,
      [channelA],
    );
    expect(after.rows[0]!.ended_at).not.toBeNull();
  });

  it("(1f) backs the retry off instead of working the queue on every tick", async () => {
    await reconcileLlHlsNow(channelA, "peer-1");
    const sessionId = started[0]!;
    boxSessions.set(sessionId, {
      ...boxSessions.get(sessionId)!,
      demoted: true,
      demotedReason: "no-video",
    });
    refuseStops = true;
    const at = Date.now();
    await sweepLlDemotions(at);
    const afterFirst = stopAttempts;
    expect(afterFirst).toBeGreaterThan(0);

    // The very next tick, ten seconds later: still backing off, no second
    // DELETE, no second round of database work for the same entry.
    await sweepLlDemotions(at + 10);
    expect(stopAttempts).toBe(afterFirst);

    // Past the backoff it tries again.
    await getPool().query(
      `UPDATE hls_sessions SET stopping_at = NOW() - INTERVAL '1 minute'
        WHERE channel_id = $1 AND ended_at IS NULL`,
      [channelA],
    );
    await sweepLlDemotions(at + 120_000);
    expect(stopAttempts).toBeGreaterThan(afterFirst);
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
