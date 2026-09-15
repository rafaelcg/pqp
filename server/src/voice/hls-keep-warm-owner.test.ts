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
 * ONE KEEP-WARM LOOP PER STREAM, NOT ONE PER MACHINE.
 *
 * The playlist proxy keeps every rung of a live session rendered on the
 * server's own two-second clock, so a rung nobody is watching still has a full
 * window when somebody switches to it. The loop is armed by a VIEWER's
 * request, and production runs two `pqp-api` machines behind a proxy with no
 * session affinity: both of them armed a loop for the same party within
 * seconds of each other, and every tick after that was a second full ladder
 * re-render, a second set of storage GETs and a second set of signatures for
 * one set of playlists in one bucket.
 *
 * Only the machine that owns the session's `hls_sessions` rows warms it now.
 * `VOICE_REGISTRY=postgres` because that is the flag production sets and the
 * flag that makes ownership mean anything (pitfall 12), and a real Postgres
 * because the answer is a join against `voice_instances` heartbeats.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  buildSignedPlaylist,
  hlsKeepWarmDeclined,
  hlsKeepWarmLoopsActive,
  hlsKeepWarmRenders,
  HLS_KEEP_WARM_INTERVAL_MS,
  resetHlsPlaylistCacheForTests,
} = await import("./hls-playlist-proxy.js");
const { resetHlsOwnershipForTests } = await import("./hls-ownership.js");
const { createMemoryHub, createMemoryTransport, setBusTransport, closeBus } =
  await import("../lib/bus.js");

const RUNG = "720p30";
const STARTED_AT = 1_700_000_000_000;

const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:39.718Z",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
  "",
].join("\n");

function enableHls(): void {
  process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
  process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
  process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
  process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
  process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
}

function disableHls(): void {
  delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
  delete process.env.LIVE_HLS_S3_BUCKET;
  delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
  delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
  delete process.env.LIVE_HLS_S3_ENDPOINT;
}

