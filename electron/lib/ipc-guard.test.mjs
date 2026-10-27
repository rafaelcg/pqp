import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createIpcGuard, frameOrigin } = require("./ipc-guard.js");

const APP = "https://pqp.gg";
const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(here, "..", "main.js"), "utf8");

/** A stand-in for `ipcMain` that keeps the listener it is given. */
function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
}

function setup({ origin = APP, start = 1_000_000 } = {}) {
  const ipcMain = fakeIpcMain();
  const warnings = [];
  const clock = { now: start };
  const guard = createIpcGuard({
    ipcMain,
    getAppOrigin: () => origin,
    warn: (line) => warnings.push(line),
    now: () => clock.now,
  });
  return { ipcMain, warnings, clock, guard };
}

const fromApp = { senderFrame: { url: "https://pqp.gg/app/server/1" } };
const fromClerk = { senderFrame: { url: "https://attacker-7.clerk.accounts.dev/sign-in" } };
const fromGoogle = { senderFrame: { url: "https://accounts.google.com/o/oauth2/auth" } };

describe("guarded handle: the channels the renderer invokes", () => {
  it("runs the handler for the app origin and passes the arguments through", async () => {
    const { ipcMain, guard, warnings } = setup();
    guard.handle("pqp:ptt-bind-native", (_event, binding, delay) => ({ binding, delay }), {
      rejected: { registered: false, via: "none" },
    });
    const result = await ipcMain.handlers.get("pqp:ptt-bind-native")(fromApp, { key: 1 }, 40);
    assert.deepEqual(result, { binding: { key: 1 }, delay: 40 });
    assert.deepEqual(warnings, []);
  });

  it("answers `rejected` and never runs the handler for a page that is not the app", async () => {
    const { ipcMain, guard, warnings } = setup();
    let ran = 0;
    guard.handle(
      "pqp:ptt-bind-native",
      () => {
        ran += 1;
        return { registered: true, via: "native" };
      },
      { rejected: { registered: false, via: "none" } },
    );
    for (const event of [fromClerk, fromGoogle]) {
      assert.deepEqual(await ipcMain.handlers.get("pqp:ptt-bind-native")(event, {}, 0), {
        registered: false,
        via: "none",
      });
    }
    assert.equal(ran, 0);
    assert.equal(warnings.length, 2);
  });

  it("accepts a function for `rejected`, and undefined when there is none", async () => {
    const { ipcMain, guard } = setup();
    guard.handle("a", () => "ran", { rejected: (event) => event.senderFrame.url.length });
    guard.handle("b", () => "ran");
    assert.equal(await ipcMain.handlers.get("a")(fromClerk), fromClerk.senderFrame.url.length);
    assert.equal(await ipcMain.handlers.get("b")(fromClerk), undefined);
  });

  it("fails closed with no frame, no origin to compare to, or a URL that does not parse", async () => {
    for (const event of [{}, { senderFrame: null }, { senderFrame: { url: "" } }, { senderFrame: { url: "not a url" } }]) {
      const { ipcMain, guard } = setup();
      guard.handle("c", () => "ran", { rejected: "no" });
      assert.equal(await ipcMain.handlers.get("c")(event), "no");
    }
    const { ipcMain, guard } = setup({ origin: null });
    guard.handle("c", () => "ran", { rejected: "no" });
    assert.equal(await ipcMain.handlers.get("c")(fromApp), "no");
  });

  it("is not fooled by an origin that merely starts with the app origin", async () => {
    const { ipcMain, guard } = setup();
    guard.handle("c", () => "ran", { rejected: "no" });
    for (const url of ["https://pqp.gg.evil.example/app", "https://pqp.gg@evil.example/", "http://pqp.gg/app"]) {
      assert.equal(await ipcMain.handlers.get("c")({ senderFrame: { url } }), "no", url);
    }
  });
});

describe("guarded on: the fire-and-forget channels", () => {
  it("delivers from the app and drops everything else", () => {
    const { ipcMain, guard, warnings } = setup();
    const seen = [];
    guard.on("pqp:notify", (_event, payload) => seen.push(payload));
    ipcMain.listeners.get("pqp:notify")(fromApp, { title: "x" });
    ipcMain.listeners.get("pqp:notify")(fromClerk, { title: "spoofed" });
    assert.deepEqual(seen, [{ title: "x" }]);
    assert.equal(warnings.length, 1);
  });
});

