import { defineConfig, devices } from "@playwright/test";

/**
 * The public jam site (`e2e/jam-site/`): the site alone on a Vite page. The API is
 * mocked in the browser (`page.route`), so there is no server, no Postgres, no
 * auth, and nothing to clean up.
 *
 *   pnpm --filter @pqp/client e2e:jam-site
 *
 * A second block in the spec runs against a REAL local API seeded by
 * `tools/jam-site-seed` when `JAM_SITE_API` (and `JAM_SITE_IDS`, the seed's
 * `seed-ids.json`) are set; without them it is skipped.
 */
const PORT = Number(process.env.JAM_SITE_VITE_PORT ?? 5298);

export default defineConfig({
  testDir: "./e2e/jam-site",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, locale: "pt-BR" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/jam`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
