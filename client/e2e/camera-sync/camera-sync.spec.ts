/**
 * THE PRESENTER'S CAMERA AGAINST THE FILM, MEASURED OFF THE PICTURES.
 *
 * Rafael, MoonKase party, 2026-10-03: "the camera is not in sync with the
 * stream". This rig is the evidence for that and for the fix: the REAL watch
 * player (`HlsWatchPlayer` and its two hls.js instances) on a synthetic live
 * film and camera that share one timeline and one PROGRAM-DATE-TIME anchor
 * (`gen.mjs`, `hls-server.mjs`), and a meter that reads the frame number
 * burnt into each picture (`harness.tsx`). So every number here is what a
 * viewer would see on screen, not what hls.js believes.
 *
 * Each run walks one page through what happens during a party:
 *   start      the viewer arrives; both players sit at their own live edge
 *   decode     the camera's element stops for 6 s (a decoder or main-thread
 *              hiccup) and resumes where it was
 *   network    the camera's segment requests hang for 30 s (an egress or CDN
 *              hiccup): its buffer runs dry and it stalls
 *   frozen     the tab goes to the background and Chrome freezes it for 15 s
 *              (Page Lifecycle `frozen`, the state Chrome puts a background
 *              tab in; a real hidden-tab throttle cannot be had headless)
 *   layout     "Ocultar câmera" then "Padrão" from the control bar, which
 *              unmounts and remounts the camera's player
 *
 * QUICK (the default, and what a regression run is): LL with sync on, start,
 * decode and layout, asserting the drift settles. FULL (`CAMERA_SYNC_FULL=1`):
 * every scenario, conventional and LL, sync off and on, and a table.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
// @ts-expect-error -- plain ESM helpers shared with the CLI, no types.
import { generate } from "./gen.mjs";
// @ts-expect-error -- plain ESM helpers shared with the CLI, no types.
import { startHlsServer } from "./hls-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FULL = process.env.CAMERA_SYNC_FULL === "1";
/** Content long enough for a run: each page starts 70 s into it. */
const MEDIA_SECONDS = FULL ? 900 : 360;
const MEDIA = path.join(os.tmpdir(), `pqp-camera-sync-media-v1-${MEDIA_SECONDS}`);
const RESULTS = path.join(here, "..", "..", "test-results", "camera-sync");

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Sample {
  at: number;
  driftMs: number | null;
  camPaused: boolean | null;
  camRate: number | null;
  player: { driftMs?: number | null } | null;
}

