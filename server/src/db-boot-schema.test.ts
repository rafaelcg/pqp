import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Boot DDL against a real Postgres: the reason the API's pool hit 22 of 22
 * with 161 waiting on every rolling deploy (see the comment above `initDb` in
 * `db.ts`). `schema.sql` runs as one implicit transaction, and re-running it
 * when nothing changed still took ACCESS EXCLUSIVE on the busiest tables
 * until the whole file committed, while the sibling container served the
 * reconnect herd. These pin the three things the fix promises:
 *
 *  1. an unchanged schema takes no table lock a reader could queue behind;
 *  2. a run that does have to happen gives its locks back after
 *     `lock_timeout` and retries, instead of holding the tables it already
 *     altered while it waits for one more;
 *  3. `BOOT_SCHEMA_MODE=always` is the old behaviour, the rollback.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const {
  getPool,
  initDb,
  closePool,
  schemaHash,
  resolveBootSchemaMode,
  resolveBootSchemaLockTimeoutMs,
  BOOT_EVERY_TIME_SWEEPS,
  BOOT_ONE_SHOT_DML,
  BOOT_SCHEMA_BOUNDED_ATTEMPTS,
} = await import("./db.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "schema.sql"), "utf8");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("boot schema settings", () => {
  it("skips an unchanged schema by default; `always` is the rollback", () => {
    expect(resolveBootSchemaMode(undefined)).toBe("changed");
    expect(resolveBootSchemaMode("")).toBe("changed");
    expect(resolveBootSchemaMode("changed")).toBe("changed");
    expect(resolveBootSchemaMode(" ALWAYS ")).toBe("always");
    expect(resolveBootSchemaMode("nonsense")).toBe("changed");
  });

  it("bounds each lock wait at 2 s unless told otherwise; 0 lifts it", () => {
    expect(resolveBootSchemaLockTimeoutMs(undefined)).toBe(2_000);
    expect(resolveBootSchemaLockTimeoutMs("500")).toBe(500);
    expect(resolveBootSchemaLockTimeoutMs("0")).toBe(0);
    expect(resolveBootSchemaLockTimeoutMs("-1")).toBe(2_000);
    expect(resolveBootSchemaLockTimeoutMs("abc")).toBe(2_000);
  });

  it("lists every top-level DML statement in schema.sql as a sweep or a one-shot", () => {
    // A statement at column 0 runs on every boot that applies the file. With
    // unchanged boots skipped, one that keeps an invariant (rather than a
    // backfill that only needs to run once) must be in BOOT_EVERY_TIME_SWEEPS
    // or it silently stops running between schema changes.
    const statements: string[] = [];
    const lines = SCHEMA.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/^(UPDATE|DELETE|INSERT)\b/.test(lines[i]!)) {
        let text = "";
        for (let j = i; j < lines.length; j += 1) {
          text += `${lines[j]}\n`;
          if (lines[j]!.trimEnd().endsWith(";")) {
            break;
          }
        }
        statements.push(squash(text));
      }
    }
    expect(statements.length).toBeGreaterThan(0);
    const known = [...BOOT_EVERY_TIME_SWEEPS, ...BOOT_ONE_SHOT_DML].map(squash);
    for (const statement of statements) {
      expect(known, `unclassified boot DML: ${statement}`).toContain(statement);
    }
    // And nothing listed that the file no longer has.
    for (const listed of known) {
      expect(statements).toContain(listed);
    }
  });
});

