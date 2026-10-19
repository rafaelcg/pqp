import { defineConfig, devices } from "@playwright/test";

/**
 * The app-frame suite: the REAL frame controller, bridge host and SDK, in a
 * real sandboxed frame under the real CSP, in Chromium, WebKit and Firefox. No
 * API and no database.
 *
 * Its own config because it needs none of what `playwright.config.ts` boots.
 * It starts four tiny servers itself (the host page, a stand-in apps origin, a
 * canary that counts every request it receives, and two "other" origins for
 * embeds) and builds the page and the frames with Vite. Run it with
 * `pnpm --filter @pqp/client e2e:app-frame` (all three engines) or, one engine
 * at a time, `... e2e:app-frame --project=webkit`.
 */
export default defineConfig({
  testDir: "./e2e/app-frame",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1000, height: 800 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1000, height: 800 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1000, height: 800 } } },
  ],
});
