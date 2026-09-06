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
 * SFU re-sweeps as claims: milestone M4 of
 * `docs/plans/MULTI_INSTANCE_VOICE.md`, section 5.4.
 *
 * With one process a re-sweep was a `setInterval` per key. With two, both
 * would sweep the same room, and a deploy inside the fifteen-minute window
 * dropped the remaining sweeps. Now the sweep is a `voice_resweeps` row and
 * a tick on any instance claims what is unclaimed. What is pinned here:
 * two instances ticking claim each row once between them; a row written
 * by one module graph is swept by a fresh one (a "restart"); the identity
 * hint rides in the row so a pre-metadata participant is still resolvable
 * from the other machine; expired rows are deleted; and with the flag off
 * the table is never written.
 *
 * Same boundary as `admin.test.ts`: the LiveKit SDK is the one thing
 * mocked. The counters are hoisted, so every module graph reports into
 * the same tallies. Real Postgres on `TEST_DATABASE_URL`; skips without.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const lk = vi.hoisted(() => ({
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listRooms = lk.listRooms;
      listParticipants = lk.listParticipants;
      removeParticipant = lk.removeParticipant;
    },
  };
});

type AdminModule = typeof import("./admin.js");
type DbModule = typeof import("../db.js");
type BackendsModule = typeof import("./backends.js");

interface Instance {
  admin: AdminModule;
  db: DbModule;
}

const pools: DbModule[] = [];
const booted: Instance[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const db = (await import("../db.js")) as DbModule;
  const admin = (await import("./admin.js")) as AdminModule;
  const instance = { admin, db };
  booted.push(instance);
  return instance;
}

function participant(identity: string, userId?: string, backends?: BackendsModule) {
  return {
    identity,
    ...(userId && backends
      ? { metadata: backends.participantMetadataFor(userId) }
      : {}),
  };
}

function listedRooms(): string[] {
  return lk.listParticipants.mock.calls.map((call) => call[0] as string);
}

function removed(): string[] {
  return lk.removeParticipant.mock.calls.map((call) => call[1] as string);
}

async function unclaim(): Promise<void> {
  await pools[0]!.getPool().query(`UPDATE voice_resweeps SET claimed_until = 'epoch'`);
}

async function rows(): Promise<{ key: string; until: Date; claimed_until: Date }[]> {
  const result = await pools[0]!
    .getPool()
    .query<{ key: string; until: Date; claimed_until: Date }>(
      `SELECT key, until, claimed_until FROM voice_resweeps ORDER BY key`,
    );
  return result.rows;
}

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("SFU re-sweep claims across instances", () => {
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
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    lk.listRooms.mockReset().mockResolvedValue([]);
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.removeParticipant.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await pools[0]!.getPool().query(`TRUNCATE voice_resweeps`);
  });

  afterEach(async () => {
    for (const instance of booted) {
      await instance.admin.settleSfuEvictions();
      instance.admin.stopSfuResweeps();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    vi.restoreAllMocks();
  });

  it("an eviction writes one row per key and runs its first pass at once", async () => {
    const a = await bootInstance();
    await a.admin.evictSfuRoom("room-1");
    await a.admin.evictSfuRoom("room-1");
    await a.admin.evictSfuUser("user-1", ["room-1"], new Map());

    expect(listedRooms()).toEqual(["room-1", "room-1"]);
    const stored = await rows();
    expect(stored.map((row) => row.key)).toEqual(["room:room-1", "user:user-1"]);
    // Claimed by the writer for one window: the first pass just ran.
    for (const row of stored) {
      expect(row.claimed_until.getTime()).toBeGreaterThan(Date.now());
      expect(row.until.getTime()).toBeGreaterThan(Date.now() + 60_000);
    }
  });

  it("two instances ticking sweep each key exactly once per claim window", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    await a.admin.evictSfuRoom("room-1");
    await a.admin.evictSfuRoom("room-2");
    lk.listParticipants.mockClear();

    // Still claimed from the first pass: nobody sweeps.
    expect(await Promise.all([a.admin.tickSfuResweeps(), b.admin.tickSfuResweeps()])).toEqual([0, 0]);
    expect(listedRooms()).toEqual([]);

    await unclaim();
    const won = await Promise.all([a.admin.tickSfuResweeps(), b.admin.tickSfuResweeps()]);
    expect(won[0]! + won[1]!).toBe(2);
    expect(listedRooms().sort()).toEqual(["room-1", "room-2"]);

    // Claimed again for the window; a third tick on either side is a no-op.
    lk.listParticipants.mockClear();
    expect(await Promise.all([b.admin.tickSfuResweeps(), a.admin.tickSfuResweeps()])).toEqual([0, 0]);
    expect(listedRooms()).toEqual([]);
  });

  it("a claim survives a restart: a fresh module graph picks the row up", async () => {
    const a = await bootInstance();
    const backends = (await import("./backends.js")) as BackendsModule;
    await a.admin.evictSfuUser("banned", ["room-1"], new Map([["legacy-peer", "banned"]]));
    await a.admin.settleSfuEvictions();
    a.admin.stopSfuResweeps();
    await a.db.closePool();
    booted.length = 0;

    // The process that wrote the row is gone. The row is not.
    const c = await bootInstance();
    await unclaim();
    lk.listRooms.mockResolvedValue([{ name: "room-1" }]);
    lk.listParticipants.mockResolvedValue([
      // No metadata: only the identity hint that rode in `scope` can name them.
      participant("legacy-peer"),
      participant("peer-2", "innocent", backends),
    ]);

    expect(await c.admin.tickSfuResweeps()).toBe(1);
    expect(listedRooms()).toEqual(["room-1"]);
    expect(removed()).toEqual(["legacy-peer"]);
  });

  it("expired rows are deleted by the tick and never swept", async () => {
    const a = await bootInstance();
    await a.admin.evictSfuRoom("room-1");
    await pools[0]!.getPool().query(
      `UPDATE voice_resweeps SET until = NOW() - INTERVAL '1 second', claimed_until = 'epoch'`,
    );
    lk.listParticipants.mockClear();

    expect(await a.admin.tickSfuResweeps()).toBe(0);
    expect(listedRooms()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("with the flag off, nothing is written and the tick is a no-op", async () => {
    process.env.VOICE_REGISTRY = "off";
    const a = await bootInstance();
    await a.admin.evictSfuRoom("room-1");
    await a.admin.evictSfuUser("user-1", ["room-1"], new Map());

    expect(await rows()).toEqual([]);
    expect(await a.admin.tickSfuResweeps()).toBe(0);
    // The first pass still ran, on the in-process path.
    expect(listedRooms()).toEqual(["room-1"]);
  });
});
