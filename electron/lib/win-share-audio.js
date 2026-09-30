"use strict";

/**
 * Screen share sound on Windows the way Discord and OBS do it: per process,
 * through WASAPI process loopback, never through the speakers mixer.
 *
 * THE RULE THIS FILE KEEPS. The call must never reach the share. Chromium's
 * own `loopback` taps the whole render endpoint and only strips this app on
 * Windows 11 (`display-sources.js`), which is why Windows 10 shares went out
 * silent. Process loopback asks the audio engine for exactly one process tree
 * instead, so the call is left out by construction rather than by a filter:
 *
 * - SCREEN share: everything EXCEPT our own tree
 *   (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, our main PID). The
 *   renderer that plays the call and Chromium's audio service are children of
 *   the main process, so both are outside the capture.
 * - WINDOW share: ONLY the app that owns the window
 *   (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`). That is Discord's
 *   behaviour and the better one: the room hears the game, not the
 *   presenter's notifications.
 *
 * INCLUDE HAS ONE WAY TO LEAK, and it is not obvious. "The target's tree" is
 * the target and every process it started. If pqp is itself somewhere below
 * the target, including the target includes the call. That is the ordinary
 * case, not an exotic one: sharing a File Explorer window targets
 * explorer.exe, which is usually our own parent; a terminal window started
 * `pnpm electron:dev`; Chrome can be the parent of a pqp opened from a
 * `pqp://` link. Every such window falls back to EXCLUDE on our own tree,
 * which is still call-free and is what Windows 11 gets today. Same fallback
 * for sharing one of our own windows, where INCLUDE would be the call itself.
 *
 * WHICH PROCESS IS "THE APP". `GetWindowThreadProcessId` answers for the
 * window, and the sound is often somewhere else:
 *
 * - Chrome, Edge, Brave, Opera: the window belongs to the browser process and
 *   the audio service is its child, so the window's PID already covers it.
 * - Firefox: same shape, content processes are children of the main one.
 * - A child process that owns a window of its own (some launchers, some
 *   Electron apps' secondary windows): walk up while the parent is the same
 *   executable, so the whole app is captured and not one helper.
 * - UWP / Store apps: the top-level frame belongs to ApplicationFrameHost.exe
 *   and the app owns the CoreWindow inside it. The native side lists the
 *   owners of child windows so this file can pick the real app.
 *
 * Limits, documented rather than guessed around: a game whose audio runs in
 * a process that is neither the window's owner nor its descendant (a separate
 * launcher-owned audio helper) is not captured; the share is then silent for
 * that game, never leaky. PID reuse is checked by creation time on the walk.
 *
 * Everything here is plain data in, plain data out, with the add-on passed in,
 * so it runs under `node --test` on a Mac and in CI. The add-on itself is only
 * loaded by `win-share-audio-host.js`, inside a utility process: a native
 * crash there costs the share its sound, not the app its window.
 */

const fs = require("node:fs");
const path = require("node:path");

const MODE_INCLUDE = "include";
const MODE_EXCLUDE = "exclude";

/** The add-on's own version number. A binary that says otherwise is not loaded. */
const ADDON_ABI = 1;

const ADDON_FILE = "pqp_share_audio.node";

/** PIDs 0 and 4 are the idle process and System. Never a target, never a parent. */
function isSystemPid(pid) {
  return !Number.isInteger(pid) || pid <= 4;
}

/**
 * `window:<HWND>:0` to the HWND as a number. `desktopCapturer` puts the raw
 * handle in the id on Windows; it is a pointer-sized integer, but handles are
 * 32-bit significant, so it always fits a double exactly.
 */
function windowHandleFromSourceId(id) {
  if (typeof id !== "string") {
    return null;
  }
  const match = /^window:(\d+):/.exec(id);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exeKey(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** `listProcesses()` rows to a map by PID, dropping anything malformed. */
function indexProcesses(rows) {
  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Number.isInteger(row.pid) || !Number.isInteger(row.parentPid)) {
      continue;
    }
    table.set(row.pid, { pid: row.pid, parentPid: row.parentPid, exe: String(row.exe ?? "") });
  }
  return table;
}

