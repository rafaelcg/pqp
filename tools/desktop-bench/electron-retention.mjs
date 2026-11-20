// Is the memory a 2000-row channel costs given back when you leave it?
// Loads history, leaves the channel, forces a full GC through CDP, and reads
// the JS heap and process memory at each step.
//
//   node tools/desktop-bench/stack-up.mjs   (leave it running; export the BENCH_* it prints)
//   node tools/desktop-bench/electron-retention.mjs
import { footprintFor, mb } from "./footprint.mjs";
import { freshUserDataDir, launchElectron, removeDir, sleep } from "./lib/electron.mjs";
import { clickSidebar, HEAVY_LAST_MARKER, LIGHT_MARKER, loadHistory, waitForText } from "./lib/page-actions.mjs";

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4183";
const { BENCH_SERVER_ID: S, BENCH_LIGHT_CHANNEL: L } = process.env;
if (!S || !L) throw new Error("export BENCH_SERVER_ID and BENCH_LIGHT_CHANNEL (stack-up.mjs prints them)");

const dir = freshUserDataDir();
const launched = await launchElectron({ url: `${BASE}/app/server/${S}/channel/${L}?lang=en`, userDataDir: dir });
const { app, page } = launched;
await waitForText(page, LIGHT_MARKER);
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
const click = (name) => clickSidebar(page, name);
const out = [await snap("light, fresh")];
await click("off-topic");
await waitForText(page, HEAVY_LAST_MARKER, 30_000, "main");
if (!(await loadHistory(page)).loaded) throw new Error("the oldest message never appeared");
out.push(await snap("heavy, 2000 rows mounted"));
await click("general");
await waitForText(page, LIGHT_MARKER, 30_000, "main");
await sleep(3000);
out.push(await snap("left heavy, back on light"));
await sleep(20_000);
out.push(await snap("light, 20 s later"));
await click("off-topic");
await waitForText(page, HEAVY_LAST_MARKER, 30_000, "main");
await sleep(2000);
out.push(await snap("heavy again"));
console.log(JSON.stringify(out, null, 2));
await launched.close();
removeDir(dir);
