/**
 * The batch-job half of the server: `jobs.ts` plus a `/health` listener.
 *
 * Same image as `index.ts`. Two ways in, both land here:
 *   * `node server/dist/worker.js` (what fly.worker.toml runs);
 *   * `WORKER_MODE=worker node server/dist/index.js`, which hands off to this
 *     file before it would have listened on `/ws`.
 *
 * Nothing else runs here on purpose: no `/api`, no WebSocket, no static
 * files, no dev seed, and no schema migration. The API runs `initDb` and CI
 * deploys it first, so the worker only ever sees a schema at least as new as
 * its own code. If a sweep needs a column the API has not created yet it
 * logs and retries on its next tick, which is the same tolerance every job
 * here already has for a bucket being away.
 */
import "./env.js";
import { closePool } from "./db.js";
import { closeApnsSessions } from "./services/apns.js";
import { startColdJobs, type ColdJobs } from "./jobs.js";
import { createWorkerHealthServer } from "./worker-health.js";

const PORT = Number(process.env.PORT ?? 3001);

let jobs: ColdJobs | null = null;
const healthServer = createWorkerHealthServer();

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaught exception:", error);
});

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}, draining worker`);
  jobs?.stop();
  await new Promise<void>((done) => healthServer.close(() => done()));
  closeApnsSessions();
  await closePool();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

jobs = startColdJobs();
healthServer.listen(PORT, () => {
  console.log(
    `pqp worker: ${jobs?.count ?? 0} job(s) scheduled, /health on http://localhost:${PORT}`,
  );
});
