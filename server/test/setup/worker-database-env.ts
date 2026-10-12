/**
 * Vitest setupFile for `PQP_TEST_DB_WORKERS=N`: runs before every test file,
 * before the file's own imports, and points `TEST_DATABASE_URL` and
 * `DATABASE_URL` at this worker's database (created by `worker-databases.ts`).
 *
 * The DB-backed files read `TEST_DATABASE_URL ?? DATABASE_URL` at module load,
 * so rewriting both here is all it takes; no test file changes. The original
 * URL is kept in `PQP_TEST_DB_BASE_URL` the first time, so a process that runs
 * several files derives every one from the base rather than from the
 * previous file's rewrite (and a file that left `DATABASE_URL` pointing
 * somewhere odd does not leak into the next).
 */
import { workerCount, workerDatabaseUrl } from "./worker-databases";

const workers = workerCount();
const base = (process.env.PQP_TEST_DB_BASE_URL ??=
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "");

if (workers > 1 && base) {
  const id = Number(process.env.VITEST_POOL_ID);
  if (!Number.isInteger(id) || id < 1 || id > workers) {
    // Two workers on one database is the race this exists to remove; refuse
    // rather than run it quietly.
    throw new Error(
      `VITEST_POOL_ID=${process.env.VITEST_POOL_ID} is outside 1..${workers}; ` +
        "cannot pick a per-worker database",
    );
  }
  const url = workerDatabaseUrl(base, id);
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
}
