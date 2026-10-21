import { defineConfig, devices } from "@playwright/test";

/**
 * The Locadora share-sound suite (`e2e/locadora-share-sound/`): a game shared
 * into a voice call, MEASURED at the viewer. Two real clients on the dev
 * bypass, a real call between them, the real Locadora build in its sandboxed
 * frame, and the viewer's inbound audio read for the game's tone and for the
 * call's own voice (which must not come back in the share).
 *
 * Its own config because it needs the apps platform and Locadora's share on
 * (`APPS`, `EMULATOR_ROOM`, `LOCADORA_SHARE`, the dev seed that releases the
 * apps on the Sandbox hall) and an apps origin whose `frame-ancestors` lists
 * this client's port. Ports and database are overridable so a second checkout
 * runs isolated: `E2E_SHARE_SOUND_SERVER_PORT`, `E2E_SHARE_SOUND_CLIENT_PORT`,
 * `E2E_SHARE_SOUND_APPS_PORT`, `E2E_DATABASE_URL`. Run it with
 * `pnpm --filter @pqp/client e2e:locadora-share-sound`.
 */
const SERVER_PORT = Number(process.env.E2E_SHARE_SOUND_SERVER_PORT ?? 3151);
const CLIENT_PORT = Number(process.env.E2E_SHARE_SOUND_CLIENT_PORT ?? 5251);
export const APPS_PORT = Number(process.env.E2E_SHARE_SOUND_APPS_PORT ?? 5252);
process.env.E2E_SHARE_SOUND_APPS_PORT = String(APPS_PORT);
process.env.E2E_SHARE_SOUND_CLIENT_PORT = String(CLIENT_PORT);
process.env.E2E_SHARE_SOUND_SERVER_PORT = String(SERVER_PORT);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://pqp:pqp@localhost:5432/pqp_test";

export default defineConfig({
  testDir: "./e2e/locadora-share-sound",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"]] : "list",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    // `E2E_REAL_CAPTURE=1` runs a headed browser that really captures its own tab (one window at a time); the
    // default stands a canvas in for the picker, because headless Chromium cannot capture a tab
    launchOptions:
      process.env.E2E_REAL_CAPTURE === "1"
        ? {
            headless: false,
            args: [
              "--auto-accept-this-tab-capture",
              // a real prompt for the microphone would stall the join: a granted one, silent, from a file
              "--use-fake-device-for-media-stream",
              ...(process.env.E2E_SILENT_WAV ? [`--use-file-for-fake-audio-capture=${process.env.E2E_SILENT_WAV}`] : []),
            ],
          }
        : {},
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
        DEV_AUTH_BYPASS: "true",
        NODE_ENV: "development",
        // the seed releases the first-party apps on the Sandbox hall and gives it a voice channel
        DEV_SEED: "true",
        APPS: "true",
        EMULATOR_ROOM: "true",
        LOCADORA_SHARE: "true",
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
