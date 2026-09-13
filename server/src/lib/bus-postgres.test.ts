import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BusFrame } from "./bus.js";

/**
 * The Postgres transport against a real Postgres, because the two things that
 * can only be wrong against a real one are the two things that matter: NOTIFY
 * comes back to the session that sent it, and it refuses payloads at 8000
 * bytes — which our frames genuinely exceed.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database, same as
 * services/access.test.ts.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { createPostgresBusTransport } = await import("./bus-postgres.js");
const { dbTxByPath, resetDbTxMetrics } = await import("./db-tx-metrics.js");

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a bus frame");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeDb("postgres cluster bus", () => {
  /**
   * A topic nobody else is using: the NOTIFY channel is global to the database,
   * so a `pnpm dev` server pointed at the same one is on this bus too.
   */
  const topic = `test.${randomUUID()}`;
  let alpha: ReturnType<typeof createPostgresBusTransport>;
  let beta: ReturnType<typeof createPostgresBusTransport>;
  const onAlpha: BusFrame[] = [];
  const onBeta: BusFrame[] = [];

  beforeAll(async () => {
    // Creates cluster_bus_payloads, which the oversize path writes to.
    await initDb();
    alpha = createPostgresBusTransport(DATABASE_URL);
    beta = createPostgresBusTransport(DATABASE_URL);
    alpha.onFrame((frame) => {
      if (frame.topic === topic) {
        onAlpha.push(frame);
      }
    });
    beta.onFrame((frame) => {
      if (frame.topic === topic) {
        onBeta.push(frame);
      }
    });
    await Promise.all([alpha.whenConnected(), beta.whenConnected()]);
  });

  afterAll(async () => {
    await alpha.close();
    await beta.close();
    await closePool();
  });

  it("delivers a frame to the other instance — and back to the sender", async () => {
    // The echo is not a quirk to work around, it is why `bus.ts` filters on
    // origin. A transport that hid it would hide the bug.
    alpha.publish({ origin: "instance-alpha", topic, data: { n: 1 } });

    await waitFor(() => onBeta.length >= 1 && onAlpha.length >= 1);
    expect(onBeta[0]).toEqual({ origin: "instance-alpha", topic, data: { n: 1 } });
    expect(onAlpha[0]?.origin).toBe("instance-alpha");
  });

  it("carries a payload far larger than the NOTIFY limit", async () => {
    // 8000 bytes is where NOTIFY refuses outright; a 4000-character message
    // body plus a webhook's embeds gets past that in normal use.
    const body = "x".repeat(40_000);
    const before = onBeta.length;

    beta.publish({ origin: "instance-beta", topic, data: { body } });

    await waitFor(() => onBeta.length > before);
    const frame = onBeta[onBeta.length - 1];
    expect((frame?.data as { body: string }).body).toHaveLength(40_000);

    // Proof it actually took the spill path rather than fitting inline.
    const spilled = await getPool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM cluster_bus_payloads`,
    );
    expect(Number(spilled.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it("survives a notification that is not a bus frame", async () => {
    // Anything may NOTIFY this channel; a parse failure must not take the
    // listener down with it.
    await getPool().query(`SELECT pg_notify('pqp_cluster', 'not json at all')`);
    await getPool().query(
      `SELECT pg_notify('pqp_cluster', '{"topic":"x"}')`, // no origin
    );
    const before = onBeta.length;

    alpha.publish({ origin: "instance-alpha", topic, data: { n: 2 } });

    await waitFor(() => onBeta.length > before);
    expect((onBeta[onBeta.length - 1]?.data as { n: number }).n).toBe(2);
  });

  it("drops frames instead of throwing once closed", async () => {
    const closed = createPostgresBusTransport(DATABASE_URL);
    await closed.whenConnected();
    await closed.close();

    expect(() =>
      closed.publish({ origin: "instance-gone", topic, data: { n: 3 } }),
    ).not.toThrow();
  });

  it("sends a light burst as individual NOTIFYs, unchanged", async () => {
    resetDbTxMetrics();
    const before = onBeta.length;

    // Five frames, well under NOTIFY_BATCH_THRESHOLD: no batching, no added
    // latency, one `pg_notify` per frame — the pre-existing behaviour.
    for (let i = 0; i < 5; i++) {
      alpha.publish({ origin: "instance-alpha", topic, data: { n: 100 + i } });
    }

    await waitFor(() => onBeta.length >= before + 5);
    expect((dbTxByPath()["bus.publish"] ?? 0)).toBeGreaterThanOrEqual(5);
    expect(dbTxByPath()["bus.publishBatch"] ?? 0).toBe(0);
    expect(
      onBeta.slice(-5).map((f) => (f.data as { n: number }).n),
    ).toEqual([100, 101, 102, 103, 104]);
  });

  it("batches a burst above the threshold into one NOTIFY, order preserved", async () => {
    resetDbTxMetrics();
    const before = onBeta.length;

    // 30 frames in a tight loop: comfortably over NOTIFY_BATCH_THRESHOLD (20)
    // inside one NOTIFY_BATCH_WINDOW_MS (50ms) window.
    const n = 30;
    for (let i = 0; i < n; i++) {
      alpha.publish({ origin: "instance-alpha", topic, data: { n: i } });
    }

    await waitFor(() => onBeta.length >= before + n, 2_000);

    const received = onBeta.slice(-n).map((f) => (f.data as { n: number }).n);
    // Ordering is exact, whichever frames rode in the batch and whichever
    // went out immediately before the threshold tripped.
    expect(received).toEqual(Array.from({ length: n }, (_, i) => i));

    // Fewer round trips than frames: the whole point of batching. At most
    // NOTIFY_BATCH_THRESHOLD immediate sends plus one batched envelope for
    // the rest, against 30 frames.
    const publishCalls = dbTxByPath()["bus.publish"] ?? 0;
    const batchCalls = dbTxByPath()["bus.publishBatch"] ?? 0;
    expect(publishCalls + batchCalls).toBeLessThan(n);
    expect(batchCalls).toBeGreaterThanOrEqual(1);
  });

  it("spills a batch envelope that itself exceeds the inline cap, and delivers every item", async () => {
    // Same burst shape as the test above, but each frame is fat enough that
    // the whole `{batch:[...]}` envelope blows past MAX_INLINE_BYTES (7000):
    // this must take the spill path exactly as a single oversize frame does,
    // and the receiver's isBatchEnvelope check runs on the *fetched* payload,
    // not just the inline notification, so every item still arrives.
    resetDbTxMetrics();
    const spilledBefore = (
      await getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM cluster_bus_payloads`,
      )
    ).rows[0]?.count;
    const before = onBeta.length;
    // The first NOTIFY_BATCH_THRESHOLD (20) frames in the window still go out
    // individually; only what crosses the threshold rides in the batch. 50
    // frames leaves ~30 of them in the batched tail, comfortably enough at
    // this body size to push the envelope itself past MAX_INLINE_BYTES (7000).
    const n = 50;
    const body = "y".repeat(400);
    for (let i = 0; i < n; i++) {
      alpha.publish({ origin: "instance-alpha", topic, data: { n: i, body } });
    }

    await waitFor(() => onBeta.length >= before + n, 2_000);
    const received = onBeta.slice(-n).map((f) => (f.data as { n: number }).n);
    expect(received).toEqual(Array.from({ length: n }, (_, i) => i));

    const spilledAfter = (
      await getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM cluster_bus_payloads`,
      )
    ).rows[0]?.count;
    expect(Number(spilledAfter)).toBeGreaterThan(Number(spilledBefore ?? 0));
  });

  it("keeps delivering the rest of a batch when one item's handler throws", async () => {
    // A batch is delivered item-by-item through the same call a single frame
    // uses, which isolates a throwing handler exactly like `bus.ts`'s own
    // dispatch does for ordinary frames — one bad item must not cost its
    // neighbours their delivery. A dedicated transport pair with its own
    // (deliberately misbehaving) handler, so this doesn't disturb `beta`'s
    // handler shared by every other test in this file.
    const gamma = createPostgresBusTransport(DATABASE_URL);
    const delta = createPostgresBusTransport(DATABASE_URL);
    const badTopic = `test.bad.${randomUUID()}`;
    const seen: number[] = [];
    delta.onFrame((frame) => {
      if (frame.topic !== badTopic) {
        return;
      }
      const n = (frame.data as { n: number }).n;
      seen.push(n);
      if (n === 15) {
        throw new Error("boom");
      }
    });

    const consoleError = console.error;
    console.error = () => {};
    try {
      await Promise.all([gamma.whenConnected(), delta.whenConnected()]);
      const n = 30;
      for (let i = 0; i < n; i++) {
        gamma.publish({ origin: "instance-gamma", topic: badTopic, data: { n: i } });
      }
      await waitFor(() => seen.length >= n, 2_000);
      expect(seen).toEqual(Array.from({ length: n }, (_, i) => i));
    } finally {
      console.error = consoleError;
      await gamma.close();
      await delta.close();
    }
  });
});
