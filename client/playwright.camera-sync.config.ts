import { defineConfig } from "@playwright/test";

/**
 * The camera sync rig: the real watch player on a synthetic live film and
 * camera (`e2e/camera-sync/`), measured off the pictures themselves.
 *
 * Its own config because it needs none of what `playwright.config.ts` boots
 * (no API, no Postgres, no auth) and one thing that one cannot give it: real
 * Google Chrome. Playwright's bundled Chromium has no H.264, so the film never
 * decodes there. Needs `ffmpeg` on PATH too; the spec skips without it.
 *
 *   pnpm --filter @pqp/client e2e:camera-sync            (quick, LL, about 2 min)
 *   CAMERA_SYNC_FULL=1 pnpm --filter @pqp/client e2e:camera-sync   (every
 *     scenario, both modes, sync off and on: the numbers in the PR, ~20 min)
 */
const PORT = Number(process.env.CAMERA_SYNC_VITE_PORT ?? 5298);

export default defineConfig({
  testDir: "./e2e/camera-sync",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 30 * 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.CAMERA_SYNC_CHANNEL ?? "chrome",
    viewport: { width: 1280, height: 720 },
    locale: "pt-BR",
    colorScheme: "dark",
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/camera-sync/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
