/**
 * What the public home page ("/") downloads, per build. The landing page is the
 * first thing a visitor sees, so a change that helps `/app` must not cost it.
 *
 *   BENCH_APPS="before=http://127.0.0.1:4190,after=http://127.0.0.1:4192" node client/bench/home-weight.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const apps = (process.env.BENCH_APPS ?? "build=http://127.0.0.1:4190")
  .split(",")
  .map((x) => x.split("="));
const browser = await chromium.launch({ headless: true });
for (const [name, base] of apps) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let js = 0;
  let all = 0;
  let requests = 0;
  const kinds = new Map();
  cdp.on("Network.responseReceived", (e) => kinds.set(e.requestId, e.type));
  cdp.on("Network.requestWillBeSent", () => (requests += 1));
  cdp.on("Network.loadingFinished", (e) => {
    all += e.encodedDataLength;
    if (kinds.get(e.requestId) === "Script") js += e.encodedDataLength;
  });
  await page.goto(`${base}/?lang=en`, { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 1500));
  console.log(JSON.stringify({ build: name, requests, jsWireKB: Math.round(js / 1024), totalWireKB: Math.round(all / 1024) }));
  await context.close();
}
await browser.close();
