import { defineConfig, devices } from "@playwright/test";

/**
 * The guest player suite (`e2e/locadora-guest/`): Locadora with no account, in
 * the real client, against the real API (for the one request the page makes,
 * the public apps config) and the real Locadora build served on its own
 * origin, which the spec builds and serves itself (`apps.ts`).
 *
 * Its own config because it needs flags no other suite wants (`APPS_LANDING`,
 * `LOCADORA_GUEST`, an `APPS_ORIGIN`) and an apps origin whose
 * `frame-ancestors` lists this client's port. Ports and database are
 * overridable like the main suite's, so a second checkout runs isolated:
 * `E2E_GUEST_SERVER_PORT`, `E2E_GUEST_CLIENT_PORT`, `E2E_GUEST_APPS_PORT`,
 * `E2E_DATABASE_URL`. Run it with `pnpm --filter @pqp/client e2e:locadora-guest`.
 */
const SERVER_PORT = Number(process.env.E2E_GUEST_SERVER_PORT ?? 3141);
const CLIENT_PORT = Number(process.env.E2E_GUEST_CLIENT_PORT ?? 5241);
export const APPS_PORT = Number(process.env.E2E_GUEST_APPS_PORT ?? 5242);
process.env.E2E_GUEST_APPS_PORT = String(APPS_PORT);
process.env.E2E_GUEST_CLIENT_PORT = String(CLIENT_PORT);
process.env.E2E_GUEST_SERVER_PORT = String(SERVER_PORT);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://pqp:pqp@localhost:5432/pqp_test";

export default defineConfig({
  testDir: "./e2e/locadora-guest",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    viewport: { width: 1280, height: 800 },
    screen: { width: 1920, height: 1200 },
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      command: "pnpm --filter @pqp/server exec tsx src/index.ts",
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_URL,
        // a dev box releases the pqp apps by itself at catalog load
        DEV_AUTH_BYPASS: "true",
        NODE_ENV: "development",
        DEV_SEED: "false",
        APPS_LANDING: "true",
        LOCADORA_GUEST: "true",
        APPS_ORIGIN: `http://localhost:${APPS_PORT}`,
      },
    },
    {
      command: `pnpm exec vite --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
      env: {
        VITE_API_URL: `http://localhost:${SERVER_PORT}`,
        VITE_WS_URL: `ws://localhost:${SERVER_PORT}/ws`,
        VITE_DEV_AUTH_BYPASS: "true",
      },
    },
  ],
});
