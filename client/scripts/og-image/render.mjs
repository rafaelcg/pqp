// Renders client/scripts/og-image/template.html to the social share images.
//
//   pnpm --filter @pqp/client og:image
//
// Writes client/public/images/og-image.jpg (pt-BR, the default the static tags
// point at) and og-image-en.jpg (English variant, not referenced by any tag yet),
// plus the /streamers cards og-streamers{,-en,-es}.jpg. Pass a word to render
// only the files whose name contains it: `node render.mjs streamers`.
// Needs network once, for Google Fonts (the same families the site loads), and a
// Playwright Chromium (`pnpm --filter @pqp/client exec playwright install chromium`).
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/images");
const template = pathToFileURL(resolve(here, "template.html")).href;

const all = [
  { lang: "pt", file: "og-image.jpg" },
  { lang: "en", file: "og-image-en.jpg" },
  // The /streamers card (`marketing-meta.ts`), same template, its own words.
  { lang: "pt", variant: "streamers", file: "og-streamers.jpg" },
  { lang: "en", variant: "streamers", file: "og-streamers-en.jpg" },
  { lang: "es", variant: "streamers", file: "og-streamers-es.jpg" },
];
// `render.mjs streamers` re-renders only the cards whose file name contains
// the word, so one card can be redrawn without touching the others' bytes.
const only = process.argv[2];
const targets = only ? all.filter((target) => target.file.includes(only)) : all;

const browser = await chromium.launch();
try {
  for (const { lang, variant, file } of targets) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    const query = variant ? `?lang=${lang}&variant=${variant}` : `?lang=${lang}`;
    await page.goto(`${template}${query}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: resolve(out, file),
      type: "jpeg",
      quality: 90,
      clip: { x: 0, y: 0, width: 1200, height: 630 },
    });
    await page.close();
    console.log("wrote", file);
  }
} finally {
  await browser.close();
}