/**
 * The parent of `pid`, or null.
 *
 * Toolhelp reports the PID the process was started by, and Windows reuses
 * PIDs: a parent that exited can be replaced by an unrelated process with the
 * same number. A "parent" created after its child is that case, and is not a
 * parent. `creationTime` is optional; without it the walk trusts the table.
 */
function parentOf(pid, table, creationTime) {
  const entry = table.get(pid);
  if (!entry || isSystemPid(entry.parentPid) || entry.parentPid === pid) {
    return null;
  }
  if (!table.has(entry.parentPid)) {
    return null;
  }
  if (typeof creationTime === "function") {
    const child = creationTime(pid);
    const parent = creationTime(entry.parentPid);
    if (typeof child === "number" && typeof parent === "number" && parent > child) {
      return null;
    }
  }
  return entry.parentPid;
}

/** Every ancestor of `pid`, nearest first. Stops at a cycle, System, or a gap. */
function ancestorsOf(pid, table, creationTime) {
  const out = [];
  const seen = new Set([pid]);
  let current = pid;
  for (;;) {
    const parent = parentOf(current, table, creationTime);
    if (parent === null || seen.has(parent)) {
      return out;
    }
    out.push(parent);
    seen.add(parent);
    current = parent;
  }
}

/**
 * The top of an application: walk up while the parent runs the same
 * executable. Chrome's renderer to Chrome's browser process, a game's helper
 * to the game. Stops at the first different executable, so a game started by
 * Steam is the game, not Steam.
 */
function appRootProcess(pid, table, creationTime) {
  const exe = exeKey(table.get(pid)?.exe);
  if (!exe) {
    return pid;
  }
  let current = pid;
  const seen = new Set([pid]);
  for (;;) {
    const parent = parentOf(current, table, creationTime);
    if (parent === null || seen.has(parent) || exeKey(table.get(parent)?.exe) !== exe) {
      return current;
    }
    seen.add(parent);
    current = parent;
  }
}

/**
 * The process that actually draws a window, from `windowOwner(hwnd)`.
 *
 * A Store app's frame is owned by ApplicationFrameHost.exe, which plays no
 * sound; the app is whoever owns the CoreWindow inside the frame.
 */
function resolveWindowProcess(owner, table) {
  if (!owner || !Number.isInteger(owner.pid) || isSystemPid(owner.pid)) {
    return null;
  }
  if (exeKey(table.get(owner.pid)?.exe) === "applicationframehost.exe") {
    const inner = (Array.isArray(owner.childPids) ? owner.childPids : []).find(
      (pid) =>
        Number.isInteger(pid) &&
        !isSystemPid(pid) &&
        exeKey(table.get(pid)?.exe) !== "applicationframehost.exe",
    );
    if (inner !== undefined) {
      return inner;
    }
  }
  return owner.pid;
}

/**
 * What to capture for the surface the person picked.
 *
 * Returns `{ mode, pid, reason, exe }`, or null for a source id this module
 * does not understand (no sound, the safe answer). `reason` is for the log
 * and the probe, never for a branch: every fallback already chose the mode.
 *
 * `addon` needs `windowOwner`, `listProcesses` and (optionally)
 * `processCreationTime`; tests pass a fake.
 */
