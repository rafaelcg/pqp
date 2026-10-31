import { defineConfig } from "@playwright/test";

/**
 * The share smoke test (`test/share-smoke/`): the packaged app, its real
 * picker and the real `getDisplayMedia`. Its own config because it needs a
 * built page and, for the gate, a packaged binary, neither of which the window
 * smoke test (`playwright.config.mjs`) wants. See docs/DESKTOP.md §5
 * "The release gate".
 *
 *   pnpm electron:smoke-share                  (builds the page, then runs)
 *   PQP_SHARE_SMOKE_APP=<app> pnpm --filter @pqp/electron smoke:share
 */
export default defineConfig({
  testDir: "./test/share-smoke",
  testMatch: /.*\.smoke\.mjs/,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["github"]] : "line",
  outputDir: "./test-results/share-smoke/playwright",
  retries: 0,
});
