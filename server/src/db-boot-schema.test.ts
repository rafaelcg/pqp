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

// A scratch database only. This suite re-applies the schema and rewrites
// `schema_boot_state`, so unlike the older suites it never falls back to a
// developer's DATABASE_URL; CI (CI=true, a throwaway Postgres service) is the
// one place DATABASE_URL is known to be disposable.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
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
  BOOT_UNGUARDED_DO_BLOCKS,
  BOOT_SCHEMA_BOUNDED_ATTEMPTS,
} = await import("./db.js");

const { poolWaitSnapshot, resetPoolWaitForTests } = await import("./lib/pool-wait.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "schema.sql"), "utf8");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

// --- forum channels --- the two newest `channels_type_check` blocks: the
// watch party one, which swallows every error, and the forum one, which must
// not (see the comment above it in schema.sql).
const DO_BLOCKS = SCHEMA.match(/^DO \$\$[\s\S]*?^END \$\$;/gm) ?? [];
const FORUM_TYPE_BLOCK = DO_BLOCKS.find(
  (block) => block.includes("channels_type_check") && block.includes("'forum'"),
);
const WATCH_PARTY_TYPE_BLOCK = DO_BLOCKS.find(
  (block) =>
    block.includes("channels_type_check") &&
    block.includes("'watch_party'") &&
    !block.includes("'forum'"),
);
const FORUM_TABLES = [
  "forum_posts",
  "forum_tags",
  "forum_post_tags",
  "forum_post_follows",
  "forum_settings",
  "webhook_forum_settings",
];
/**
 * A database that last ran the schema before forums: the type CHECK without
 * 'forum'. NOT VALID so it holds whatever rows other suites left behind.
 */
const PRE_FORUM_TYPE_CHECK = `
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
  ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'category', 'thread', 'watch_party')) NOT VALID;`;

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

  it("finds no unguarded row-writing DO block it was not told about", () => {
    // A `DO $$` block that writes rows without a `data_migrations` (or
    // catalog) check also ran on every boot. The column-0 scan above cannot
    // see inside one, so this does.
    const blocks = SCHEMA.match(/^DO \$\$[\s\S]*?^END \$\$;/gm) ?? [];
    expect(blocks.length).toBeGreaterThan(10);
    const guarded = /data_migrations|col_description|obj_description|information_schema|pg_constraint|pg_class|pg_attribute|pg_index|pg_type|pg_trigger|pg_proc/;
    const writes = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i;
    const unguarded = blocks.filter((block) => writes.test(block) && !guarded.test(block));
    for (const block of unguarded) {
      const listed = BOOT_UNGUARDED_DO_BLOCKS.some(({ marker }) => block.includes(marker));
      expect(listed, `unclassified row-writing DO block:\n${block.slice(0, 400)}`).toBe(true);
    }
    for (const { marker } of BOOT_UNGUARDED_DO_BLOCKS) {
      expect(unguarded.some((block) => block.includes(marker))).toBe(true);
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

  it("times every real checkout into runtime.poolWait (the production wiring, not the helper)", async () => {
    resetPoolWaitForTests();
    await getPool().query("SELECT 1");
    const client = await getPool().connect();
    client.release();
    const snapshot = poolWaitSnapshot();
    // One through `pool.query` (pg-pool's callback `connect`), one through
    // the promise `connect()` every transaction uses.
    expect(snapshot.lastMinute.checkouts).toBeGreaterThanOrEqual(2);
  });

  it("`always` re-runs the file on every boot (the rollback)", async () => {
    const result = await initDb({ mode: "always" });
    expect(result.outcome).toBe("applied");
  });

  // --- forum channels ---

  const typeCheckDef = async (): Promise<string> =>
    (
      await getPool().query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'channels'::regclass AND conname = 'channels_type_check'`,
      )
    ).rows[0]?.def ?? "";

  /** Everything the forum DDL defines, as text, to compare two runs. */
  const forumCatalog = async (): Promise<string> => {
    const columns = await getPool().query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name, ordinal_position`,
      [FORUM_TABLES],
    );
    const indexes = await getPool().query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1)
        ORDER BY tablename, indexname`,
      [FORUM_TABLES],
    );
    const constraints = await getPool().query(
      `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid::regclass::text = ANY($1) OR conname = 'channels_type_check'
        ORDER BY 1, 2`,
      [FORUM_TABLES],
    );
    return JSON.stringify([columns.rows, indexes.rows, constraints.rows]);
  };

  it("the forum DDL runs twice with no change, and the type CHECK carries 'forum'", async () => {
    await initDb({ mode: "always" });
    const first = await forumCatalog();
    for (const table of FORUM_TABLES) {
      expect(first, `${table} was not created`).toContain(`"table_name":"${table}"`);
    }
    expect(await typeCheckDef()).toContain("'forum'");
    await initDb({ mode: "always" });
    expect(await forumCatalog()).toBe(first);
  });

  it("the forum type block takes no lock when 'forum' is already allowed", async () => {
    expect(FORUM_TYPE_BLOCK, "forum channels_type_check block not found").toBeTruthy();
    expect(await typeCheckDef()).toContain("'forum'");
    // A reader holds `channels`. A block that DROPped and ADDed anyway would
    // queue behind it; this one checks the catalog and returns.
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM channels LIMIT 1");
    const client = await getPool().connect();
    try {
      await client.query("SET lock_timeout = '150ms'");
      await expect(client.query(FORUM_TYPE_BLOCK!)).resolves.toBeDefined();
    } finally {
      await client.query("SET lock_timeout = 0").catch(() => {});
      client.release();
      await other.query("ROLLBACK");
    }
  });

  it("the forum type block lets a lock timeout out, where the older blocks swallow it", async () => {
    // RECONCILE §1.2(c): `EXCEPTION WHEN others THEN NULL` turns a 55P03
    // under the boot's lock bound into "success", so `initDb` would record the
    // hash with a constraint still missing 'forum' and never retry.
    expect(FORUM_TYPE_BLOCK).toBeTruthy();
    expect(WATCH_PARTY_TYPE_BLOCK).toBeTruthy();
    await getPool().query(PRE_FORUM_TYPE_CHECK);
    expect(await typeCheckDef()).not.toContain("'forum'");

    await other.query("BEGIN");
    await other.query("SELECT 1 FROM channels LIMIT 1");
    const client = await getPool().connect();
    try {
      await client.query("SET lock_timeout = '150ms'");
      // The failure shape, so this test is known to test something: the old
      // block times out on the lock and reports nothing.
      await expect(client.query(WATCH_PARTY_TYPE_BLOCK!)).resolves.toBeDefined();
      // The forum block surfaces it, which is what makes `initDb` retry.
      await expect(client.query(FORUM_TYPE_BLOCK!)).rejects.toMatchObject({
        code: "55P03",
      });
      await other.query("ROLLBACK");
      await client.query("SET lock_timeout = 0");
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await typeCheckDef()).toContain("'forum'");
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await client.query("SET lock_timeout = 0").catch(() => {});
      client.release();
    }
  });

  it("skips the validation scan only when the constraint it replaces already proves it", async () => {
    const client = await getPool().connect();
    const validated = async () =>
      (
        await client.query<{ convalidated: boolean; def: string }>(
          `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'channels'::regclass AND conname = 'channels_type_check'`,
        )
      ).rows[0]!;
    try {
      // From a VALIDATED subset (what the watch party block leaves): every row
      // already passes, so the forum list goes on NOT VALID, with no scan.
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM channels WHERE type NOT IN ('text', 'voice', 'category', 'thread', 'watch_party')`,
      );
      await client.query(PRE_FORUM_TYPE_CHECK.replace(" NOT VALID", ""));
      expect((await validated()).convalidated).toBe(true);
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await validated()).toMatchObject({ convalidated: false });
      expect((await validated()).def).toContain("'forum'");
      await client.query("ROLLBACK");

      // From an unvalidated constraint, nothing is proven: it validates.
      await client.query("BEGIN");
      await client.query(PRE_FORUM_TYPE_CHECK);
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await validated()).toMatchObject({ convalidated: true });
      await client.query("ROLLBACK");

      // From a validated constraint written in another shape: its literals
      // are all on the list, but it allows anything else, so nothing is
      // proven and it validates.
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
        ALTER TABLE channels ADD CONSTRAINT channels_type_check
          CHECK (type <> 'voice' OR type = 'voice');`);
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await validated()).toMatchObject({ convalidated: true });
      await client.query("ROLLBACK");

      // A NULL in the list makes the old CHECK pass any type (NULL is not
      // false), so its literals prove nothing either.
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
        ALTER TABLE channels ADD CONSTRAINT channels_type_check
          CHECK (type IN ('text', 'voice', NULL));`);
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await validated()).toMatchObject({ convalidated: true });
      await client.query("ROLLBACK");

      // From a constraint that allows a type this list lacks (a rollback
      // image meeting a newer schema): it validates, so rows of that type
      // would keep the newer constraint in place.
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM channels WHERE type NOT IN ('text', 'voice', 'category', 'thread', 'watch_party')`,
      );
      await client.query(`
        ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
        ALTER TABLE channels ADD CONSTRAINT channels_type_check
          CHECK (type IN ('text', 'voice', 'category', 'thread', 'watch_party', 'gallery'));`);
      await client.query(FORUM_TYPE_BLOCK!);
      expect(await validated()).toMatchObject({ convalidated: true });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("a boot that hits lock timeouts on `channels` still ends with 'forum' in the type CHECK", async () => {
    // The whole file this time, from a database that predates forums, with a
    // reader holding `channels` through the first attempts. (Inside the file
    // the earlier ALTERs on `channels` meet the lock first, which is why the
    // test above runs the forum block on its own.)
    await getPool().query(PRE_FORUM_TYPE_CHECK);
    await getPool().query("UPDATE schema_boot_state SET schema_hash = 'stale' WHERE id = 1");
    await other.query("BEGIN");
    await other.query("SELECT 1 FROM channels LIMIT 1");
    const sleeps: number[] = [];
    try {
      const result = await initDb({
        lockTimeoutMs: 150,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) {
            await other.query("ROLLBACK");
          }
        },
      });
      expect(result.outcome).toBe("applied");
      expect(result.attempts).toBeGreaterThanOrEqual(3);
      expect(await typeCheckDef()).toContain("'forum'");
      const row = await getPool().query<{ schema_hash: string }>(
        "SELECT schema_hash FROM schema_boot_state WHERE id = 1",
      );
      expect(row.rows[0]?.schema_hash).toBe(schemaHash(SCHEMA));
    } finally {
      await other.query("ROLLBACK").catch(() => {});
    }
  });
});