function captureTargetForSource(sourceId, ownPid, addon) {
  if (!Number.isInteger(ownPid) || isSystemPid(ownPid)) {
    return null;
  }
  const exclude = (reason) => ({ mode: MODE_EXCLUDE, pid: ownPid, reason, exe: null });
  if (typeof sourceId === "string" && sourceId.startsWith("screen:")) {
    return exclude("screen");
  }
  const hwnd = windowHandleFromSourceId(sourceId);
  if (hwnd === null) {
    return typeof sourceId === "string" && sourceId.startsWith("window:")
      ? exclude("window-id-unreadable")
      : null;
  }

  let owner = null;
  let table = new Map();
  try {
    owner = addon.windowOwner(hwnd);
    table = indexProcesses(addon.listProcesses());
  } catch {
    return exclude("window-lookup-failed");
  }
  const times = new Map();
  const creationTime =
    typeof addon.processCreationTime === "function"
      ? (pid) => {
          if (!times.has(pid)) {
            let value = null;
            try {
              value = addon.processCreationTime(pid);
            } catch {
              value = null;
            }
            times.set(pid, typeof value === "number" ? value : null);
          }
          return times.get(pid);
        }
      : undefined;

  const windowPid = resolveWindowProcess(owner, table);
  if (windowPid === null) {
    return exclude("window-gone");
  }
  const root = appRootProcess(windowPid, table, creationTime);
  // One of our own windows (the app, the picker, a popup): INCLUDE would be
  // the call itself.
  if (root === ownPid || ancestorsOf(root, table, creationTime).includes(ownPid)) {
    return exclude("own-window");
  }
  // We run inside the target's tree (explorer.exe started us, a terminal
  // started `electron:dev`): INCLUDE would carry our tree, and the call, too.
  if (ancestorsOf(ownPid, table, creationTime).includes(root)) {
    return exclude("target-contains-pqp");
  }
  return {
    mode: MODE_INCLUDE,
    pid: root,
    reason: root === windowPid ? "window-app" : "window-app-root",
    exe: table.get(root)?.exe ?? null,
  };
}

/**
 * Where the binary for this machine lives, most specific first.
 *
 * Packaged: `prebuilds/win32-<arch>/` next to this add-on's sources, unpacked
 * from the asar (a `.node` cannot be loaded from inside an archive). Dev: the
 * `node-gyp` output, so `pnpm electron:dev` on a Windows box with build tools
 * uses what it just compiled.
 */
function addonCandidates(baseDir, arch) {
  const root = path.join(baseDir, "native", "win-share-audio");
  const unpacked = (file) => file.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  return [
    unpacked(path.join(root, "prebuilds", `win32-${arch}`, ADDON_FILE)),
    unpacked(path.join(root, "build", "Release", ADDON_FILE)),
  ];
}

/**
 * Load the add-on, or say why not. Never throws: every failure here is "no
 * native sound on this machine", which is today's behaviour, and must not
 * cost the share or the app anything else.
 */
function loadWinShareAudioAddon({
  platform = process.platform,
  arch = process.arch,
  baseDir = path.join(__dirname, ".."),
  exists = fs.existsSync,
  requireNative = require,
} = {}) {
  if (platform !== "win32") {
    return { addon: null, reason: "platform", file: null };
  }
  const file = addonCandidates(baseDir, arch).find((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
  if (!file) {
    return { addon: null, reason: "missing", file: null };
  }
  let addon;
  try {
    addon = requireNative(file);
  } catch (err) {
    return { addon: null, reason: `load-failed: ${err?.message ?? err}`, file };
  }
  if (!addon || addon.abi !== ADDON_ABI || typeof addon.startCapture !== "function") {
    return { addon: null, reason: "abi", file };
  }
  return { addon, reason: null, file };
}

/** An HRESULT as Windows documentation spells it, for logs and the probe. */
function formatHresult(hr) {
  if (!Number.isFinite(hr)) {
    return "n/a";
  }
  return `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

module.exports = {
  MODE_INCLUDE,
  MODE_EXCLUDE,
  ADDON_ABI,
  windowHandleFromSourceId,
  indexProcesses,
  ancestorsOf,
  appRootProcess,
  resolveWindowProcess,
  captureTargetForSource,
  addonCandidates,
  loadWinShareAudioAddon,
  formatHresult,
};
