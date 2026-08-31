import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the real client and server with the dev auth bypass on, so
 * tests never depend on Clerk's hosted flows. The suite needs a database:
 * `docker compose up -d postgres` first.
 */
/**
 * Ports and database, all three overridable.
 *
 * `E2E_DATABASE_URL` was already env-driven; the two ports were not, and that
 * asymmetry bites the moment two checkouts of this repo exist on one machine.
 * `reuseExistingServer` is on outside CI, so a suite started in checkout B
 * silently attaches to the server checkout A left running on 3101 — and then
 * every assertion is made against somebody else's code and somebody else's
 * database rows. It fails in the most misleading way available: the app works,
 * so most specs pass, and only the ones testing the change under development
 * fail. Overriding all three is what makes a second checkout an isolated run.
 *
 * `E2E_API_URL` (which the specs read for their own `fetch` calls) has to move
 * with `E2E_SERVER_PORT`; the default below keeps the two in step.
 */
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 5273);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3101);
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
    locale: "en-US",
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
        // Bypass boot would otherwise seed Sandbox. `ensureServer` then sees a
        // hall and never creates "E2E", so specs that look for that name, a
        // solo-owner danger zone, or a Topic tile on a phone all miss.
        DEV_SEED: "false",
        // Every test drives the same account and boots the app from scratch,
        // which no real user does. Raise the ceiling rather than lower it in
        // production code.
        RATE_LIMIT_API_CAPACITY: "10000",
        RATE_LIMIT_API_REFILL: "1000",
        RATE_LIMIT_WRITE_CAPACITY: "10000",
        RATE_LIMIT_WRITE_REFILL: "1000",
        // Same account, same socket: the WS message bucket is 10 bursts at
        // 2/s in production, which silently drops the 18-send fill used to
        // park a row at the bottom of the window.
        RATE_LIMIT_WS_MESSAGE_CAPACITY: "10000",
        RATE_LIMIT_WS_MESSAGE_REFILL: "1000",
        // The Communities directory, ON for the suite and OFF everywhere else
        // (`.env.example` ships it false and production has never set it).
        //
        // Turned on here rather than in a spec because a spec cannot restart
        // the shared server: `isCommunitiesEnabled` reads the environment per
        // call, but the process that reads it is booted once for the whole run.
        // The FLAG-OFF case is therefore proved two other ways — every route
        // 404ing with the variable unset is pinned in
        // `server/src/services/communities.test.ts`, and the client rendering
        // nothing when `/api/communities/config` answers `enabled: false` is
        // pinned in `communities.spec.ts`, which stubs that one response. Those
        // two together are the whole contract; a third webServer on a third
        // port would prove nothing extra and double the suite's boot time.
        COMMUNITIES_ENABLED: "true",
        // Object storage, passed through rather than pinned.
        //
        // The webServer `env` REPLACES the environment rather than extending
        // it, and the server's own dotenv load cannot help here: a worktree has
        // no `.env` at all. So a suite run needs these named explicitly to
        // reach a bucket — which is exactly the switch that decides whether
        // `server-identity.spec.ts` uploads a real banner to MinIO
        // (`docker compose --profile storage up -d`, then export these) or
        // skips that half with a note. Absent, `GET /api/servers/images/config`
        // answers `enabled: false`, which is the shape every deployment without
        // `S3_*` is in and is itself worth having a spec run against.
        ...(process.env.S3_ENDPOINT
          ? {
              S3_ENDPOINT: process.env.S3_ENDPOINT,
              S3_BUCKET: process.env.S3_BUCKET ?? "pqp-attachments",
              S3_REGION: process.env.S3_REGION ?? "us-east-1",
              S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
              S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "",
              S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
            }
          : {}),
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
