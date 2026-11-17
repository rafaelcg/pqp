import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { encodeWav } from "./src/lib/jam/pcm";
import { pulseTrain, sweep } from "./src/lib/jam/signals";

/**
 * The jam engine rig (`e2e/jam/`): the engine alone on a Vite page, no API,
 * no Postgres, no auth.
 *
 *   pnpm --filter @pqp/client e2e:jam
 *
 * `jam.spec.ts` runs on Chromium with a FAKE microphone that plays
 * `FAKE_MIC_WAV` (written below, before the browser launches): a down-sweep
 * every second, forever. A fake device has no hardware latency and cannot
 * hear the speakers, so the spec proves the pipeline and its arithmetic
 * (frame stamps, calibration, placement, encode, decode, playback), not
 * real-world calibration. See the spec's header.
 *
 * `formats.spec.ts` measures how each browser decodes each candidate upload
 * codec, on all three engines; it needs ffmpeg and skips without it.
 */
const PORT = Number(process.env.JAM_VITE_PORT ?? 5297);

export const FAKE_MIC_SAMPLE_RATE = 48000;
export const FAKE_MIC_PERIOD_MS = 1000;
const dir = path.join(os.tmpdir(), "pqp-jam-e2e");
mkdirSync(dir, { recursive: true });
export const FAKE_MIC_WAV = path.join(dir, "fake-mic-v1.wav");
{
  const sr = FAKE_MIC_SAMPLE_RATE;
  const period = (sr * FAKE_MIC_PERIOD_MS) / 1000;
  const seconds = 60;
  const at = Array.from({ length: seconds }, (_, k) => k * period + period / 4);
  const x = pulseTrain(seconds * sr, sweep(sr, { direction: "down", amplitude: 0.5 }), at);
  writeFileSync(FAKE_MIC_WAV, encodeWav([x], sr));
}

export default defineConfig({
  testDir: "./e2e/jam",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
    {
      name: "firefox",
      testMatch: /formats\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testMatch: /formats\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/jam/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
