import { defineConfig } from "@playwright/test";

/**
 * The share fast-start rig (`e2e/share-fast-start/`): a real LiveKit 1.13.6
 * in Docker, the product's own LiveKit session in real headless Chrome (the
 * share is H.264, which Playwright's bundled Chromium cannot decode), and a
 * viewer measured from the moment it joins to the moment its picture is the
 * stage's layer.
 *
 * Its own config because it needs none of what `playwright.config.ts` boots
 * (no API, no Postgres, no auth) and two things that one does not: Docker and
 * Google Chrome. The spec skips without Docker or ffmpeg.
 *
 *   pnpm --filter @pqp/client e2e:share-fast-start      (about 3 minutes)
 *
 * The scenario tables in the README come from `node e2e/share-fast-start/run.mjs`.
 */
const PORT = Number(process.env.SHARE_FAST_START_VITE_PORT ?? 5299);
process.env.BASE ??= `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/share-fast-start",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 10 * 60_000,
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/share-fast-start/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
