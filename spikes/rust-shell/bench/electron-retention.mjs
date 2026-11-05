/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Is the memory a 2000-row channel costs given back when you leave it?
// Loads history, leaves the channel, forces a full GC through CDP, and reads
// the JS heap and process memory at each step.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { footprintFor, mb } from "./footprint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(here, "../../../electron");
const require = createRequire(path.join(electronRoot, "package.json"));
const { _electron } = require("@playwright/test");
const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4183";
const { BENCH_SERVER_ID: S, BENCH_LIGHT_CHANNEL: L } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(path.join(tmpdir(), "pqp-ret-"));
const app = await _electron.launch({
  args: [electronRoot, `--user-data-dir=${dir}`],
  env: { ...process.env, PQP_APP_URL: `${BASE}/app/server/${S}/channel/${L}?lang=en`, NODE_ENV: "test" },
});
const page = await app.firstWindow();
await page.waitForFunction(() => document.body?.textContent.includes("o estrela é esse"), null, { polling: 50, timeout: 60_000 });
const cdp = await page.context().newCDPSession(page);
const snap = async (label) => {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(500);
  const heap = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
  const procs = (await app.evaluate(({ app: a }) => a.getAppMetrics())).map((m) => ({ pid: m.pid, type: m.type }));
  const fp = footprintFor(procs);
  const tab = fp.rows.filter((r) => r.type === "Tab").reduce((s, r) => s + r.footprint, 0);
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length);
  return { label, jsHeapAfterGcMB: heap, domNodes: dom, rendererMB: mb(tab), totalMB: mb(fp.total) };
};
const click = (name) =>
  page.evaluate((n) => {
    const hit = [...document.querySelectorAll("a, button")].find((e) => (e.textContent ?? "").trim().startsWith(n) && !e.closest("main"));
    hit?.click();
  }, name);
const out = [await snap("light, fresh")];
await click("off-topic");
await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("const x = 5000"), null, { polling: 50 });
for (let i = 0; i < 60; i++) {
  const c = await page.evaluate(() => document.querySelectorAll("article").length);
  if (c >= 2000) break;
  await page.evaluate(() => {
    let el = document.querySelector("article")?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
    if (el) el.scrollTop = 0;
  });
  await page.waitForFunction((n) => document.querySelectorAll("article").length > n, c, { polling: 50, timeout: 5000 }).catch(() => {});
}
out.push(await snap("heavy, 2000 rows mounted"));
await click("general");
await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("o estrela é esse"), null, { polling: 50 });
await sleep(3000);
out.push(await snap("left heavy, back on light"));
await sleep(20_000);
out.push(await snap("light, 20 s later"));
await click("off-topic");
await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("const x = 5000"), null, { polling: 50 });
await sleep(2000);
out.push(await snap("heavy again"));
console.log(JSON.stringify(out, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });
