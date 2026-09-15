import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * ONE STATUS SAMPLE A MINUTE MEANS ONE, on a real Postgres.
 *
 * The timers at the top of `index.ts` run on every process that loads the
 * file. With two API machines that was two `status_samples` rows a minute,
 * and because those rows are AVERAGED into the uptime figure, one machine
 * failing a probe while the other passed read as a service that was half up.
 * A number that looks measured and is not is worse than no number.
 *
 * Two halves are pinned here. The lease itself, exercised from two claimants
 * (which is what two machines are, since the row is the only state either of
 * them has); and the gate in the entry point, read from the source the way
 * `ws/heartbeat.test.ts` reads it — because the bug being prevented is
 * "somebody adds a second copy of the timer", and only the entry point can
 * show that.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { claimSingletonTick, claimSingletonTickOrRun } = await import(
  "./singleton-lease.js"
);

describeDb("singleton lease", () => {
  let key = "";

  beforeEach(async () => {
    await initDb();
    key = `test.${randomUUID()}`;
  });

  afterAll(async () => {
    await closePool();
  });

  it("hands the tick to exactly one of two instances", async () => {
    const a = await claimSingletonTick(key, 55_000, "instance-a");
    const b = await claimSingletonTick(key, 55_000, "instance-b");
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it("refuses every further claim inside the lease", async () => {
    await claimSingletonTick(key, 55_000, "instance-a");
    const rest = await Promise.all([
      claimSingletonTick(key, 55_000, "instance-a"),
      claimSingletonTick(key, 55_000, "instance-b"),
      claimSingletonTick(key, 55_000, "instance-c"),
    ]);
    expect(rest).toEqual([false, false, false]);
  });

  it("hands the NEXT tick out once the lease has expired", async () => {
    await claimSingletonTick(key, 55_000, "instance-a");
    // Expiring the row is exactly equivalent to waiting: the predicate is
    // `claimed_until < NOW()` and nothing else.
    await getPool().query(
      `UPDATE singleton_leases SET claimed_until = NOW() - INTERVAL '1 second'
        WHERE key = $1`,
      [key],
    );
    expect(await claimSingletonTick(key, 55_000, "instance-b")).toBe(true);
    // ...and the machine that had it last does not get it back for free.
    expect(await claimSingletonTick(key, 55_000, "instance-a")).toBe(false);
  });

  it("gives the tick to one claimant under a simultaneous race", async () => {
    const winners = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimSingletonTick(key, 55_000, `instance-${i}`),
      ),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
  });

  it("records who holds it", async () => {
    await claimSingletonTick(key, 55_000, "instance-a");
    const row = await getPool().query<{ claimed_by: string }>(
      `SELECT claimed_by FROM singleton_leases WHERE key = $1`,
      [key],
    );
    expect(row.rows[0]?.claimed_by).toBe("instance-a");
  });

  it("fails OPEN so a sample is never silently skipped", async () => {
    // A hole in the uptime history can never be filled in afterwards; a
    // duplicate row is noise. The wrapper picks noise.
    await closePool();
    await expect(claimSingletonTickOrRun(key, 55_000)).resolves.toBe(true);
    await initDb();
  });
});

describe("the status sampler runs on one process", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8",
  );

  it("claims a lease before writing a sample", () => {
    expect(source).toMatch(
      /claimSingletonTickOrRun\(\s*STATUS_SAMPLE_LEASE_KEY/,
    );
    expect(source).toMatch(/claimSingletonTickOrRun\(\s*STATUS_PRUNE_LEASE_KEY/);
  });

  it("gates on servesTraffic and NOT on runsColdJobs", () => {
    // The `api` probe in services/status.ts answers `ok: true` because
    // reaching it means the API is serving. On `pqp-worker` that sentence is
    // false, so this job is the one periodic job that must not move to
    // jobs.ts. If somebody "tidies" it into the cold jobs, this fails.
    const sampler = source.slice(
      source.indexOf("const statusSampler = setInterval"),
      source.indexOf("statusSampler.unref"),
    );
    expect(sampler).toContain("servesTraffic(processRole())");
    expect(sampler).not.toContain("runsColdJobs");
  });

  it("has exactly one status sampler timer", () => {
    expect(source.match(/recordStatusSamples\(\)/g)).toHaveLength(1);
    expect(source.match(/pruneStatusSamples\(\)/g)).toHaveLength(1);
  });
});
