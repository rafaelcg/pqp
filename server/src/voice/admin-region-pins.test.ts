import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * With the voice registry on, a room's region is read from `voice_rooms`, so
 * the API instance that did NOT see the join (and so has no in-process pin)
 * still asks only the box the room lives on. Real Postgres on
 * `TEST_DATABASE_URL`; the LiveKit SDK is the one thing mocked, and each box
 * gets its own fake so "which box was called" is the assertion. Skips without
 * a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const lk = vi.hoisted(() => ({
  boxes: new Map<string, { listParticipants: (room: string) => Promise<unknown>; calls: number }>(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      private readonly host: string;
      constructor(host: string) {
        this.host = host;
        if (!lk.boxes.has(host)) {
          lk.boxes.set(host, {
            calls: 0,
            listParticipants: () =>
              Promise.reject(
                Object.assign(new Error("requested room does not exist"), { status: 404 }),
              ),
          });
        }
      }
      listParticipants(room: string) {
        const box = lk.boxes.get(this.host)!;
        box.calls += 1;
        return box.listParticipants(room);
      }
    },
  };
});

type AdminModule = typeof import("./admin.js");
type DbModule = typeof import("../db.js");
type RegistryModule = typeof import("./registry.js");

const HOME = "wss://sfu.example.test";
const MIA = "wss://sfu-mia.example.test";
const LHR = "wss://sfu-lhr.example.test";

let db: DbModule;
let admin: AdminModule;
let registry: RegistryModule;

async function insertRoom(channelId: string, region: string | null): Promise<void> {
  await db
    .getPool()
    .query(`INSERT INTO voice_rooms (channel_id, transport, sfu_region) VALUES ($1, 'livekit', $2)`, [
      channelId,
      region,
    ]);
}

function asked(host: string): number {
  return lk.boxes.get(host)?.calls ?? 0;
}

describeDb("SFU moderation reads a room's region from the registry", () => {
  beforeAll(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.LIVEKIT_URL = HOME;
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = `mia:${MIA},lhr:${LHR}`;
    vi.resetModules();
    db = (await import("../db.js")) as DbModule;
    await db.initDb();
    admin = (await import("./admin.js")) as AdminModule;
    registry = (await import("./registry.js")) as RegistryModule;
  });

  afterAll(async () => {
    delete process.env.VOICE_REGISTRY;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_REGIONS;
    await db.closePool().catch(() => {});
  });

  beforeEach(async () => {
    lk.boxes.clear();
    admin.resetSfuAdminClient();
    await db.getPool().query(`DELETE FROM voice_rooms`);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readVoiceRoomRegions answers a region, a home row and no row differently", async () => {
    const mia = randomUUID();
    const home = randomUUID();
    const absent = randomUUID();
    await insertRoom(mia, "mia");
    await insertRoom(home, null);

    const pins = await registry.readVoiceRoomRegions([mia, home, absent, "not-a-uuid"]);

    expect(pins.get(mia)).toBe("mia");
    expect(pins.has(home)).toBe(true);
    expect(pins.get(home)).toBeNull();
    expect(pins.has(absent)).toBe(false);
    expect(pins.has("not-a-uuid")).toBe(false);
    expect(await registry.readVoiceRoomRegions([])).toEqual(new Map());
  });

  it("asks only Miami about a room the registry says is in Miami", async () => {
    const room = randomUUID();
    await insertRoom(room, "mia");

    await admin.setSfuUserMuted(room, "user-1", true, new Map());

    expect(asked(MIA)).toBe(1);
    expect(asked(HOME)).toBe(0);
    expect(asked(LHR)).toBe(0);
  });

  it("asks only the home box about a row with no region", async () => {
    const room = randomUUID();
    await insertRoom(room, null);

    await admin.setSfuUserMuted(room, "user-1", true, new Map());

    expect(asked(HOME)).toBe(1);
    expect(asked(MIA)).toBe(0);
    expect(asked(LHR)).toBe(0);
  });

  it("stamps the region into the re-sweep row, and a re-sweep then trusts it instead of reading the registry", async () => {
    const room = randomUUID();
    await db.getPool().query(`DELETE FROM voice_resweeps`);

    // The caller read the pin before the last peer left; the registry has no row any more.
    await admin.evictSfuRoom(room, "sao");
    await admin.settleSfuEvictions();

    const stored = await db
      .getPool()
      .query<{ scope: { regions?: string[] } }>(`SELECT scope FROM voice_resweeps WHERE key = $1`, [
        `room:${room}`,
      ]);
    expect(stored.rows[0]!.scope.regions).toEqual(["sao"]);
    expect([asked(HOME), asked(MIA), asked(LHR)]).toEqual([1, 0, 0]);

    // The room is re-pinned to Miami while the window is still open. The pre-eviction
    // tokens point at the box the room was on, so the repeat still asks only that one.
    await insertRoom(room, "mia");
    await db.getPool().query(`UPDATE voice_resweeps SET claimed_until = 'epoch'`);
    await admin.tickSfuResweeps();
    await admin.settleSfuEvictions();

    expect([asked(HOME), asked(MIA), asked(LHR)]).toEqual([2, 0, 0]);
    admin.stopSfuResweeps();
    await db.getPool().query(`DELETE FROM voice_resweeps`);
  });

  it("asks every box about a room with no row, and about a name that cannot be one", async () => {
    await admin.setSfuUserMuted(randomUUID(), "user-1", true, new Map());
    expect([asked(HOME), asked(MIA), asked(LHR)]).toEqual([1, 1, 1]);

    lk.boxes.clear();
    admin.resetSfuAdminClient();
    await admin.setSfuUserMuted("not-a-uuid", "user-1", true, new Map());
    expect([asked(HOME), asked(MIA), asked(LHR)]).toEqual([1, 1, 1]);
  });
});
