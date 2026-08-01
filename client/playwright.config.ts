import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the real client and server with the dev auth bypass on, so
 * tests never depend on Clerk's hosted flows. The suite needs a database:
 * `docker compose up -d postgres` first.
 */
const CLIENT_PORT = 5273;
const SERVER_PORT = 3101;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://pqp:pqp@localhost:5432/pqp_test";

export default defineConfig({
  testDir: "./e2e",
  // Theme assertions read computed colours; parallel workers sharing one
  // database would race on server state.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["json", { outputFile: "e2e-results.json" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Deterministic geometry: several checks compare rendered colour and layout.
    viewport: { width: 1440, height: 900 },
    // Playwright defaults to a light OS preference. Pin dark so "no stored
    // choice" is a known starting point; the system-preference tests build
    // their own light context explicitly.
    colorScheme: "dark",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: "pnpm --filter @pqp/server exec tsx watch src/index.ts",
      port: SERVER_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_URL,
        DEV_AUTH_BYPASS: "true",
        NODE_ENV: "development",
        // Every test drives the same account and boots the app from scratch,
        // which no real user does. Raise the ceiling rather than lower it in
        // production code.
        RATE_LIMIT_API_CAPACITY: "10000",
        RATE_LIMIT_API_REFILL: "1000",
        RATE_LIMIT_WRITE_CAPACITY: "10000",
        RATE_LIMIT_WRITE_REFILL: "1000",
      },
    },
    {
      command: `pnpm exec vite --port ${CLIENT_PORT} --strictPort`,
      port: CLIENT_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      env: {
        VITE_DEV_AUTH_BYPASS: "true",
        VITE_API_URL: `http://localhost:${SERVER_PORT}`,
        VITE_WS_URL: `ws://localhost:${SERVER_PORT}/ws`,
      },
    },
  ],
});
