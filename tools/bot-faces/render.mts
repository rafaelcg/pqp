/**
 * Renders the PNG of every bot colour and base face that the API serves at
 * `/api/bot-faces/:color/:face.png` (server/src/assets/bot-faces/). The phone
 * apps and anything else that only knows images show these; the web client
 * draws the same SVG inline and animated.
 *
 * Run after changing `packages/shared/src/bot-face.ts`, and bump
 * `BOT_FACE_PNG_VERSION` there so caches let go of the old pictures:
 *
 *   pnpm --filter @pqp/server exec tsx ../tools/bot-faces/render.mts
 *
 * Needs Playwright's Chromium (`pnpm --filter @pqp/client exec playwright install chromium`).
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_BASE_FACES, BOT_COLORS, botFaceSvg } from "../../packages/shared/src/bot-face.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromClient = createRequire(join(root, "client", "package.json"));
const { chromium } = requireFromClient("@playwright/test") as typeof import("@playwright/test");

const SIZE = 256;
const out = join(root, "server", "src", "assets", "bot-faces");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
let count = 0;
for (const color of BOT_COLORS) {
  mkdirSync(join(out, color), { recursive: true });
  for (const face of BOT_BASE_FACES) {
    const svg = botFaceSvg({ color, face, variant: "avatar", size: SIZE, backdrop: true });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await page.locator("svg").screenshot({ path: join(out, color, `${face}.png`), omitBackground: true });
    count += 1;
  }
}
await browser.close();
console.log(`wrote ${count} faces to ${out}`);
