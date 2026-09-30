import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  windowHandleFromSourceId,
  indexProcesses,
  ancestorsOf,
  appRootProcess,
  resolveWindowProcess,
  captureTargetForSource,
  addonCandidates,
  loadWinShareAudioAddon,
  formatHresult,
  ADDON_ABI,
} = require("./win-share-audio.js");

/**
 * A small Windows. pqp (4000) was started by explorer (1000); its renderer
 * (4001) is its child. Chrome's browser process (2000) owns the window, its
 * renderer (2001) and audio service (2002) are children. Firefox the same.
 * A game (3000) started by Steam (2900). A Store app (5000) inside
 * ApplicationFrameHost (4800). A terminal (6000) that is an ancestor of a dev
 * pqp (6200 via 6100).
 */
const PROCESSES = [
  { pid: 4, parentPid: 0, exe: "System" },
  { pid: 1000, parentPid: 900, exe: "explorer.exe" },
  { pid: 4000, parentPid: 1000, exe: "pqp.exe" },
  { pid: 4001, parentPid: 4000, exe: "pqp.exe" },
  { pid: 2000, parentPid: 1000, exe: "chrome.exe" },
  { pid: 2001, parentPid: 2000, exe: "chrome.exe" },
  { pid: 2002, parentPid: 2000, exe: "chrome.exe" },
  { pid: 2900, parentPid: 1000, exe: "steam.exe" },
  { pid: 3000, parentPid: 2900, exe: "Game.exe" },
  { pid: 3001, parentPid: 3000, exe: "Game.exe" },
  { pid: 4800, parentPid: 700, exe: "ApplicationFrameHost.exe" },
  { pid: 5000, parentPid: 701, exe: "Spotify.exe" },
  { pid: 6000, parentPid: 1000, exe: "WindowsTerminal.exe" },
  { pid: 6100, parentPid: 6000, exe: "node.exe" },
  { pid: 6200, parentPid: 6100, exe: "electron.exe" },
];

function fakeAddon({ owners = {}, processes = PROCESSES, created = {} } = {}) {
  return {
    windowOwner: (hwnd) => owners[hwnd] ?? null,
    listProcesses: () => processes,
    processCreationTime: (pid) => created[pid] ?? null,
  };
}

describe("windowHandleFromSourceId", () => {
  it("reads the HWND out of a desktopCapturer window id", () => {
    assert.equal(windowHandleFromSourceId("window:132456:0"), 132456);
  });

  it("refuses screens, garbage and zero", () => {
    assert.equal(windowHandleFromSourceId("screen:0:0"), null);
    assert.equal(windowHandleFromSourceId("window:abc:0"), null);
    assert.equal(windowHandleFromSourceId("window:0:0"), null);
    assert.equal(windowHandleFromSourceId(null), null);
  });
});

describe("the process walk", () => {
  const table = indexProcesses(PROCESSES);

  it("walks up while the executable stays the same", () => {
    assert.equal(appRootProcess(2001, table), 2000);
    assert.equal(appRootProcess(3001, table), 3000);
  });

  it("stops at a different executable, so a game is not its launcher", () => {
    assert.equal(appRootProcess(3000, table), 3000);
  });

  it("lists ancestors nearest first and stops where the table does", () => {
    assert.deepEqual(ancestorsOf(4001, table), [4000, 1000]);
  });

  it("does not trust a parent created after its child (PID reuse)", () => {
    const created = { 2001: 10, 2000: 20 };
    assert.equal(appRootProcess(2001, table, (pid) => created[pid] ?? null), 2001);
  });

  it("survives a cycle", () => {
    const loop = indexProcesses([
      { pid: 10, parentPid: 11, exe: "a.exe" },
      { pid: 11, parentPid: 10, exe: "a.exe" },
    ]);
    assert.equal(appRootProcess(10, loop), 11);
    assert.deepEqual(ancestorsOf(10, loop), [11]);
  });

  it("finds the Store app inside ApplicationFrameHost", () => {
    assert.equal(resolveWindowProcess({ pid: 4800, childPids: [4800, 5000] }, table), 5000);
    assert.equal(resolveWindowProcess({ pid: 4800, childPids: [] }, table), 4800);
    assert.equal(resolveWindowProcess({ pid: 2000, childPids: [2001] }, table), 2000);
  });
});

