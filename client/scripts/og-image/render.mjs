// Renders client/scripts/og-image/template.html to the social share images.
//
//   pnpm --filter @pqp/client og:image
//
// Writes client/public/images/og-image.jpg (pt-BR, the default the static tags
// point at) and og-image-en.jpg (English variant, not referenced by any tag yet).
// Needs network once, for Google Fonts (the same families the site loads), and a
// Playwright Chromium (`pnpm --filter @pqp/client exec playwright install chromium`).
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/images");
const template = pathToFileURL(resolve(here, "template.html")).href;

const targets = [
  { lang: "pt", file: "og-image.jpg" },
  { lang: "en", file: "og-image-en.jpg" },
];

const browser = await chromium.launch();
try {
  for (const { lang, file } of targets) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(`${template}?lang=${lang}`, { waitUntil: "networkidle" });
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
