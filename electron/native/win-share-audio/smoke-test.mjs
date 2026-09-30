#!/usr/bin/env node
/**
 * CI smoke test for the Windows share-audio add-on, on windows-latest.
 *
 * WHAT IT CAN PROVE AND WHAT IT CANNOT. The runner is Windows Server 2022
 * (build 20348) with no audio device, so it can never hear anything, and a
 * test that asserted "the capture started" would be asserting something that
 * machine cannot do. It proves the rest: the binary loads in a real Node on
 * Windows, the N-API surface is what `lib/win-share-audio.js` expects, the
 * process table and window lookups answer, and activation returns the SAME
 * known answer every run. `--expect <mode>=<type>:<stage>:<hr>` pins that
 * answer, so a change that breaks activation differently (a wrong struct
 * layout, a bad PROPVARIANT, a crash) fails here instead of on somebody's PC.
 *
 * Starting and stopping also exercises the thread and queue teardown: the
 * script must exit on its own, which a leaked threadsafe function prevents.
 * `stop()` must also hand control back at once, even while activation is still
 * pending (the JavaScript thread is the audio host's only thread for protocol
 * messages), and the capture must still report "ended" afterwards.
 *
 *   node smoke-test.mjs [--arch x64] [--expect exclude=error:activate:0x88890010]
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  captureTargetForSource,
  formatHresult,
  loadWinShareAudioAddon,
} = require("../../lib/win-share-audio.js");

function arg(name) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

const arch = arg("--arch")[0] ?? process.arch;
const expected = new Map(
  arg("--expect").map((spec) => {
    const [mode, rest] = spec.split("=");
    return [mode, rest];
  }),
);

const loaded = loadWinShareAudioAddon({ arch, baseDir: path.join(here, "..", "..") });
assert.equal(loaded.reason, null, `add-on did not load: ${loaded.reason} (${loaded.file})`);
const addon = loaded.addon;
console.log(`loaded ${loaded.file} on ${os.release()} ${process.arch}`);

// The N-API surface, as `lib/win-share-audio*.js` calls it.
for (const name of ["startCapture", "windowOwner", "listProcesses", "processCreationTime"]) {
  assert.equal(typeof addon[name], "function", `missing ${name}`);
}

const processes = addon.listProcesses();
const self = processes.find((row) => row.pid === process.pid);
assert.ok(self, "listProcesses does not contain this process");
assert.match(self.exe.toLowerCase(), /node(\.exe)?$/);
assert.equal(self.parentPid, process.ppid);
assert.equal(typeof addon.processCreationTime(process.pid), "number");
assert.equal(addon.processCreationTime(0xfffffffc), null);
assert.equal(addon.windowOwner(0), null);
assert.equal(addon.windowOwner(1), null);
assert.throws(() => addon.startCapture(process.pid, "sideways", () => {}, () => {}));

// A screen share always excludes our own tree, whatever the machine.
assert.deepEqual(captureTargetForSource("screen:0:0", process.pid, addon), {
  mode: "exclude",
  pid: process.pid,
  reason: "screen",
  exe: null,
});

function firstOutcome(mode) {
  return new Promise((resolve, reject) => {
    const events = [];
    let capture = null;
    const timer = setTimeout(() => reject(new Error(`${mode}: no event in 10 s`)), 10_000);
    capture = addon.startCapture(
      process.pid,
      mode,
      () => {},
      (event) => {
        events.push(event);
        if (event.type === "started" || event.type === "error") {
          clearTimeout(timer);
          // Let "ended" arrive through the queue, which is the teardown path.
          setImmediate(() => {
            capture.stop();
            // The join happens off this thread, so "ended" arrives a moment
            // after stop() returns: wait for it, not for a fixed time.
            const deadline = Date.now() + 5_000;
            const wait = () => {
              if (events.some((e) => e.type === "ended") || Date.now() > deadline) {
                resolve({ first: event, events });
              } else {
                setTimeout(wait, 20);
              }
            };
            wait();
          });
        }
      },
    );
  });
}

/**
 * Stop right after start, before the audio service has answered (activation
 * is asynchronous, so on any machine this lands mid-activation or just after
 * it). The call must return at once, must be safe to repeat, and the capture
 * must still report "ended": a stop that blocked for the activation timeout,
 * or one that leaked the thread, fails here.
 */
function stopWhilePending(mode) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error(`${mode}: no "ended" after stop in 10 s`)), 10_000);
    const capture = addon.startCapture(
      process.pid,
      mode,
      () => {},
      (event) => {
        events.push(event);
        if (event.type === "ended") {
          clearTimeout(timer);
          // Give a duplicate "ended" the chance to show itself.
          setTimeout(() => resolve(events), 200);
        }
      },
    );
    const began = performance.now();
    capture.stop();
    const tookMs = performance.now() - began;
    capture.stop();
    assert.ok(tookMs < 1_000, `${mode}: stop() blocked the calling thread for ${Math.round(tookMs)} ms`);
    console.log(`${mode}: stop() while pending returned in ${tookMs.toFixed(1)} ms`);
  });
}

let failures = 0;
for (const mode of ["exclude", "include"]) {
  const { first, events } = await firstOutcome(mode);
  const seen = `${first.type}:${first.stage || "-"}:${formatHresult(first.hr)}`;
  console.log(`${mode}: ${seen} (events: ${events.map((e) => e.type).join(", ")})`);
  assert.ok(
    events.some((event) => event.type === "ended"),
    `${mode}: the capture thread never reported "ended"`,
  );
  const want = expected.get(mode);
  if (want && want.toLowerCase() !== seen.toLowerCase()) {
    console.error(`::error::${mode}: expected ${want}, got ${seen}`);
    failures += 1;
  }
}

for (const mode of ["exclude", "include"]) {
  const events = await stopWhilePending(mode);
  assert.equal(
    events.filter((e) => e.type === "ended").length,
    1,
    `${mode}: "ended" must be reported exactly once`,
  );
}

if (failures > 0) {
  process.exit(1);
}
console.log("share-audio add-on smoke test passed");
