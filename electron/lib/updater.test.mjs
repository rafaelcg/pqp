import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

/**
 * The shell updater with electron and electron-updater stubbed. A development
 * run never reaches this code (`app.isPackaged` is false), so this is the
 * evidence for the two behaviours a packaged app has:
 *  - a page that draws the update button drives it: nothing downloads until it
 *    asks, there is no native box, and install refuses without a download;
 *  - a page that never asks (an older bundle) keeps the old behaviour: the
 *    update downloads by itself and the native box is shown once.
 */

const require = createRequire(import.meta.url);
const updaterPath = require.resolve("./updater.js");
const realLoad = Module._load;

let fakeUpdater;
let boxes;
let originalEnv;

function makeFakeUpdater() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    calls: [],
    checkForUpdates() {
      this.calls.push("check");
      return Promise.resolve();
    },
    downloadUpdate() {
      this.calls.push("download");
      return Promise.resolve([]);
    },
    quitAndInstall(...args) {
      this.calls.push(["install", ...args]);
    },
  });
}

beforeEach(() => {
  fakeUpdater = makeFakeUpdater();
  boxes = [];
  originalEnv = process.env.PQP_DISABLE_AUTO_UPDATE;
  delete process.env.PQP_DISABLE_AUTO_UPDATE;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { isPackaged: true, on() {}, getLocale: () => "en", getPreferredSystemLanguages: () => ["en"] },
        dialog: {
          showMessageBox: async (...args) => {
            boxes.push(args);
            return { response: 1 };
          },
        },
      };
    }
    if (request === "electron-updater") {
      return { autoUpdater: fakeUpdater };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  delete require.cache[updaterPath];
});

afterEach(() => {
  Module._load = realLoad;
  delete require.cache[updaterPath];
  if (originalEnv === undefined) {
    delete process.env.PQP_DISABLE_AUTO_UPDATE;
  } else {
    process.env.PQP_DISABLE_AUTO_UPDATE = originalEnv;
  }
});

function start() {
  const { initAutoUpdate } = require("./updater.js");
  const states = [];
  const controller = initAutoUpdate(() => null, () => false, {
    onState: (state) => states.push(state),
  });
  return { controller, states };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the shell updater, driven by the page", () => {
  it("does not download by itself and never opens the box", async () => {
    const { controller, states } = start();
    controller.attach();
    assert.equal(fakeUpdater.autoDownload, false);
    assert.equal(fakeUpdater.autoInstallOnAppQuit, true);
    fakeUpdater.emit("checking-for-update");
    fakeUpdater.emit("update-available", { version: "0.9.0" });
    await tick();
    assert.deepEqual(fakeUpdater.calls, []);
    assert.deepEqual(states.at(-1), { status: "available", version: "0.9.0" });

    controller.download();
    assert.deepEqual(fakeUpdater.calls, ["download"]);
    fakeUpdater.emit("download-progress", { percent: 50 });
    assert.deepEqual(states.at(-1), { status: "downloading", version: "0.9.0", percent: 50 });
    fakeUpdater.emit("update-downloaded", { version: "0.9.0" });
    await tick();
    assert.deepEqual(states.at(-1), { status: "downloaded", version: "0.9.0" });
    assert.equal(boxes.length, 0);
  });

  it("installs only once something is downloaded", () => {
    const { controller } = start();
    controller.attach();
    assert.equal(controller.install(), false);
    fakeUpdater.emit("update-available", { version: "0.9.0" });
    assert.equal(controller.install(), false);
    fakeUpdater.emit("update-downloaded", { version: "0.9.0" });
    assert.equal(controller.install(), true);
    assert.deepEqual(fakeUpdater.calls.at(-1), ["install", true, true]);
  });

  it("does not start a second download while one runs", () => {
    const { controller } = start();
    controller.attach();
    fakeUpdater.emit("update-available", { version: "0.9.0" });
    controller.download();
    controller.download();
    assert.deepEqual(fakeUpdater.calls, ["download"]);
  });

  it("retries a failed check as a check, not a download", () => {
    const { controller } = start();
    controller.attach();
    fakeUpdater.emit("checking-for-update");
    fakeUpdater.emit("error", new Error("offline"));
    assert.deepEqual(controller.getState(), { status: "error", context: "check", version: null });
    controller.download();
    assert.deepEqual(fakeUpdater.calls, ["check"]);
  });
});

describe("the shell updater, for a page that never asks", () => {
  it("downloads by itself and shows the native box once", async () => {
    start();
    fakeUpdater.emit("update-available", { version: "0.9.0" });
    assert.deepEqual(fakeUpdater.calls, ["download"]);
    fakeUpdater.emit("update-downloaded", { version: "0.9.0" });
    await tick();
    assert.equal(boxes.length, 1);
    // "Later" was the answer; the hourly check reports it again.
    fakeUpdater.emit("update-downloaded", { version: "0.9.0" });
    await tick();
    assert.equal(boxes.length, 1);
  });
});

describe("a disabled updater", () => {
  it("answers disabled and does nothing", () => {
    process.env.PQP_DISABLE_AUTO_UPDATE = "1";
    const { controller } = start();
    assert.deepEqual(controller.getState(), { status: "disabled" });
    controller.check();
    controller.download();
    assert.equal(controller.install(), false);
    assert.deepEqual(fakeUpdater.calls, []);
  });
});
