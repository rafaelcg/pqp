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
import { createMemoryHub } from "../lib/bus.js";

/**
 * STANDING DOWN IS ONLY HALF THE FIX.
 *
 * `hls-keep-warm-owner.test.ts` pins the machine that does NOT own a session
 * leaving it alone. On its own that would be a worse bug than the duplicate
 * warming it replaces: the owner only arms a loop when a viewer polls IT, and
 * an audience of two can perfectly well both land on the other machine (or the
 * owner's own loop can have idled out hours into a party). Nobody would be
 * warming at all.
 *
 * So the machine standing down says so on the bus and the owner picks the job
 * up — the same shape as `voice.hlsReconcile`. Two real module graphs over one
 * memory hub, because "the owner arms its own loop" is a claim about a
 * different process, and a real Postgres with `VOICE_REGISTRY=postgres`
 * because that is the flag that makes ownership mean anything (pitfall 12).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

type BusModule = typeof import("../lib/bus.js");
type ProxyModule = typeof import("./hls-playlist-proxy.js");
type OwnershipModule = typeof import("./hls-ownership.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  proxy: ProxyModule;
  ownership: OwnershipModule;
  db: DbModule;
}

const hub = createMemoryHub();
const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const proxy = (await import("./hls-playlist-proxy.js")) as ProxyModule;
  const ownership = (await import("./hls-ownership.js")) as OwnershipModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, proxy, ownership, db };
  booted.push(instance);
  return instance;
}

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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeDb("the owner picks up the keep-warm job it was handed", () => {
  /** Holds the `hls_sessions` rows. Gets no viewer of its own. */
  let owner: Instance;
  /** Serves the viewer, owns nothing. */
  let edge: Instance;
  let channelId: string;

  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    await db.closePool();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.db.closePool().catch(() => {});
    }
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    enableHls();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );
    owner = await bootInstance();
    edge = await bootInstance();
    const pool = owner.db.getPool();
    await pool.query(
      `TRUNCATE users, servers, channels, hls_sessions, voice_instances
       RESTART IDENTITY CASCADE`,
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_kwh', 'Host')
       RETURNING id`,
    );
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('hall', $1) RETURNING id`,
      [user.rows[0]!.id],
    );
    const channel = await pool.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'festa', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;

    // The rows belong to `owner`, and `owner` is answering its heartbeat.
    const ownerId = owner.ownership.hlsOwnerInstanceId();
    await pool.query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, rung, instance_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)`,
      [channelId, `live/${channelId}/${STARTED_AT}-${RUNG}`, STARTED_AT, RUNG, ownerId],
    );
    await pool.query(
      `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at)
       VALUES ($1, 'test', NOW())
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [ownerId],
    );
  });

  afterEach(async () => {
    for (const instance of booted.splice(0)) {
      instance.proxy.resetHlsPlaylistCacheForTests();
      instance.ownership.resetHlsOwnershipForTests();
      await instance.bus.closeBus().catch(() => {});
      await instance.db.closePool().catch(() => {});
    }
    vi.unstubAllGlobals();
    disableHls();
    delete process.env.VOICE_REGISTRY;
  });

  it("the edge stands down and the owner, with no viewer of its own, starts warming", async () => {
    // The whole audience is on the machine that owns nothing.
    await edge.proxy.buildSignedPlaylist(channelId, STARTED_AT, RUNG);
    expect(owner.proxy.hlsKeepWarmLoopsActive()).toBe(0);

    await waitFor(
      () => edge.proxy.hlsKeepWarmLoopsActive() === 0,
      "the edge to stand down",
    );
    expect(edge.proxy.hlsKeepWarmDeclined()).toBe(1);
    expect(edge.proxy.hlsKeepWarmRenders()).toBe(0);

    // THE POINT: exactly one machine is warming, and it is the owner, which
    // no viewer has ever polled.
    await waitFor(
      () => owner.proxy.hlsKeepWarmRenders() > 0,
      "the owner to pick the session up",
    );
    expect(owner.proxy.hlsKeepWarmLoopsActive()).toBe(1);
    expect(owner.proxy.hlsKeepWarmAdopted()).toBe(1);
    expect(edge.proxy.hlsKeepWarmLoopsActive()).toBe(0);
  });
});