/** Long enough for at least two ticks of the loop to have come round. */
const TWO_TICKS_MS = HLS_KEEP_WARM_INTERVAL_MS * 2 + 500;

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + TWO_TICKS_MS;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describeDb("the keep-warm loop runs only on the machine that owns the session", () => {
  let channelId: string;
  let hub: ReturnType<typeof createMemoryHub>;
  let frames: { origin: string; topic: string; data: unknown }[];
  const otherInstance = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

  /** The owner's answer, as the other machine's transport would deliver it. */
  function ownerAnswers(startedAt: number): void {
    for (const listener of [...hub.listeners]) {
      listener({
        origin: "the-owner",
        topic: "voice.hlsKeepWarmTaken",
        data: { channelId, startedAt },
      });
    }
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions, voice_instances
       RESTART IDENTITY CASCADE`,
    );
    const user = await getPool().query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_kw', 'Host')
       RETURNING id`,
    );
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('hall', $1) RETURNING id`,
      [user.rows[0]!.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'festa', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    process.env.VOICE_REGISTRY = "postgres";
    // A bus with nobody else on it: enough for the hand-over to have somewhere
    // to go, which is what this process requires before it will consider
    // standing down at all. The test plays the owner by answering on `hub`.
    hub = createMemoryHub();
    frames = [];
    hub.listeners.add((frame) => frames.push(frame));
    setBusTransport(createMemoryTransport(hub));
    enableHls();
    resetHlsPlaylistCacheForTests();
    resetHlsOwnershipForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );
  });

  afterEach(async () => {
    resetHlsPlaylistCacheForTests();
    resetHlsOwnershipForTests();
    await closeBus();
    vi.unstubAllGlobals();
    disableHls();
    delete process.env.VOICE_REGISTRY;
  });

  /** One live rung of one session, owned by `instanceId` (NULL for nobody). */
  async function liveSession(instanceId: string | null): Promise<void> {
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, rung, instance_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)`,
      [
        channelId,
        `live/${channelId}/${STARTED_AT}-${RUNG}`,
        STARTED_AT,
        RUNG,
        instanceId,
      ],
    );
  }

  /** A heartbeat for another machine, as fresh (or as stale) as asked. */
  async function heartbeat(instanceId: string, secondsAgo: number): Promise<void> {
    await getPool().query(
      `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at)
       VALUES ($1, 'test', NOW() - ($2 || ' seconds')::interval)
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, secondsAgo],
    );
  }

  it("stands down only once the owner answers, and serves the viewer throughout", async () => {
    await liveSession(otherInstance);
    await heartbeat(otherInstance, 1);

    // A viewer polls this machine: they are served, exactly as before.
    const body = await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    expect(body).toContain("#EXTM3U");
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    await waitFor(
      () => frames.some((f) => f.topic === "voice.hlsKeepWarm"),
      "the hand-over to be published",
    );
    // STILL WARMING. An unanswered ask is not a warmer: the publish may have
    // been dropped by a transport that is reconnecting, and this machine
    // cannot tell that apart from one that arrived.
    expect(hlsKeepWarmLoopsActive()).toBe(1);

    ownerAnswers(STARTED_AT);
    expect(hlsKeepWarmLoopsActive()).toBe(0);
    expect(hlsKeepWarmDeclined()).toBe(1);

    // And the next viewer does not re-arm it: the answer is remembered, so a
    // party with an audience on this machine does not re-decide every poll.
    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    expect(hlsKeepWarmLoopsActive()).toBe(0);
    expect(hlsKeepWarmDeclined()).toBe(1);
  });

  it("keeps warming for as long as the owner never answers", async () => {
    await liveSession(otherInstance);
    await heartbeat(otherInstance, 1);

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    // Nobody answers. The stream must not be left with no warmer at all.
    await waitFor(
      () => hlsKeepWarmRenders() > 0,
      "a warm render while the hand-over goes unanswered",
    );
    expect(hlsKeepWarmLoopsActive()).toBe(1);
    expect(hlsKeepWarmDeclined()).toBe(0);
  });

  it("keeps warming when the owner's heartbeat has expired", async () => {
    await liveSession(otherInstance);
    // Past INSTANCE_TTL_MS (45s): the owner is not answering, so this row is
    // free and this machine is the only one left to keep it warm.
    await heartbeat(otherInstance, 120);

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    await waitFor(
      () => hlsKeepWarmRenders() > 0,
      "a warm render on the surviving machine",
    );
    expect(hlsKeepWarmLoopsActive()).toBe(1);
    expect(hlsKeepWarmDeclined()).toBe(0);
  });

  it("keeps warming an unstamped session (pre-column rows, and a self-host)", async () => {
    await liveSession(null);
    await heartbeat(otherInstance, 1);

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    await waitFor(
      () => hlsKeepWarmRenders() > 0,
      "a warm render for a row nobody claims",
    );
    expect(hlsKeepWarmDeclined()).toBe(0);
  });

  it("names the session in the hand-over it publishes", async () => {
    await liveSession(otherInstance);
    await heartbeat(otherInstance, 1);

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    await waitFor(
      () => frames.some((f) => f.topic === "voice.hlsKeepWarm"),
      "the hand-over to be published",
    );

    // THE HAND-OVER IS THE POINT. Standing down alone would leave nobody
    // warming a party whose whole audience landed on this machine.
    const handover = frames.find((f) => f.topic === "voice.hlsKeepWarm")!;
    expect(handover.data).toMatchObject({ channelId, startedAt: STARTED_AT });
  });

  it("keeps warming when there is no bus to hand the session over on", async () => {
    await liveSession(otherInstance);
    await heartbeat(otherInstance, 1);
    // No transport: the owner cannot be told, so standing down would be
    // handing the job to nobody. Warming twice is the cheap mistake.
    await closeBus();

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    await waitFor(
      () => hlsKeepWarmRenders() > 0,
      "a warm render with nobody to hand over to",
    );
    expect(hlsKeepWarmLoopsActive()).toBe(1);
    expect(hlsKeepWarmDeclined()).toBe(0);
  });

  it("with VOICE_REGISTRY off, ownership is never asked and the loop always runs", async () => {
    delete process.env.VOICE_REGISTRY;
    await liveSession(otherInstance);
    await heartbeat(otherInstance, 1);

    await buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    await waitFor(
      () => hlsKeepWarmRenders() > 0,
      "a warm render on the single-machine path",
    );
    expect(hlsKeepWarmLoopsActive()).toBe(1);
    expect(hlsKeepWarmDeclined()).toBe(0);
    await settle(50);
  });
});
