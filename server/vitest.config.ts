import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Two trees: unit tests live beside their source, DB-backed suites in test/.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Those suites share one Postgres — run serially to avoid races.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      CLERK_SECRET_KEY: "sk_test_dummy",
    },
  },
});
