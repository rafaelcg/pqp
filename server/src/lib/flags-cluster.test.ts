import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A flip on one instance, seen by its sibling, over REAL Postgres
 * LISTEN/NOTIFY. Two module graphs (`vi.resetModules()`, the technique
 * `permission-caches-cluster.test.ts` uses), each with its own copy of the
 * flag snapshot, its own pool and its own `INSTANCE_ID`, each with its own
 * `createPostgresBusTransport` on the same database.
 *
 * The TTL is set to ten minutes on purpose: if the sibling sees the flip in
 * well under a second, the bus did it, not the timer. The last case turns the
 * bus off on one side and shows the TTL is still the backstop.
 *
 * `flags-two-process.test.ts` does the same with two real API processes.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

type FlagsModule = typeof import("./flags.js");
type BusModule = typeof import("./bus.js");
type DbModule = typeof import("../db.js");

interface Instance {
  flags: FlagsModule;
  bus: BusModule;
  db: DbModule;
  close: () => Promise<void>;
}

async function bootInstance({ withBus }: { withBus: boolean }): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("./bus.js")) as BusModule;
  const busPostgres = await import("./bus-postgres.js");
  const db = (await import("../db.js")) as DbModule;
  const flags = (await import("./flags.js")) as FlagsModule;
  let transport: ReturnType<typeof busPostgres.createPostgresBusTransport> | null = null;
  if (withBus) {
    transport = busPostgres.createPostgresBusTransport(DATABASE_URL);
    bus.setBusTransport(transport);
    await transport.whenConnected();
  }
  await flags.startFeatureFlags();
  return {
    flags,
    bus,
    db,
    close: async () => {
      await bus.closeBus();
      await db.closePool().catch(() => {});
    },
  };
}

describeDb("runtime flags across two instances", () => {
  const booted: Instance[] = [];

  afterEach(async () => {
    while (booted.length > 0) {
      await booted.pop()!.close();
    }
    delete process.env.FEATURE_FLAGS_TTL_MS;
    delete process.env.LIVE_HLS_CAMERA_480;
  });

  afterAll(async () => {
    const { closePool } = await import("../db.js");
    await closePool().catch(() => {});
  });

  async function fresh(): Promise<void> {
    vi.resetModules();
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(`TRUNCATE feature_flags, feature_flag_overrides, feature_flag_audit`);
    await db.closePool();
  }

  it("a flip on A is answered by B within one bus round trip, not a TTL", async () => {
    await fresh();
    process.env.FEATURE_FLAGS_TTL_MS = String(10 * 60_000);
    const a = await bootInstance({ withBus: true });
    booted.push(a);
    const b = await bootInstance({ withBus: true });
    booted.push(b);
    expect(a.bus.INSTANCE_ID).not.toBe(b.bus.INSTANCE_ID);

    expect(b.flags.isEnabled("live_hls_camera_480")).toBe(true);
    const flippedAt = Date.now();
    await a.flags.setGlobalFlag("live_hls_camera_480", false, { kind: "dashboard" });
    // A answers from its own reload before the write returns.
    expect(a.flags.isEnabled("live_hls_camera_480")).toBe(false);
    await vi.waitFor(
      () => expect(b.flags.isEnabled("live_hls_camera_480")).toBe(false),
      { timeout: 2_000, interval: 5 },
    );
    expect(Date.now() - flippedAt).toBeLessThan(2_000);
    expect(b.flags.featureFlagCacheStats().busInvalidations).toBe(1);

    // And back: clearing the row returns both to the variable's default.
    await a.flags.setGlobalFlag("live_hls_camera_480", null, { kind: "dashboard" });
    await vi.waitFor(
      () => expect(b.flags.resolveFlag("live_hls_camera_480").source).toBe("default"),
      { timeout: 2_000, interval: 5 },
    );
    expect(b.flags.isEnabled("live_hls_camera_480")).toBe(true);
  });

  it("a per-server override crosses too, and only for that server", async () => {
    await fresh();
    process.env.FEATURE_FLAGS_TTL_MS = String(10 * 60_000);
    const a = await bootInstance({ withBus: true });
    booted.push(a);
    const b = await bootInstance({ withBus: true });
    booted.push(b);
    const pool = a.db.getPool();
    await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk-flags-cluster', 'Dona') RETURNING id`,
    );
    const servers = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Um', $1), ('Dois', $1) RETURNING id`,
      [owner.rows[0]!.id],
    );
    const [one, two] = servers.rows.map((row) => row.id);

    await a.flags.setGlobalFlag("watch_party_waitlist", true, { kind: "dashboard" });
    await a.flags.setServerFlagOverride("watch_party_waitlist", one!, false, {
      kind: "dashboard",
    });
    await vi.waitFor(
      () =>
        expect(b.flags.isEnabled("watch_party_waitlist", { serverId: one })).toBe(false),
      { timeout: 2_000, interval: 5 },
    );
    expect(b.flags.isEnabled("watch_party_waitlist", { serverId: two })).toBe(true);
    expect(b.flags.isEnabled("watch_party_waitlist")).toBe(true);
  });

  it("with the bus off on B, B still converges, a TTL late", async () => {
    await fresh();
    process.env.FEATURE_FLAGS_TTL_MS = "300";
    const a = await bootInstance({ withBus: true });
    booted.push(a);
    const b = await bootInstance({ withBus: false });
    booted.push(b);

    await a.flags.setGlobalFlag("turn_prefer_static", true, { kind: "dashboard" });
    // Nothing told B: until its snapshot is a TTL old it answers the old value.
    expect(b.flags.isEnabled("turn_prefer_static")).toBe(false);
    expect(b.flags.featureFlagCacheStats().busInvalidations).toBe(0);
    await vi.waitFor(() => expect(b.flags.isEnabled("turn_prefer_static")).toBe(true), {
      timeout: 3_000,
      interval: 20,
    });
  });
});
