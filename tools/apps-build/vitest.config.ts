import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.mts"],
    // each build test runs a real Vite build
    testTimeout: 60_000,
  },
});
