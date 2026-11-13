/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Drives the GPUI prototype through the same steps electron-bench.mjs runs on
// the Electron shell, measured the same way (wall clock from spawn, macOS
// phys_footprint, CPU seconds from ps).
//
//   GPUI_BIN=.../pqp-gpui-spike PQP_SERVER_ID=... node spikes/rust-shell/bench/gpui-bench.mjs [full|startup] [runs]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { physFootprintBytes, cpuSeconds, mb } from "./footprint.mjs";

const BIN = process.env.GPUI_BIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function start() {
  const t0 = Date.now();
  const child = spawn(BIN, [], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const i = waiters.findIndex((w) => line.startsWith(w.prefix));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(line);
  });
  const waitFor = (prefix, ms = 60_000) =>
    new Promise((resolve, reject) => {
      waiters.push({ prefix, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${prefix}`)), ms);
    });
  const send = (cmd) => child.stdin.write(`${cmd}\n`);
  return { child, t0, waitFor, send };
}

const mem = (pid) => mb(physFootprintBytes(pid));
async function cpu(pid, ms) {
  const a = cpuSeconds(pid);
  await sleep(ms);
  return Math.round(((cpuSeconds(pid) - a) / (ms / 1000)) * 10000) / 100;
}

async function main() {
  const mode = process.argv[2] ?? "full";
  if (mode === "startup") {
    const runs = [];
    for (let i = 0; i < Number(process.argv[3] ?? 5); i++) {
      const app = start();
      const first = await app.waitFor("FIRST_CONTENT");
      const contentMs = Number(first.split(" ")[1]) - app.t0;
      await sleep(3000);
      runs.push({ contentMs, memMB: mem(app.child.pid) });
      app.send("quit");
      await new Promise((r) => app.child.on("exit", r));
    }
    console.log(JSON.stringify({ runs, median: { contentMs: median(runs.map((r) => r.contentMs)), memMB: median(runs.map((r) => r.memMB)) } }, null, 2));
    return;
  }
  const app = start();
  const pid = app.child.pid;
  const out = {};
  const first = await app.waitFor("FIRST_CONTENT");
  out.startupContentMs = Number(first.split(" ")[1]) - app.t0;
  await sleep(10_000);
  out.memIdleLightMB = mem(pid);
  out.cpuIdleLight30sPct = await cpu(pid, 30_000);
  const toHeavy = [];
  const toLight = [];
  for (let i = 0; i < 5; i++) {
    app.send("switch off-topic");
    toHeavy.push(Number((await app.waitFor("DONE switch off-topic")).split(" ").pop()));
    await sleep(500);
    app.send("switch general");
    toLight.push(Number((await app.waitFor("DONE switch general")).split(" ").pop()));
    await sleep(500);
  }
  out.switchMs = { toHeavy, toLight, medianHeavy: median(toHeavy), medianLight: median(toLight) };
  app.send("switch off-topic");
  await app.waitFor("DONE switch off-topic");
  await sleep(1000);
  app.send("sweep");
  out.sweepAt50 = JSON.parse((await app.waitFor("DONE sweep")).slice("DONE sweep ".length));
  for (const target of [2000, 5000]) {
    app.send(`loadall ${target}`);
    out[`history${target}`] = (await app.waitFor("DONE loadall", 120_000)).slice(5);
    await sleep(2000);
    out[`mem${target}MB`] = mem(pid);
    app.send("sweep");
    out[`sweepAt${target}`] = JSON.parse((await app.waitFor("DONE sweep", 300_000)).slice("DONE sweep ".length));
  }
  app.send("switch general");
  out.switchFromHeavyMs = Number((await app.waitFor("DONE switch general")).split(" ").pop());
  await sleep(3000);
  out.memAfterLeavingHeavyMB = mem(pid);
  out.cpuIdleAfterHeavy30sPct = await cpu(pid, 30_000);
  app.send("quit");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