describe("captureTargetForSource", () => {
  it("excludes our own tree for a screen, which keeps the call out", () => {
    assert.deepEqual(captureTargetForSource("screen:1:0", 4000, fakeAddon()), {
      mode: "exclude",
      pid: 4000,
      reason: "screen",
      exe: null,
    });
  });

  it("includes the browser process that owns a Chrome window", () => {
    const target = captureTargetForSource(
      "window:77:0",
      4000,
      fakeAddon({ owners: { 77: { pid: 2000, childPids: [] } } }),
    );
    assert.deepEqual(target, { mode: "include", pid: 2000, reason: "window-app", exe: "chrome.exe" });
  });

  it("includes the app root when a helper process owns the window", () => {
    const target = captureTargetForSource(
      "window:78:0",
      4000,
      fakeAddon({ owners: { 78: { pid: 3001, childPids: [] } } }),
    );
    assert.equal(target.mode, "include");
    assert.equal(target.pid, 3000);
    assert.equal(target.reason, "window-app-root");
  });

  it("never includes one of our own windows: that would be the call itself", () => {
    const target = captureTargetForSource(
      "window:79:0",
      4000,
      fakeAddon({ owners: { 79: { pid: 4001, childPids: [] } } }),
    );
    assert.deepEqual(target, { mode: "exclude", pid: 4000, reason: "own-window", exe: null });
  });

  it("never includes a process pqp runs under: Explorer started us", () => {
    const target = captureTargetForSource(
      "window:80:0",
      4000,
      fakeAddon({ owners: { 80: { pid: 1000, childPids: [] } } }),
    );
    assert.deepEqual(target, { mode: "exclude", pid: 4000, reason: "target-contains-pqp", exe: null });
  });

  it("never includes the terminal a dev pqp was started from", () => {
    const target = captureTargetForSource(
      "window:81:0",
      6200,
      fakeAddon({ owners: { 81: { pid: 6000, childPids: [] } } }),
    );
    assert.equal(target.mode, "exclude");
    assert.equal(target.reason, "target-contains-pqp");
  });

  it("falls back to exclude when the window is gone or the lookup throws", () => {
    assert.equal(captureTargetForSource("window:82:0", 4000, fakeAddon()).reason, "window-gone");
    const broken = { windowOwner: () => { throw new Error("boom"); }, listProcesses: () => [] };
    assert.equal(captureTargetForSource("window:83:0", 4000, broken).reason, "window-lookup-failed");
  });

  it("answers nothing for a source it does not understand", () => {
    assert.equal(captureTargetForSource("tab:1", 4000, fakeAddon()), null);
    assert.equal(captureTargetForSource("screen:0:0", 0, fakeAddon()), null);
  });
});

describe("loadWinShareAudioAddon", () => {
  it("does nothing off Windows", () => {
    assert.deepEqual(loadWinShareAudioAddon({ platform: "darwin" }), {
      addon: null,
      reason: "platform",
      file: null,
    });
  });

  it("says missing when no binary is on disk", () => {
    const result = loadWinShareAudioAddon({ platform: "win32", arch: "x64", exists: () => false });
    assert.equal(result.reason, "missing");
  });

  it("loads the prebuild, from the unpacked copy when packaged", () => {
    const base = path.join("C:", "pqp", "resources", "app.asar");
    const [prebuild] = addonCandidates(base, "arm64");
    assert.match(prebuild, /app\.asar\.unpacked/);
    assert.match(prebuild, /win32-arm64/);
    const addon = { abi: ADDON_ABI, startCapture() {} };
    const result = loadWinShareAudioAddon({
      platform: "win32",
      arch: "arm64",
      baseDir: base,
      exists: (file) => file === prebuild,
      requireNative: () => addon,
    });
    assert.equal(result.addon, addon);
    assert.equal(result.reason, null);
  });

  it("refuses a binary from another ABI, and one that will not load", () => {
    const exists = () => true;
    assert.equal(
      loadWinShareAudioAddon({ platform: "win32", exists, requireNative: () => ({ abi: 99 }) }).reason,
      "abi",
    );
    const failed = loadWinShareAudioAddon({
      platform: "win32",
      exists,
      requireNative: () => {
        throw new Error("The specified module could not be found.");
      },
    });
    assert.match(failed.reason, /^load-failed: The specified module/);
  });
});

describe("formatHresult", () => {
  it("prints HRESULTs the way Windows documentation does", () => {
    assert.equal(formatHresult(0x88890010), "0x88890010");
    assert.equal(formatHresult(-2004287472), "0x88890010");
    assert.equal(formatHresult(0), "0x00000000");
    assert.equal(formatHresult(null), "n/a");
  });
});
