/**
 * Vitest globalSetup for `PQP_TEST_DB_WORKERS=N` (N > 1): one database per
 * test worker, so the DB-backed suites can run N files at once.
 *
 * Why the suite was serial: every DB-backed file truncates the tables it
 * touches, so two files on ONE database race. They never race on two
 * databases, and a database is the unit Postgres isolates completely (rows,
 * advisory locks, LISTEN/NOTIFY channels, the schema hash `initDb` keys on).
 * So instead of one shared `pqp` this creates `pqp_w1` .. `pqp_wN` beside it,
 * fresh each run, and `worker-database-env.ts` points each worker at its own.
 *
 * Off unless asked for. A developer's `pnpm test` stays serial on the one
 * database it always used; CI opts in (`.github/workflows/ci.yml`).
 */
import pg from "pg";

export function workerCount(): number {
  const n = Number(process.env.PQP_TEST_DB_WORKERS ?? "1");
  return Number.isInteger(n) && n > 1 ? n : 1;
}

export function workerDatabaseUrl(base: string, worker: number): string {
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, "") || "postgres";
  url.pathname = `/${name}_w${worker}`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const workers = workerCount();
  // No database: the DB-backed files skip themselves, nothing to create.
  if (!base || workers === 1) {
    return;
  }
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  try {
    for (let worker = 1; worker <= workers; worker += 1) {
      const name = new URL(workerDatabaseUrl(base, worker)).pathname.slice(1);
      // Identifiers cannot be parameters; the name is built from our own URL
      // and a digit, and quoted.
      const quoted = `"${name.replace(/"/g, '""')}"`;
      await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${quoted}`);
    }
  } finally {
    await client.end();
  }
}
