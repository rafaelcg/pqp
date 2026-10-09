import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  FALLBACK_APP_ID,
  appUserModelId,
  shouldSetAppUserModelId,
  notificationSilent,
  notificationOptions,
} = require("./notify-options.js");
const pkg = require("../package.json");

describe("appUserModelId", () => {
  it("is the electron-builder appId", () => {
    assert.equal(appUserModelId(pkg), pkg.build.appId);
    assert.equal(appUserModelId(pkg), "gg.pqp.app");
  });

  it("the fallback constant cannot drift from package.json", () => {
    assert.equal(FALLBACK_APP_ID, pkg.build.appId);
  });

  it("falls back when the field is missing or not a string", () => {
    assert.equal(appUserModelId({}), FALLBACK_APP_ID);
    assert.equal(appUserModelId(null), FALLBACK_APP_ID);
    assert.equal(appUserModelId({ build: { appId: "  " } }), FALLBACK_APP_ID);
    assert.equal(appUserModelId({ build: { appId: 7 } }), FALLBACK_APP_ID);
  });

  it("is set on Windows and nowhere else", () => {
    assert.equal(shouldSetAppUserModelId("win32"), true);
    assert.equal(shouldSetAppUserModelId("darwin"), false);
    assert.equal(shouldSetAppUserModelId("linux"), false);
  });

  it("main.js sets it before the app is ready", () => {
    const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    const set = main.indexOf("app.setAppUserModelId(");
    assert.notEqual(set, -1, "main.js never calls app.setAppUserModelId");
    assert.ok(set < main.indexOf("app.whenReady()"), "it must run before whenReady");
  });
});

describe("notificationSilent", () => {
  it("stays silent when the app plays its own sound", () => {
    assert.equal(notificationSilent({ silent: true }), true);
  });

  it("lets the OS sound play only when the renderer says silent: false", () => {
    assert.equal(notificationSilent({ silent: false }), false);
  });

  it("keeps today's silent banner for a renderer that never sends the field", () => {
    assert.equal(notificationSilent({}), true);
    assert.equal(notificationSilent(undefined), true);
  });

  it("ignores anything that is not the boolean false", () => {
    for (const value of [0, "", null, "false", undefined]) {
      assert.equal(notificationSilent({ silent: value }), true);
    }
  });
});

describe("notificationOptions", () => {
  it("builds the Notification options", () => {
    assert.deepEqual(notificationOptions({ title: "a", body: "b", silent: false }), {
      title: "a",
      body: "b",
      silent: false,
    });
    assert.deepEqual(notificationOptions({ title: "a" }), {
      title: "a",
      body: "",
      silent: true,
    });
  });
});
