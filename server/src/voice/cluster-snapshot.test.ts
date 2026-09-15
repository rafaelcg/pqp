import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * TWO MACHINES, ONE DASHBOARD, on a real Postgres with the registry on.
 *
 * Every live counter on `GET /api/admin/metrics` — sockets, voice peers, HLS
 * sessions, pool — is a property of the process that answered. That was the
 * whole truth while one machine answered everything. Behind two, the operator
 * sees whichever machine the load balancer picked, refreshing flips between
 * two halves of the answer, and nothing on the page says so. During the
 * MoonKase spike that is the difference between "we are at 200 sockets" and
 * "we are at 400".
 *
 * The snapshot rides on the heartbeat that already exists, so what is worth
 * pinning is: that a beat writes it, that the read SUMS live instances, that
 * an expired lease is excluded rather than silently added, that a row with no
 * snapshot is counted but contributes nothing, and that the beat feeds back
 * the instance count the divided limiters divide by.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.VOICE_REGISTRY = "postgres";
}

const { getPool, initDb, closePool } = await import("../db.js");
const { heartbeatVoiceInstance, readClusterSnapshot } = await import(
  "./registry.js"
);
const { registerInstanceSnapshot, resetInstanceSnapshot } = await import(
  "../lib/instance-snapshot.js"
);
const { liveInstanceCount, resetLiveInstanceCount } = await import(
  "../lib/cluster-rate-limit.js"
);
const { getAdminMetrics, resetAdminMetricsCache } = await import(
  "../services/metrics.js"
);

function snapshot(over: Partial<Record<string, unknown>> = {}) {
  return {
    sockets: 100,
    compressedSockets: 90,
    voiceParticipants: 10,
    hlsSessions: 1,
    poolBusy: 3,
    poolMax: 10,
    role: "api",
    version: "abc123",
    ...over,
  };
}

describeDb("cluster snapshot", () => {
  beforeEach(async () => {
    await initDb();
    await getPool().query(`DELETE FROM voice_instances`);
    resetInstanceSnapshot();
    resetLiveInstanceCount();
  });

  afterAll(async () => {
    resetInstanceSnapshot();
    await closePool();
  });

  it("sums the live instances instead of showing one of them", async () => {
    const a = randomUUID();
    const b = randomUUID();
    registerInstanceSnapshot(() => snapshot() as never);
    await heartbeatVoiceInstance(a, "hash");
    registerInstanceSnapshot(
      () => snapshot({ sockets: 40, voiceParticipants: 7, hlsSessions: 2 }) as never,
    );
    await heartbeatVoiceInstance(b, "hash");

    const cluster = await readClusterSnapshot();
    expect(cluster.instances).toBe(2);
    expect(cluster.reporting).toBe(2);
    expect(cluster.sockets).toBe(140);
    expect(cluster.voiceParticipants).toBe(17);
    expect(cluster.hlsSessions).toBe(3);
    expect(cluster.poolMax).toBe(20);
  });

  it("leaves a dead instance out of the total", async () => {
    const alive = randomUUID();
    const dead = randomUUID();
    registerInstanceSnapshot(() => snapshot() as never);
    await heartbeatVoiceInstance(alive, "hash");
    await heartbeatVoiceInstance(dead, "hash");
    // The lease is what says a machine is alive; a row whose heartbeat has
    // aged past the TTL is a machine that is gone, and adding its sockets to
    // the total would be the same bug in the other direction.
    await getPool().query(
      `UPDATE voice_instances SET heartbeat_at = NOW() - INTERVAL '5 minutes'
        WHERE instance_id = $1`,
      [dead],
    );

    const cluster = await readClusterSnapshot();
    expect(cluster.instances).toBe(1);
    expect(cluster.sockets).toBe(100);
  });

  it("counts an instance that reports nothing, and says it did not report", async () => {
    const withSnap = randomUUID();
    const without = randomUUID();
    registerInstanceSnapshot(() => snapshot() as never);
    await heartbeatVoiceInstance(withSnap, "hash");
    // The worker holds no sockets and registers no provider; so does any
    // process that has not beaten since the column was added. `reporting` is
    // what stops the sum from being read as a total when it is a floor.
    resetInstanceSnapshot();
    await heartbeatVoiceInstance(without, "hash");

    const cluster = await readClusterSnapshot();
    expect(cluster.instances).toBe(2);
    expect(cluster.reporting).toBe(1);
    expect(cluster.sockets).toBe(100);
  });

  it("shows a half-rolled deploy instead of averaging over it", async () => {
    registerInstanceSnapshot(() => snapshot({ version: "old" }) as never);
    await heartbeatVoiceInstance(randomUUID(), "hash");
    registerInstanceSnapshot(() => snapshot({ version: "new" }) as never);
    await heartbeatVoiceInstance(randomUUID(), "hash");

    const cluster = await readClusterSnapshot();
    expect(cluster.versions).toEqual(["new", "old"]);
  });

  it("feeds the live instance count the divided limiters divide by", async () => {
    registerInstanceSnapshot(() => snapshot() as never);
    await heartbeatVoiceInstance(randomUUID(), "hash");
    await heartbeatVoiceInstance(randomUUID(), "hash");
    // Read back on the beat itself, so no limiter ever has to make a query of
    // its own on a hot path. One statement older than the beat it rode with,
    // hence the floor of 1 in `noteLiveInstanceCount`.
    expect(liveInstanceCount()).toBeGreaterThanOrEqual(1);
    await heartbeatVoiceInstance(randomUUID(), "hash");
    expect(liveInstanceCount()).toBe(2);
  });

  it("puts the sum on the dashboard beside the local reading", async () => {
    registerInstanceSnapshot(() => snapshot({ sockets: 60 }) as never);
    await heartbeatVoiceInstance(randomUUID(), "hash");
    await heartbeatVoiceInstance(randomUUID(), "hash");
    resetAdminMetricsCache();

    const metrics = await getAdminMetrics();
    // Which machine answered, and how many there are. Without the first the
    // operator cannot tell a refresh that moved from a refresh that landed
    // somewhere else.
    expect(metrics.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metrics.instanceCount).toBe(2);
    expect(metrics.cluster.instances).toBe(2);
    expect(metrics.cluster.reporting).toBe(2);
    expect(metrics.cluster.sockets).toBe(120);
    // The local block is untouched: "is THIS machine in trouble" is a
    // different question with a different answer, and both are on the page.
    expect(metrics.runtime.sockets).toBe(0);
  }, 30_000);

  it("survives a snapshot provider that throws", async () => {
    registerInstanceSnapshot(() => {
      throw new Error("pool exploded");
    });
    // A heartbeat that throws is a machine that looks dead to every other
    // machine's reconcile. Decoration must never cost the lease.
    await expect(
      heartbeatVoiceInstance(randomUUID(), "hash"),
    ).resolves.toBeUndefined();
  });
});
