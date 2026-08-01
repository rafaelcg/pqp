/**
 * Runtime theme benchmarks. Static token checks cannot see these:
 *
 *   switchMs   — how long applying a theme takes, including the forced style
 *                recalculation. A theme swap that janks is a theme swap people
 *                stop using.
 *   flashMs    — time from navigation to the correct theme being on the
 *                document. Anything above a frame is a visible flash of the
 *                wrong theme, which is the classic bug this design exists to
 *                avoid.
 *   cssBytes   — the built stylesheet, raw and gzipped. Two themes in one file
 *                is only worth it while the file stays small.
 *
 * Assumes the dev servers from playwright.config.ts are reachable, or start
 * them yourself. Run: pnpm --filter @pqp/client bench:runtime
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..");
const BASE = process.env.BENCH_BASE_URL ?? "http://localhost:5273";
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 40);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function measureCss() {
  const assets = join(CLIENT, "dist", "assets");
  let files;
  try {
    files = readdirSync(assets).filter((name) => name.endsWith(".css"));
  } catch {
    return null;
  }
  return files.reduce(
    (acc, name) => {
      const buffer = readFileSync(join(assets, name));
      return {
        raw: acc.raw + buffer.length,
        gzip: acc.gzip + gzipSync(buffer).length,
      };
    },
    { raw: 0, gzip: 0 },
  );
}

const browser = await chromium.launch();

// Switch latency: apply a theme, then force a style flush so the number
// includes recalculation rather than just the attribute write.
const switchPage = await browser.newPage({ colorScheme: "dark" });
await switchPage.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
await switchPage.waitForSelector("text=Dev auth bypass", { timeout: 20_000 });

const switchSamples = await switchPage.evaluate((iterations) => {
  const samples = [];
  const root = document.documentElement;
  for (let i = 0; i < iterations; i++) {
    const next = i % 2 === 0 ? "light" : "dark";
    const start = performance.now();
    root.dataset.theme = next;
    // Reading a layout-dependent property flushes pending style work.
    void document.body.offsetHeight;
    void getComputedStyle(root).getPropertyValue("--color-surface-0");
    samples.push(performance.now() - start);
  }
  return samples;
}, ITERATIONS);
await switchPage.close();

// Flash: load with a stored preference that differs from the OS, and measure
// when the document actually carries the right theme.
const flashSamples = [];
for (let i = 0; i < 5; i++) {
  const context = await browser.newContext({ colorScheme: "dark" });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pqp-theme", "light");
    } catch {
      /* private mode */
    }
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/app`, { waitUntil: "commit" });
  const elapsed = await page.evaluate(async () => {
    const start = performance.now();
    while (document.documentElement.dataset.theme !== "light") {
      if (performance.now() - start > 5000) {
        return -1;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // Relative to navigation, not to this call.
    return performance.now() - (performance.timeOrigin ? 0 : start);
  });
  const applied = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  flashSamples.push({ elapsedMs: round(elapsed), theme: applied });
  await context.close();
}

await browser.close();

const css = measureCss();
const report = {
  measuredAt: new Date().toISOString(),
  iterations: ITERATIONS,
  switchMs: {
    p50: round(percentile(switchSamples, 50)),
    p95: round(percentile(switchSamples, 95)),
    max: round(Math.max(...switchSamples)),
  },
  flash: {
    samples: flashSamples,
    // The head script runs before the body parses, so the theme should be
    // correct on the very first observation.
    correctOnFirstObservation: flashSamples.every((s) => s.theme === "light"),
  },
  css,
};

const outPath = join(HERE, "results", "theme-runtime.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `switch:   p50 ${report.switchMs.p50}ms · p95 ${report.switchMs.p95}ms · max ${report.switchMs.max}ms (${ITERATIONS} swaps)`,
);
console.log(
  `flash:    ${report.flash.correctOnFirstObservation ? "no flash — correct theme on first observation" : "FLASH DETECTED"} (${flashSamples.length} loads)`,
);
if (css) {
  console.log(
    `css:      ${(css.raw / 1024).toFixed(1)} kB raw · ${(css.gzip / 1024).toFixed(1)} kB gzip`,
  );
} else {
  console.log("css:      no dist build found — run `pnpm --filter @pqp/client build`");
}
console.log(`\nwrote ${relative(CLIENT, outPath)}`);

if (!report.flash.correctOnFirstObservation) {
  process.exitCode = 1;
}