describe("check with `sender`: the share picker window", () => {
  it("accepts exactly that webContents, whatever URL it sits on", () => {
    const { guard, warnings } = setup();
    const picker = { isDestroyed: () => false };
    const other = { isDestroyed: () => false };
    assert.equal(guard.check({ sender: picker, senderFrame: { url: "file:///app/picker/index.html" } }, "pqp:picker-choose", { sender: picker }), true);
    assert.equal(guard.check({ sender: other }, "pqp:picker-choose", { sender: picker }), false);
    // An app-origin frame is not the picker: this class is identity only.
    assert.equal(guard.check({ sender: other, ...fromApp }, "pqp:picker-choose", { sender: picker }), false);
    assert.equal(warnings.length, 2);
  });

  it("refuses once the picker window is destroyed", () => {
    const { guard } = setup();
    const picker = { isDestroyed: () => true };
    assert.equal(guard.check({ sender: picker }, "pqp:picker-choose", { sender: picker }), false);
  });
});

describe("the rejection log line", () => {
  it("is one loud line with the channel and the sender's origin, and nothing else", () => {
    const { ipcMain, guard, warnings } = setup();
    guard.handle("pqp:set-badge", () => {});
    ipcMain.handlers.get("pqp:set-badge")({
      senderFrame: { url: "https://attacker-7.clerk.accounts.dev/sign-in?token=SECRET&email=a@b.c#frag" },
    }, 5);
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0],
      "[pqp] ipc rejected: channel=pqp:set-badge sender-origin=https://attacker-7.clerk.accounts.dev",
    );
    assert.doesNotMatch(warnings[0], /SECRET|a@b\.c|frag|sign-in/);
  });

  it("says `none` for a frame that is gone and names the scheme for an opaque origin", () => {
    assert.equal(frameOrigin({}), "none");
    assert.equal(frameOrigin({ senderFrame: { url: "data:text/html,x" } }), "data:");
    assert.equal(frameOrigin({ senderFrame: { url: "::::" } }), "unparseable");
  });

  it("does not repeat itself for a page that hammers one channel, and speaks again later", () => {
    const { ipcMain, guard, warnings, clock } = setup();
    guard.on("pqp:notify", () => {});
    for (let i = 0; i < 50; i++) {
      ipcMain.listeners.get("pqp:notify")(fromClerk, {});
    }
    assert.equal(warnings.length, 1);
    // Another channel from the same page is its own line.
    guard.on("pqp:signed-in", () => {});
    ipcMain.listeners.get("pqp:signed-in")(fromClerk, true);
    assert.equal(warnings.length, 2);
    clock.now += 31_000;
    ipcMain.listeners.get("pqp:notify")(fromClerk, {});
    assert.equal(warnings.length, 3);
  });
});

describe("main.js registers every channel through the guard", () => {
  it("has no direct ipcMain.handle / ipcMain.on outside the picker, which uses guard.check", () => {
    const direct = [...mainSource.matchAll(/ipcMain\.(handle|on|once)\(\s*"([^"]+)"/g)].map((m) => m[2]);
    assert.deepEqual(
      direct.sort(),
      ["pqp:picker-cancel", "pqp:picker-choose", "pqp:picker-load", "pqp:picker-ready"],
      "A new ipcMain channel must be registered with ipcGuard.handle / ipcGuard.on (lib/ipc-guard.js), not ipcMain directly.",
    );
    // The picker's four channels each ask the guard before doing anything.
    for (const channel of direct) {
      assert.match(
        mainSource,
        new RegExp(`fromPicker\\(event, "${channel}"\\)`),
        `${channel} must call fromPicker(event, "${channel}")`,
      );
    }
  });

  it("does not use ipcMain.handleOnce or removeHandler for anything but the picker", () => {
    assert.doesNotMatch(mainSource, /ipcMain\.handleOnce\(/);
    const removed = [...mainSource.matchAll(/ipcMain\.removeHandler\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(removed)], ["pqp:picker-load"]);
  });

  it("registers the channels the audit found unguarded through ipcGuard", () => {
    for (const channel of [
      "pqp:set-theme",
      "pqp:set-locale",
      "pqp:set-badge",
      "pqp:ptt-bind",
      "pqp:ptt-bind-native",
      "pqp:ptt-permission-status",
      "pqp:ptt-native-capability",
      "pqp:ptt-open-permission-settings",
      "pqp:global-voice-bind",
      "pqp:voice-state",
      "pqp:signed-in",
      "pqp:notify",
      "pqp:get-pending-deep-link",
    ]) {
      assert.match(
        mainSource,
        new RegExp(`ipcGuard\\.(handle|on)\\(\\s*"${channel}"`),
        `${channel} is not registered through ipcGuard`,
      );
    }
  });

  it("builds the guard over sessionAppOrigin, the value navigation pinning uses", () => {
    assert.match(mainSource, /createIpcGuard\(\{ ipcMain, getAppOrigin: \(\) => sessionAppOrigin \}\)/);
    assert.match(mainSource, /sessionAppOrigin = allowedOrigin;/);
    assert.doesNotMatch(mainSource, /senderMatchesAppOrigin/);
  });
});
