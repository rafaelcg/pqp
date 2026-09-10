import { defineConfig } from "@playwright/test";

/**
 * The Electron smoke test only. It launches the app's own Chromium through
 * `_electron`, so it needs no browser download and no `playwright install`.
 * Kept out of `pnpm test` (which is `node --test lib/*.test.mjs`, no display
 * needed) because this one wants a display, and CI runs it under xvfb.
 */
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.spec\.mjs/,
  // One window, one app. Parallel Electron launches fight over the same
  // userData directory and produce failures that are about the test rather
  // than about the shell.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: process.env.CI ? "list" : "line",
  retries: 0,
});
