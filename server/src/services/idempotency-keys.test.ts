import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Idempotent room creation, pinned at the service `createServer` actually
 * calls: a repeated `Idempotency-Key` resolves to the same room instead of a
 * second one, two users never share a key's claim, a concurrent repeat
 * waits rather than racing past the check, and a client that sends no key
 * behaves exactly as before. `server/src/api/idempotent-create.test.ts`
 * covers the same guarantees through the real HTTP routes; this file is the
 * lower-level proof plus the one thing an HTTP test cannot see directly: the
 * 24h prune.
 */

// TEST_DATABASE_URL wins, see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const {
  claimServerIdempotencyKey,
  normalizeIdempotencyKey,
  peekServerIdempotencyKey,
  pruneExpiredServerIdempotencyKeys,
  recordServerIdempotencyKey,
} = await import("./idempotency-keys.js");

describeDb("server creation idempotency", () => {
  let owner: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    owner = await upsertUser({
      clerkId: "clerk_idem_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    other = await upsertUser({
      clerkId: "clerk_idem_other",
      displayName: "Other",
      avatarUrl: null,
    });
  });

  it("returns the same server for a repeated key", async () => {
    const key = "attempt-1";
    const first = await createServer("Casa", owner.id, key);
    const second = await createServer("Casa", owner.id, key);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.server.id).toBe(first.server.id);
    expect(second.channels.map((c) => c.id).sort()).toEqual(
      first.channels.map((c) => c.id).sort(),
    );

    const rows = await getPool().query(
      `SELECT id FROM servers WHERE owner_id = $1`,
      [owner.id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("gives two different users the same key independent servers", async () => {
    const key = "shared-key";
    const mine = await createServer("Casa do Owner", owner.id, key);
    const theirs = await createServer("Casa do Other", other.id, key);

    expect(mine.server.id).not.toBe(theirs.server.id);
    expect(mine.replayed).toBe(false);
    expect(theirs.replayed).toBe(false);
  });

  it("lets a retried create with no key make a second server, unchanged from before", async () => {
    const first = await createServer("Casa", owner.id);
    const second = await createServer("Casa", owner.id);

    expect(first.server.id).not.toBe(second.server.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
  });

  it("serializes a concurrent duplicate instead of racing it", async () => {
    const key = "race";
    const [a, b] = await Promise.all([
      createServer("Casa", owner.id, key),
      createServer("Casa", owner.id, key),
    ]);

    expect(a.server.id).toBe(b.server.id);
    // Exactly one of the two calls actually created the room.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    const rows = await getPool().query(
      `SELECT id FROM servers WHERE owner_id = $1`,
      [owner.id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("normalizes a blank, missing or absurdly long header to null", () => {
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey("")).toBeNull();
    expect(normalizeIdempotencyKey("   ")).toBeNull();
    expect(normalizeIdempotencyKey("a".repeat(500))).toBeNull();
    expect(normalizeIdempotencyKey(" real-key ")).toBe("real-key");
    // Node folds a repeated header into an array; the first value wins.
    expect(normalizeIdempotencyKey(["first", "second"])).toBe("first");
  });

  it("peek reads a claimed key's server without claiming it", async () => {
    const key = "peek-me";
    expect(await peekServerIdempotencyKey(owner.id, key)).toBeNull();

    const { server } = await createServer("Casa", owner.id, key);
    expect(await peekServerIdempotencyKey(owner.id, key)).toBe(server.id);
    // Peeking is read-only: a fresh claim still succeeds afterwards for a
    // key nobody has used yet.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const claim = await claimServerIdempotencyKey(client, owner.id, "unused");
      expect(claim.claimed).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("prunes keys older than 24h and leaves recent ones alone", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await claimServerIdempotencyKey(client, owner.id, "stale");
      await recordServerIdempotencyKey(client, owner.id, "stale", (
        await createServer("Casa", owner.id)
      ).server.id);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await getPool().query(
      `UPDATE server_create_idempotency_keys
         SET created_at = NOW() - INTERVAL '25 hours'
       WHERE user_id = $1 AND idempotency_key = 'stale'`,
      [owner.id],
    );
    await createServer("Casa fresca", owner.id, "fresh");

    const pruned = await pruneExpiredServerIdempotencyKeys();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const remaining = await getPool().query(
      `SELECT idempotency_key FROM server_create_idempotency_keys WHERE user_id = $1`,
      [owner.id],
    );
    expect(remaining.rows.map((r: { idempotency_key: string }) => r.idempotency_key)).toEqual([
      "fresh",
    ]);
  });
});
