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
});
