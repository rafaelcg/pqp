import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // the Playwright specs in e2e/ run with `pnpm e2e`, not here
    include: ["src/**/*.test.ts", "build/**/*.test.mts"],
    // unpacking a core runs a WebAssembly 7-Zip
    testTimeout: 60_000,
  },
});