describeDb("initDb on a real Postgres", () => {
  let other: pg.Client;

  beforeAll(async () => {
    await initDb({ mode: "always" });
    other = new pg.Client({ connectionString: DATABASE_URL });
    await other.connect();
  });

  afterAll(async () => {
    await other.end().catch(() => {});
    await closePool();
  });

  beforeEach(async () => {
    await other.query("ROLLBACK").catch(() => {});
  });

  it("records the hash of what it applied", async () => {
    await initDb({ mode: "always" });
    const row = await getPool().query<{ schema_hash: string }>(
      "SELECT schema_hash FROM schema_boot_state WHERE id = 1",
    );
    expect(row.rows[0]?.schema_hash).toBe(schemaHash(SCHEMA));
  });

  it("skips an unchanged schema, and still runs the every-boot sweeps", async () => {
    const result = await initDb();
    expect(result.outcome).toBe("skipped");
    expect(result.attempts).toBe(0);
  });

  it("an unchanged boot does not block behind a reader, nor block one", async () => {
    // A reader mid-transaction on `users`, as a reconnect herd's roster and
    // auth reads are. The old boot queued ACCESS EXCLUSIVE behind it and
    // made every later reader of `users` queue behind THAT.
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM users LIMIT 1");
    try {
      const started = Date.now();
      const result = await initDb();
      expect(result.outcome).toBe("skipped");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await other.query("ROLLBACK");
    }
  });

  it("re-applies when the stored hash differs", async () => {
    await getPool().query(
      "UPDATE schema_boot_state SET schema_hash = 'stale' WHERE id = 1",
    );
    const result = await initDb();
    expect(result.outcome).toBe("applied");
    const row = await getPool().query<{ schema_hash: string }>(
      "SELECT schema_hash FROM schema_boot_state WHERE id = 1",
    );
    expect(row.rows[0]?.schema_hash).toBe(schemaHash(SCHEMA));
  });

  it("gives its locks back and retries when a reader holds a table, instead of holding the rest", async () => {
    await getPool().query(
      "UPDATE schema_boot_state SET schema_hash = 'stale' WHERE id = 1",
    );
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM voice_peers LIMIT 1");

    // A third connection reads a table the DDL alters EARLY. While the DDL
    // is stuck on `voice_peers`, the old code held that table too: this
    // read would hang until the reader above let go. With lock_timeout the
    // DDL rolls back, and the read gets through between attempts.
    const third = new pg.Client({ connectionString: DATABASE_URL });
    await third.connect();
    const sleeps: number[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const boot = initDb({
        lockTimeoutMs: 150,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) {
            // Two attempts have now failed and rolled back: a reader of
            // `users` must get through at once.
            const readStarted = Date.now();
            await third.query("SELECT count(*) FROM users");
            expect(Date.now() - readStarted).toBeLessThan(1_000);
            await other.query("ROLLBACK");
            release();
          }
        },
      });
      const result = await boot;
      await released;
      expect(result.outcome).toBe("applied");
      expect(result.attempts).toBeGreaterThanOrEqual(3);
      expect(result.attempts).toBeLessThanOrEqual(BOOT_SCHEMA_BOUNDED_ATTEMPTS + 1);
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await third.end().catch(() => {});
    }
  });

  it("the old boot (always, unbounded) held `users` hostage while it waited on one reader of `voice_peers`", async () => {
    // The failure itself, so the test above is known to be testing something:
    // a re-run of an UNCHANGED schema, waiting on a reader of a table late in
    // the file, blocks every reader of a table early in the file.
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM voice_peers LIMIT 1");
    const third = new pg.Client({ connectionString: DATABASE_URL });
    await third.connect();
    try {
      const boot = initDb({ mode: "always", lockTimeoutMs: 0 });
      // Until the DDL is parked on its lock.
      for (let i = 0; i < 100; i += 1) {
        const waiting = await third.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%CREATE EXTENSION%'`,
        );
        if (waiting.rows[0]!.n > 0) break;
        await new Promise((done) => setTimeout(done, 20));
      }
      await third.query("SET lock_timeout = '300ms'");
      await expect(third.query("SELECT count(*) FROM users")).rejects.toMatchObject({
        code: "55P03",
      });
      await other.query("ROLLBACK");
      await expect(boot).resolves.toMatchObject({ outcome: "applied" });
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await third.end().catch(() => {});
    }
  });

  it("`always` re-runs the file on every boot (the rollback)", async () => {
    const result = await initDb({ mode: "always" });
    expect(result.outcome).toBe("applied");
  });
});
