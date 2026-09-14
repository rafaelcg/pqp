import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressStatus } from "livekit-server-sdk";

/**
 * TWO API MACHINES AND ONE WATCH PARTY, on a real Postgres with
 * `VOICE_REGISTRY=postgres` set — the flag production runs and the flag that
 * changes the code path, which is the whole of pitfall 12's lesson.
 *
 * `reconcileStaleHlsSessions` was written for one process and says so: "this
 * process owns no session at boot, so every open row is stale by definition".
 * With two machines that sentence is a promise that every rolling deploy
 * kills a live stream — machine B boots, adopts machine A's running egresses
 * and ends the rows for anything LiveKit did not list for it, which hands a
 * live party's segments to the retention sweep. `hls_sessions.instance_id`
 * plus the `voice_instances` heartbeat is what tells the two apart, and this
 * file pins the four cases that matter:
 *
 *   (a) A is alive: B neither adopts, nor ends, nor stops.
 *   (b) A's heartbeat expired: B adopts and RE-STAMPS the row as its own.
 *   (c) `VOICE_REGISTRY` off (a self-host, one process): unchanged, every
 *       open row adoptable, no round trip, no behaviour change at all.
 *   (d) the box-budget ghost filter does not write off a transcode whose row
 *       another live instance owns.
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
const { reconcileStaleHlsSessions } = await import("./hls-cleanup.js");
const {
  activeBoxEgressCount,
  liveHlsActivity,
  liveHlsStreamFor,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} = await import("./hls-egress.js");
const {
  claimHlsSessionRows,
  forgetPendingHlsSessionClaims,
  hlsOwnerInstanceId,
  pendingHlsSessionClaimCount,
  retryPendingHlsSessionClaims,
} = await import("./hls-ownership.js");

describeDb("hls_sessions ownership across two API machines", () => {
  /** The OTHER machine. This test process is always "B". */
  let machineA: string;
  let channelA: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions, voice_instances RESTART IDENTITY CASCADE`,
    );
    logEvent.mockClear();
    resetLiveHlsForTests();
    process.env.VOICE_REGISTRY = "postgres";
    machineA = randomUUID();

    const user = await upsertUser({
      clerkId: "clerk_hls_owner",
      displayName: "Owner Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channels = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'a', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelA = channels.rows[0]!.id;
  });

  afterEach(() => {
    resetLiveHlsForTests();
    delete process.env.VOICE_REGISTRY;
  });

  /** A heartbeat row for the other machine, as fresh (or as stale) as asked. */
  async function heartbeat(instanceId: string, secondsAgo: number): Promise<void> {
    await getPool().query(
      `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at)
       VALUES ($1, 'test', NOW() - ($2 || ' seconds')::interval)
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, secondsAgo],
    );
  }

  async function makeSession(options: {
    prefix: string;
    egressId: string;
    instanceId: string | null;
    endedAt?: Date | null;
  }): Promise<string> {
    const row = await getPool().query<{ id: string }>(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, egress_id,
          presenter_peer_id, video_track_id, instance_id)
       VALUES ($1, $2, NOW(), $3, $4, 'peer-1', 'TR_V', $5)
       RETURNING id`,
      [
        channelA,
        options.prefix,
        options.endedAt ?? null,
        options.egressId,
        options.instanceId,
      ],
    );
    return row.rows[0]!.id;
  }

  /** A media server that reports whichever egresses the test names. */
  function mediaServer(running: { egressId: string; roomName: string }[]) {
    const stop = vi.fn(async () => {});
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "unused" }),
        stopEgress: stop,
        listEgress: async () =>
          running.map((entry) => ({
            egressId: entry.egressId,
            status: EgressStatus.EGRESS_ACTIVE,
            roomName: entry.roomName,
          })),
      },
    });
    return { stop };
  }

  async function rowById(id: string): Promise<{
    ended_at: Date | null;
    instance_id: string | null;
  }> {
    const result = await getPool().query<{
      ended_at: Date | null;
      instance_id: string | null;
    }>(`SELECT ended_at, instance_id FROM hls_sessions WHERE id = $1`, [id]);
    return result.rows[0]!;
  }

  it("(a) leaves a live row alone when its owner is still answering its heartbeat", async () => {
    await heartbeat(machineA, 2);
    const id = await makeSession({
      prefix: `live/${channelA}/9000`,
      egressId: "EG_a",
      instanceId: machineA,
    });
    const { stop } = mediaServer([{ egressId: "EG_a", roomName: channelA }]);

    const result = await reconcileStaleHlsSessions();

    // THE DEPLOY THAT DOES NOT KILL THE STREAM. Not adopted (A already has a
    // monitor on it), not stopped, and the row is untouched: still open and
    // still A's, so retention will not come for a film people are watching.
    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 0 });
    expect(stop).not.toHaveBeenCalled();
    expect(liveHlsStreamFor(channelA)).toBeNull();
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    expect(row.instance_id).toBe(machineA);
    // And the guard says so out loud, rather than being invisible: pitfall 12.
    expect(liveHlsActivity().skippedOwnedElsewhere).toBeGreaterThan(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSkippedOwnedElsewhere",
      expect.objectContaining({ site: "boot-adopt", ownerInstanceId: machineA }),
    );
  });

  it("(a) does not END an open row owned by a live instance even when the media server never lists it", async () => {
    await heartbeat(machineA, 2);
    const id = await makeSession({
      prefix: `live/${channelA}/9100`,
      egressId: "EG_unlisted",
      instanceId: machineA,
    });
    // LiveKit answers with nothing for THIS machine's question. The old rule
    // would end the row on the spot and let retention delete its segments.
    mediaServer([]);

    const result = await reconcileStaleHlsSessions();

    expect(result.ended).toBe(0);
    expect((await rowById(id)).ended_at).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSkippedOwnedElsewhere",
      expect.objectContaining({ site: "boot-end", sessionId: id }),
    );
  });

  it("(b) adopts and re-stamps a row whose owner's heartbeat has expired", async () => {
    // Past `INSTANCE_TTL_MS` (45 s), the same expiry rule the voice registry
    // uses to free a dead instance's seats.
    await heartbeat(machineA, 300);
    const id = await makeSession({
      prefix: `live/${channelA}/9200`,
      egressId: "EG_dead-owner",
      instanceId: machineA,
      endedAt: new Date(),
    });
    const { stop } = mediaServer([
      { egressId: "EG_dead-owner", roomName: channelA },
    ]);

    const result = await reconcileStaleHlsSessions();

    expect(result.adopted).toBe(1);
    expect(result.stopped).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(liveHlsStreamFor(channelA)?.startedAt).toBe(9200);
    const row = await rowById(id);
    expect(row.ended_at).toBeNull();
    // RE-STAMPED, not left reading as the dead machine's: otherwise the third
    // machine to boot would free a session this one is now driving.
    expect(row.instance_id).toBe(hlsOwnerInstanceId());
  });

  it("(b) adopts a row nobody ever owned (written before the column existed)", async () => {
    await heartbeat(machineA, 2);
    const id = await makeSession({
      prefix: `live/${channelA}/9300`,
      egressId: "EG_unowned",
      instanceId: null,
    });
    mediaServer([{ egressId: "EG_unowned", roomName: channelA }]);

    const result = await reconcileStaleHlsSessions();

    expect(result.adopted).toBe(1);
    expect((await rowById(id)).instance_id).toBe(hlsOwnerInstanceId());
  });

  it("(c) with VOICE_REGISTRY off, every open row is adoptable exactly as before", async () => {
    // A self-host, or production before the flag: one process, no heartbeats
    // worth reading, and a row that still names some long-gone instance must
    // not become unadoptable forever.
    delete process.env.VOICE_REGISTRY;
    await heartbeat(machineA, 2);
    const id = await makeSession({
      prefix: `live/${channelA}/9400`,
      egressId: "EG_single-machine",
      instanceId: machineA,
    });
    const { stop } = mediaServer([
      { egressId: "EG_single-machine", roomName: channelA },
    ]);

    const result = await reconcileStaleHlsSessions();

    expect(result.adopted).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    expect((await rowById(id)).instance_id).toBe(hlsOwnerInstanceId());
    expect(liveHlsActivity().skippedOwnedElsewhere).toBe(0);
  });

  it("(c) with VOICE_REGISTRY off, an open row with no egress behind it is still ended", async () => {
    delete process.env.VOICE_REGISTRY;
    await heartbeat(machineA, 2);
    const id = await makeSession({
      prefix: `live/${channelA}/9500`,
      egressId: "EG_gone",
      instanceId: machineA,
    });
    mediaServer([]);

    const result = await reconcileStaleHlsSessions();

    expect(result.ended).toBe(1);
    expect((await rowById(id)).ended_at).not.toBeNull();
  });

  it("(d) the ghost filter does not write off a transcode whose row a live instance owns", async () => {
    await heartbeat(machineA, 2);
    // The row is ENDED, so the channel has no live session as far as the
    // channel-level ghost rule can see, and the record is well past the two
    // minute grace: the exact shape that used to read as a leak. It is A's
    // and A is alive, so it is a rendition costing the box a core, and the
    // budget has to count it.
    await makeSession({
      prefix: `live/${channelA}/9600`,
      egressId: "EG_other-machine",
      instanceId: machineA,
      endedAt: new Date(),
    });
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "unused" }),
        stopEgress: async () => {},
        listEgress: async () => [
          {
            egressId: "EG_other-machine",
            status: EgressStatus.EGRESS_ACTIVE,
            roomName: channelA,
            startedAt: Date.now() - 10 * 60_000,
          },
        ],
      },
    });
    logEvent.mockClear();

    const count = await activeBoxEgressCount();

    expect(count).toBe(1);
    expect(
      logEvent.mock.calls.filter((call) => call[0] === "voice.hlsGhostEgress"),
    ).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSkippedOwnedElsewhere",
      expect.objectContaining({ site: "ghost", egressId: "EG_other-machine" }),
    );
    expect(liveHlsActivity().skippedOwnedElsewhere).toBeGreaterThan(0);
  });

  it("re-stamps later when the claim itself fails, rather than reporting an adoption the row never recorded", async () => {
    // THE HANDOFF IS TWO THINGS AND ONLY ONE OF THEM IS IN MEMORY. The egress
    // is this process's the moment it adopts it; the row saying so is a second
    // write that can fail. A row left naming a dead instance while a live
    // process drives it is exactly what the next machine's boot sweep is
    // entitled to free, so a failed claim is queued and retried rather than
    // swallowed.
    const id = await makeSession({
      prefix: `live/${channelA}/9800`,
      egressId: "EG_claim",
      instanceId: machineA,
      endedAt: new Date(),
    });
    const pool = getPool();
    const failOnce = vi
      .spyOn(pool, "query")
      .mockRejectedValueOnce(new Error("connection terminated"));

    expect(await claimHlsSessionRows([id], { reopen: true })).toBe(false);
    expect(pendingHlsSessionClaimCount()).toBe(1);

    failOnce.mockRestore();
    await retryPendingHlsSessionClaims();

    expect(pendingHlsSessionClaimCount()).toBe(0);
    const row = await rowById(id);
    expect(row.instance_id).toBe(hlsOwnerInstanceId());
    expect(row.ended_at).toBeNull();
  });

  it("drops a queued stamp when the session is torn down, rather than reopening a dead row", async () => {
    // The retry carries `reopen`, so a teardown between the failed claim and
    // the retry would otherwise clear `ended_at` on a row whose egress is
    // gone: an open row retention can never collect, which is the opposite of
    // what this whole change is for.
    const id = await makeSession({
      prefix: `live/${channelA}/9900`,
      egressId: "EG_torn-down",
      instanceId: machineA,
      endedAt: new Date(),
    });
    const pool = getPool();
    const failOnce = vi
      .spyOn(pool, "query")
      .mockRejectedValueOnce(new Error("connection terminated"));
    await claimHlsSessionRows([id], { reopen: true });
    failOnce.mockRestore();
    expect(pendingHlsSessionClaimCount()).toBe(1);

    forgetPendingHlsSessionClaims([id]);
    await retryPendingHlsSessionClaims();

    expect(pendingHlsSessionClaimCount()).toBe(0);
    expect((await rowById(id)).ended_at).not.toBeNull();
  });

  it("gives up on a stamp that has been waiting past its retry window", async () => {
    // `StopEgress` and this UPDATE share a property: a queue with no terminal
    // case is a queue that replays forever. The row is minutes stale by then
    // and the monitor is the authority on what this process still drives.
    const id = await makeSession({
      prefix: `live/${channelA}/9910`,
      egressId: "EG_stale-claim",
      instanceId: machineA,
    });
    const failOnce = vi
      .spyOn(getPool(), "query")
      .mockRejectedValueOnce(new Error("connection terminated"));
    await claimHlsSessionRows([id]);
    failOnce.mockRestore();
    expect(pendingHlsSessionClaimCount()).toBe(1);

    await retryPendingHlsSessionClaims(Date.now() + 6 * 60_000);

    expect(pendingHlsSessionClaimCount()).toBe(0);
    // Untouched: giving up means leaving the row as it is, not writing to it.
    expect((await rowById(id)).instance_id).toBe(machineA);
  });

  it("never reopens a swept row, however long the stamp waited", async () => {
    const id = await makeSession({
      prefix: `live/${channelA}/9920`,
      egressId: "EG_swept",
      instanceId: machineA,
      endedAt: new Date(),
    });
    await getPool().query(`UPDATE hls_sessions SET cleaned_at = NOW() WHERE id = $1`, [id]);

    expect(await claimHlsSessionRows([id], { reopen: true })).toBe(true);

    const row = await rowById(id);
    expect(row.ended_at).not.toBeNull();
    expect(row.instance_id).toBe(machineA);
  });

  it("(d) the ghost filter still writes off a record nobody owns", async () => {
    // The other half of the same rule: ownership is what spares a record,
    // not merely having a row. No owner, no live row, past the grace: a ghost.
    await makeSession({
      prefix: `live/${channelA}/9700`,
      egressId: "EG_real-ghost",
      instanceId: null,
      endedAt: new Date(),
    });
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "unused" }),
        stopEgress: async () => {},
        listEgress: async () => [
          {
            egressId: "EG_real-ghost",
            status: EgressStatus.EGRESS_ACTIVE,
            roomName: channelA,
            startedAt: Date.now() - 10 * 60_000,
          },
        ],
      },
    });
    logEvent.mockClear();

    const count = await activeBoxEgressCount();

    expect(count).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsGhostEgress",
      expect.objectContaining({
        egressId: "EG_real-ghost",
        reason: "no-live-session",
      }),
    );
  });
});
