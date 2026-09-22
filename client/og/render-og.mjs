// Renders the /vem share cards from vem.html with headless Chromium, so the
// text on them is set by a browser and stays crisp. Run from client/:
//   node og/render-og.mjs
// Needs network for Google Fonts, like the site itself.
/* global document, console */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "vem.html");
const out = join(here, "..", "public", "images");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  for (const [lang, file] of [
    ["pt-BR", "og-vem.png"],
    ["en", "og-vem-en.png"],
  ]) {
    await page.goto(`file://${source}?lang=${lang}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, file) });
    console.log(`wrote public/images/${file}`);
  }
} finally {
  await browser.close();
}