interface PhaseResult {
  phase: string;
  /** Median drift over the last 5 s of the phase, ms (camera minus film). */
  settledMs: number | null;
  /** The largest |drift| seen in the phase, ms. */
  worstMs: number | null;
  /** Seconds from the phase's start until |drift| stayed under 200 ms. */
  secondsToSync: number | null;
  /** The player's own drift reading at the end, ms, when the build has one. */
  playerMs: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function summarise(phase: string, samples: Sample[], from: number, to: number): PhaseResult {
  const inPhase = samples.filter((s) => s.at >= from && s.at <= to && s.driftMs !== null);
  const tail = inPhase.filter((s) => s.at >= to - 5_000).map((s) => s.driftMs!);
  const worst = inPhase.reduce<number | null>(
    (max, s) => (max === null || Math.abs(s.driftMs!) > max ? Math.abs(s.driftMs!) : max),
    null,
  );
  // The first moment after which every reading stays under 200 ms.
  let syncedAt: number | null = null;
  for (const s of inPhase) {
    if (Math.abs(s.driftMs!) < 200) {
      syncedAt ??= s.at;
    } else {
      syncedAt = null;
    }
  }
  const last = [...samples].reverse().find((s) => s.at <= to && s.player);
  return {
    phase,
    settledMs: median(tail),
    worstMs: worst,
    secondsToSync: syncedAt === null ? null : Math.round((syncedAt - from) / 100) / 10,
    playerMs: typeof last?.player?.driftMs === "number" ? Math.round(last.player.driftMs) : null,
  };
}

async function samplesOf(page: Page): Promise<Sample[]> {
  return page.evaluate(() => window.__cameraSync.samples as never);
}

async function waitForBothPictures(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const last = window.__cameraSync.samples.at(-1);
          return last ? last.driftMs !== null : false;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function pickLayout(page: Page, label: RegExp): Promise<void> {
  // Wake the chrome with a pointer move over the stage, then the bar's menu.
  await page.mouse.move(640, 300);
  await page.mouse.move(650, 310);
  await page.getByTestId("watch-camera-layout").click();
  await page.getByRole("menuitemcheckbox", { name: label }).or(page.getByRole("menuitem", { name: label })).first().click();
  await page.mouse.move(5, 5);
}

async function control(base: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${base}/control`, { method: "POST", body: JSON.stringify(body) });
}

interface Run {
  mode: "live" | "ll";
  sync: "on" | "off";
  scenarios: ("start" | "decode" | "network" | "frozen" | "layout")[];
}

const RUNS: Run[] = FULL
  ? (["live", "ll"] as const).flatMap((mode) =>
      (["off", "on"] as const).map((sync) => ({
        mode,
        sync,
        scenarios: ["start", "decode", "network", "frozen", "layout"] as Run["scenarios"],
      })),
    )
  : [{ mode: "ll", sync: "on", scenarios: ["start", "decode", "layout"] }];

test.describe("the presenter's camera follows the film", () => {
  test.skip(!hasFfmpeg(), "needs ffmpeg on PATH");

  test.beforeAll(() => {
    if (!existsSync(path.join(MEDIA, "manifest.json"))) {
      generate({ out: MEDIA, seconds: MEDIA_SECONDS, segment: 4, camPhaseMs: 2320 });
    }
    mkdirSync(RESULTS, { recursive: true });
  });

  for (const [index, run] of RUNS.entries()) {
    test(`${run.mode} / sync ${run.sync}`, async ({ page, context }) => {
      const port = 8790 + index;
      const base = `http://127.0.0.1:${port}`;
      const { server } = await startHlsServer({
        media: MEDIA,
        port,
        prerollMs: 70_000,
        filmDelayMs: 1_000,
        camDelayMs: 2_500,
      });
      const results: PhaseResult[] = [];
      try {
        await page.goto(
          `/e2e/camera-sync/harness.html?mode=${run.mode}&sync=${run.sync}&base=${encodeURIComponent(base)}`,
        );
        await waitForBothPictures(page);
        let from = Date.now();
        const settle = async (ms: number) => page.waitForTimeout(ms);
        const close = async (phase: string) => {
          const to = Date.now();
          results.push(summarise(phase, await samplesOf(page), from, to));
          from = to;
        };

        await settle(25_000);
        await close("start");

        if (run.scenarios.includes("decode")) {
          await page.evaluate(() => {
            const cam = document.querySelector<HTMLVideoElement>(
              '[data-testid="watch-camera-pip"] video',
            );
            cam?.pause();
            window.setTimeout(() => void cam?.play(), 6_000);
          });
          await settle(30_000);
          await close("decode stall 6 s");
        }

        if (run.scenarios.includes("network")) {
          await control(base, { stall: "cam", ms: 30_000 });
          await settle(60_000);
          await close("network stall 30 s");
        }

        if (run.scenarios.includes("frozen")) {
          const other = await context.newPage();
          await other.goto("about:blank");
          await other.bringToFront();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          await other.waitForTimeout(15_000);
          await cdp.send("Page.setWebLifecycleState", { state: "active" });
          await page.bringToFront();
          await other.close();
          await settle(30_000);
          await close("tab frozen 15 s");
        }

        if (run.scenarios.includes("layout")) {
          await pickLayout(page, /Ocultar câmera/);
          await expect(page.getByTestId("watch-camera-pip")).toHaveCount(0);
          await settle(8_000);
          from = Date.now();
          await pickLayout(page, /Padrão/);
          await expect(page.getByTestId("watch-camera-pip")).toHaveCount(1);
          await waitForBothPictures(page);
          await settle(25_000);
          await close("camera hidden, shown again");
        }

        const file = path.join(RESULTS, `${run.mode}-sync-${run.sync}.json`);
        writeFileSync(file, JSON.stringify({ run, results, samples: await samplesOf(page) }, null, 2));
        // The table IS the output of a full run: the numbers in the PR.
        // eslint-disable-next-line no-console
        console.log(`\n${run.mode} / sync ${run.sync}`);
        // eslint-disable-next-line no-console
        console.table(results);

        if (run.sync === "on") {
          for (const result of results) {
            // Settled means within two frames, whatever happened before.
            expect(Math.abs(result.settledMs ?? Infinity), result.phase).toBeLessThanOrEqual(120);
          }
        }
      } finally {
        server.close();
      }
    });
  }
});
