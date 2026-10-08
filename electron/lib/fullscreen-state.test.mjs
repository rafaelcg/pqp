import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  createFullscreenState,
  parseQunsOutput,
  SCRIPT,
  ENCODED_SCRIPT,
} = require("./fullscreen-state.js");

describe("parseQunsOutput", () => {
  it("reads QUNS_RUNNING_D3D_FULL_SCREEN as exclusive fullscreen", () => {
    assert.deepEqual(parseQunsOutput("0 3\r\n"), {
      state: "d3d-fullscreen",
      raw: 3,
      exclusiveFullscreen: true,
    });
  });

  it("reads every other documented state as not exclusive fullscreen", () => {
    for (const [raw, state] of [
      [1, "not-present"],
      [2, "busy"],
      [4, "presentation"],
      [5, "accepts-notifications"],
      [6, "quiet-time"],
      [7, "app"],
    ]) {
      assert.deepEqual(parseQunsOutput(`0 ${raw}`), { state, raw, exclusiveFullscreen: false });
    }
  });

  it("is unknown on a failed HRESULT, an undocumented state or garbage", () => {
    assert.equal(parseQunsOutput("-2147467259 0").exclusiveFullscreen, null);
    assert.equal(parseQunsOutput("0 42").state, "unknown");
    assert.equal(parseQunsOutput("Add-Type : Cannot add type").state, "unknown");
    assert.equal(parseQunsOutput("").state, "unknown");
  });
});

describe("createFullscreenState", () => {
  it("answers unsupported off Windows without spawning anything", async () => {
    let spawned = 0;
    const state = createFullscreenState({
      platform: "darwin",
      execFile: () => {
        spawned += 1;
      },
    });
    assert.equal((await state.query()).state, "unsupported");
    assert.equal(spawned, 0);
  });

  it("asks PowerShell once with the encoded script, and caches the answer", async () => {
    const calls = [];
    let clock = 0;
    const state = createFullscreenState({
      platform: "win32",
      now: () => clock,
      execFile: (file, args, options, cb) => {
        calls.push({ file, args, options });
        setImmediate(() => cb(null, "0 3"));
      },
    });
    const [a, b] = await Promise.all([state.query(), state.query()]);
    assert.equal(a.exclusiveFullscreen, true);
    assert.equal(b.exclusiveFullscreen, true);
    assert.equal(calls.length, 1, "two concurrent questions share one process");
    assert.equal(calls[0].file, "powershell.exe");
    assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT]);
    assert.equal(calls[0].options.windowsHide, true);
    assert.ok(calls[0].options.timeout > 0);

    clock = 1_000;
    await state.query();
    assert.equal(calls.length, 1, "cached for a few seconds");
    clock = 10_000;
    await state.query();
    assert.equal(calls.length, 2, "asked again once the cache is old");
  });

  it("is unknown when PowerShell fails or cannot start", async () => {
    const failing = createFullscreenState({
      platform: "win32",
      execFile: (_f, _a, _o, cb) => cb(new Error("ENOENT"), ""),
    });
    assert.equal((await failing.query()).exclusiveFullscreen, null);
    const throwing = createFullscreenState({
      platform: "win32",
      execFile: () => {
        throw new Error("spawn EPERM");
      },
    });
    assert.equal((await throwing.query()).exclusiveFullscreen, null);
  });

  it("asks one documented shell32 call and nothing that touches another process", () => {
    assert.match(SCRIPT, /SHQueryUserNotificationState/);
    assert.equal(Buffer.from(ENCODED_SCRIPT, "base64").toString("utf16le"), SCRIPT);
    // The rule from docs/DESKTOP.md: no hooks, no other process's memory.
    for (const forbidden of [/OpenProcess/i, /ReadProcessMemory/i, /CreateRemoteThread/i, /SetWindowsHookEx/i, /Get-Process/i]) {
      assert.doesNotMatch(SCRIPT, forbidden);
    }
  });
});
