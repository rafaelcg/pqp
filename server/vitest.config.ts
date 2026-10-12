import { defineConfig } from "vitest/config";
import { workerCount } from "./test/setup/worker-databases";

// `PQP_TEST_DB_WORKERS=N` runs N files at once, each worker on a database of
// its own (`test/setup/worker-databases.ts`). Unset, the suite is serial on
// one database exactly as before. CI sets it: the serial run was ~11.5 of the
// `checks` job's ~15 minutes.
const workers = workerCount();
const parallel = workers > 1;

export default defineConfig({
  test: {
    environment: "node",
    // Two trees: unit tests live beside their source, DB-backed suites in test/.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Those suites share one Postgres — run serially to avoid races, unless
    // each worker has a database of its own.
    pool: "forks",
    fileParallelism: parallel,
    ...(parallel
      ? {
          maxWorkers: workers,
          globalSetup: ["./test/setup/worker-databases.ts"],
          setupFiles: ["./test/setup/worker-database-env.ts"],
        }
      : {}),
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      CLERK_SECRET_KEY: "sk_test_dummy",
    },
  },
});
