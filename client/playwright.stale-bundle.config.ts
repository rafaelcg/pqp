import { defineConfig, devices } from "@playwright/test";

/**
 * The stale-bundle suite: real builds, a real service worker, no API.
 *
 * Its own config because it needs none of what `playwright.config.ts` boots
 * (the API, Postgres, `vite dev`) and all of what that one cannot do: a
 * service worker only exists in a production build, so every spec here builds
 * the client itself (`e2e/stale-bundle/builds.ts`, about four seconds a build)
 * and serves it from a stand-in for Cloudflare Pages that can swap the deployed
 * build under an open page. Run with `pnpm --filter @pqp/client e2e:stale-bundle`.
 */
export default defineConfig({
  testDir: "./e2e/stale-bundle",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        locale: "pt-BR",
        colorScheme: "dark",
        serviceWorkers: "allow",
      },
    },
  ],
});
