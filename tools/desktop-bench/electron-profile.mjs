// Where the renderer's time and heap go in the three hot spots the bench found:
// history held in memory, leaving a channel with that history, and sitting in a
// call. Run against an UNMINIFIED build so function names survive.
//
// Needs the stack (stack-up.mjs, pointed at an unminified client build with
// `--client-dist`) and its BENCH_* variables exported.
//
//   node tools/desktop-bench/electron-profile.mjs
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshUserDataDir, launchElectron, removeDir, sleep } from "./lib/electron.mjs";
import { joinVoice } from "./lib/call.mjs";
import { clickSidebar, HEAVY_LAST_MARKER, LIGHT_MARKER, loadHistory, waitForText } from "./lib/page-actions.mjs";

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4183";
const OUT = process.env.BENCH_OUT ?? tmpdir();
const { BENCH_SERVER_ID: S, BENCH_LIGHT_CHANNEL: L } = process.env;
if (!S || !L) throw new Error("export BENCH_SERVER_ID and BENCH_LIGHT_CHANNEL (stack-up.mjs prints them)");

function topSelf(profile, n = 25) {
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const total = new Map();
  profile.samples.forEach((id, i) => total.set(id, (total.get(id) ?? 0) + (dt[i] ?? 0)));
  for (const [id, us] of total) {
    const node = byId.get(id);
    const cf = node.callFrame;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const sum = [...self.values()].reduce((a, b) => a + b, 0);
  return {
    totalMs: Math.round(sum / 1000),
    top: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`),
  };
}

function topAlloc(sampling, n = 25) {
  const out = new Map();
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const here = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
    if (node.selfSize) out.set(here, (out.get(here) ?? 0) + node.selfSize);
    for (const c of node.children ?? []) walk(c, stack);
  };
  walk(sampling.profile.head, []);
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  return {
    totalMB: Math.round(sum / 1048576),
    top: [...out.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, b]) => `${Math.round(b / 1048576 * 10) / 10}MB ${k}`),
  };
}

const dir = freshUserDataDir();
const launched = await launchElectron({ url: `${BASE}/app/server/${S}/channel/${L}?lang=en`, userDataDir: dir });
const { page } = launched;
await waitForText(page, LIGHT_MARKER);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("HeapProfiler.enable");

await clickSidebar(page, "off-topic");
await waitForText(page, HEAVY_LAST_MARKER, 30_000, "main");

// Heap: what is still alive after the whole history is mounted.
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
await cdp.send("Profiler.start");
await loadHistory(page);
const loadCpu = await cdp.send("Profiler.stop");
await cdp.send("HeapProfiler.collectGarbage");
const heap = await cdp.send("HeapProfiler.stopSampling");

// CPU: leaving the heavy channel.
await cdp.send("Profiler.start");
const t0 = Date.now();
await clickSidebar(page, "general");
await waitForText(page, LIGHT_MARKER, 30_000, "main");
const leaveMs = Date.now() - t0;
const leaveCpu = await cdp.send("Profiler.stop");

// CPU: in a call for 10 s.
await joinVoice(page);
await sleep(3000);
await cdp.send("Profiler.start");
await sleep(10_000);
const callCpu = await cdp.send("Profiler.stop");

writeFileSync(path.join(OUT, "leave.cpuprofile"), JSON.stringify(leaveCpu.profile));
writeFileSync(path.join(OUT, "call.cpuprofile"), JSON.stringify(callCpu.profile));
console.log(JSON.stringify({
  historyLoadCpu: topSelf(loadCpu.profile, 15),
  liveHeapAfterHistory: topAlloc(heap, 25),
  leaveMs,
  leaveCpu: topSelf(leaveCpu.profile, 25),
  callCpu10s: topSelf(callCpu.profile, 25),
}, null, 2));
await launched.close();
removeDir(dir);
