import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The status page, against a real database.
 *
 * Two things here are worth pinning down. The uptime arithmetic, because a
 * status page that overstates uptime is worse than no status page. And the
 * rule that a *disabled* component is not a failure — an instance with
 * attachments turned off is healthy, and getting that wrong would show every
 * self-hoster a permanent red banner.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  getStatusSummary,
  probeComponents,
  pruneStatusSamples,
  recordStatusSamples,
} = await import("./status.js");

/** Write a sample at a controlled age, which the recorder cannot do. */
async function seedSample(
  component: string,
  ok: boolean,
  hoursAgo: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO status_samples (component, ok, checked_at)
     VALUES ($1, $2, NOW() - ($3 || ' hours')::interval)`,
    [component, ok, hoursAgo],
  );
}

describeDb("status page", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE status_samples RESTART IDENTITY`);
  });

  it("probes the database for real", async () => {
    const results = await probeComponents();
    const database = results.find((r) => r.key === "database");
    expect(database?.ok).toBe(true);
    expect(database?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports an unconfigured component as disabled, not down", async () => {
    const summary = await getStatusSummary();
    const storage = summary.components.find((c) => c.key === "storage");
    // The suite runs without S3_* set.
    expect(storage?.state).toBe("disabled");
    // The headline must ignore it entirely — a self-hoster who never wanted
    // attachments is not having an outage.
    expect(summary.state).toBe("operational");
  });

  it("does not persist samples for disabled components", async () => {
    await recordStatusSamples();
    const rows = await getPool().query<{ component: string }>(
      `SELECT DISTINCT component FROM status_samples`,
    );
    const components = rows.rows.map((r) => r.component);
    expect(components).toContain("database");
    // A row a minute saying "still turned off" is noise, and its absence is
    // what keeps uptime scoped to when a component was meant to be running.
    expect(components).not.toContain("storage");
  });

  it("computes 24h and 7d uptime over the right windows", async () => {
    // 3 of 4 inside 24h; the 5th is older and must only affect the 7d figure.
    await seedSample("database", true, 1);
    await seedSample("database", true, 2);
    await seedSample("database", true, 3);
    await seedSample("database", false, 4);
    await seedSample("database", false, 48);

    const summary = await getStatusSummary();
    const database = summary.components.find((c) => c.key === "database");

    expect(database?.uptime24h).toBeCloseTo(0.75, 5);
    expect(database?.uptime7d).toBeCloseTo(0.6, 5);
  });

  it("ignores samples older than the 7 day window", async () => {
    await seedSample("database", true, 1);
    await seedSample("database", false, 24 * 8);

    const summary = await getStatusSummary();
    const database = summary.components.find((c) => c.key === "database");
    expect(database?.uptime7d).toBe(1);
  });

  it("reports null uptime for a component with no history", async () => {
    const summary = await getStatusSummary();
    const database = summary.components.find((c) => c.key === "database");
    expect(database?.uptime24h).toBeNull();
    expect(database?.uptime7d).toBeNull();
  });

  it("prunes samples past the retention window and keeps the rest", async () => {
    await seedSample("database", true, 1);
    await seedSample("database", true, 24 * 31);

    const deleted = await pruneStatusSamples();
    expect(deleted).toBe(1);

    const remaining = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM status_samples`,
    );
    expect(remaining.rows[0]?.count).toBe("1");
  });

  it("never reports anything about who uses the instance", async () => {
    const summary = await getStatusSummary();
    // This payload is served unauthenticated, so it is asserted structurally
    // rather than trusted to stay clean: the only keys allowed are the ones
    // below, and a component carries no free text at all.
    expect(Object.keys(summary).sort()).toEqual([
      "checkedAt",
      "components",
      "state",
    ]);
    for (const component of summary.components) {
      expect(Object.keys(component).sort()).toEqual(
        expect.arrayContaining(["key", "label", "state"]),
      );
      for (const key of Object.keys(component)) {
        expect([
          "key",
          "label",
          "state",
          "latencyMs",
          "uptime24h",
          "uptime7d",
        ]).toContain(key);
      }
    }
  });
});
