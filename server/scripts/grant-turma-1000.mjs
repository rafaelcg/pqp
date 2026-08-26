#!/usr/bin/env node
/**
 * Manual fallback for Turma dos 1000.
 *
 * Production stamps from `stampTurma1000()` inside `insertNewUser` the moment
 * the instance crosses 1,000 humans. This script is for the case that miss
 * happened: run it locally against prod `DATABASE_URL` (or `fly mpg proxy`).
 *
 * It is NOT in the Fly image. It imports the same function the API uses.
 *
 *   DATABASE_URL=postgres://… node scripts/grant-turma-1000.mjs
 */
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { initDb, closePool } = await import("../dist/db.js");
const { stampTurma1000 } = await import("../dist/services/badges.js");

await initDb();
try {
  const result = await stampTurma1000();
  console.log(result.status, "granted=", result.granted);
} finally {
  await closePool();
}
