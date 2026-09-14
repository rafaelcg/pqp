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
import { closeBus, INSTANCE_ID, setBusTransport } from "./lib/bus.js";
import { createPostgresBusTransport } from "./lib/bus-postgres.js";
import { logEvent } from "./lib/log.js";

const PORT = Number(process.env.PORT ?? 3001);

/**
 * PUBLISH-ONLY CLUSTER BUS, and the reason the worker has one at all.
 *
 * Several of the jobs above are not just database work: they are the START of
 * a fan-out. The channel-session reminder tick nudges everyone who asked to be
 * reminded; the watch-party host sweep ends a party whose host never came back
 * and tells its audience. Both of those reach people through `/ws`, and this
 * process has no `/ws`. On one machine that was fine, because `WORKER_MODE`
 * was unset and the API ran the jobs itself. Split, the socket half simply did
 * not happen: `isBusEnabled()` was false here, so every `publishToCluster` on
 * this side returned on its first line and the API machines were never told.
 *
 * So: connect, NOTIFY, never LISTEN (see `PostgresBusOptions.publishOnly`).
 * Gated on the same `CLUSTER_BUS` value the API reads, because a worker that
 * publishes into a cluster whose machines are not listening is at best wasted
 * round trips, and `CLUSTER_BUS=postgres` is precisely the operator saying
 * "there is more than one process here". Unset, or any other value, and this
 * process behaves exactly as it did before.
 */
function startWorkerBus(): boolean {
  const mode = process.env.CLUSTER_BUS ?? "off";
  if (mode === "off") {
    return false;
  }
  if (mode !== "postgres") {
    console.warn(
      `[bus] unknown CLUSTER_BUS=${mode} — the worker will not publish. ` +
        `Supported: "postgres", "off".`,
    );
    return false;
  }
  setBusTransport(createPostgresBusTransport(undefined, { publishOnly: true }));
  logEvent("bus.enabled", {
    transport: "postgres",
    instance: INSTANCE_ID,
    publishOnly: true,
    role: "worker",
  });
  return true;
}

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
  // Before the pool: the bus owns a connection of its own, outside it.
  await closeBus();
  await closePool();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// Before the jobs: the first tick of a job that publishes must find the
// transport installed, not race it.
const busPublishing = startWorkerBus();

jobs = startColdJobs();
healthServer.listen(PORT, () => {
  console.log(
    `pqp worker: ${jobs?.count ?? 0} job(s) scheduled, ` +
      `bus ${busPublishing ? "publishing" : "off"}, ` +
      `/health on http://localhost:${PORT}`,
  );
});
