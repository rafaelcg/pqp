import { defineConfig } from "@playwright/test";

/**
 * Locadora in a real sandboxed frame, under its real CSP, with generated test
 * patterns (never games) and a canary server that must see nothing. Three
 * engines locally; in CI (which only installs Chromium) just Chromium.
 *
 *   pnpm --filter @pqp-apps/locadora e2e
 */
const everyEngine = !process.env.CI;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "off", video: "off", screenshot: "off" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    ...(everyEngine
      ? [
          { name: "webkit", use: { browserName: "webkit" as const } },
          { name: "firefox", use: { browserName: "firefox" as const } },
        ]
      : []),
  ],
});
