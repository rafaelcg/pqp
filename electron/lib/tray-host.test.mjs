import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  WATCHER,
  parseNameHasOwner,
  probeEnv,
  probeStatusNotifierWatcher,
  linuxTrayHostAvailable,
  trayNeedsRecreate,
} = require("./tray-host.js");

describe("parseNameHasOwner", () => {
  it("reads gdbus", () => {
    assert.equal(parseNameHasOwner("(true,)\n"), true);
    assert.equal(parseNameHasOwner("(false,)\n"), false);
  });

  it("reads dbus-send", () => {
    const reply = (value) =>
      `method return time=1760000000.1 sender=org.freedesktop.DBus -> destination=:1.99 serial=3 reply_serial=2\n   boolean ${value}\n`;
    assert.equal(parseNameHasOwner(reply("true")), true);
    assert.equal(parseNameHasOwner(reply("false")), false);
  });

  it("is null for anything else", () => {
    for (const out of ["", "Error: ...", "(uint32 1,)", undefined]) {
      assert.equal(parseNameHasOwner(out), null);
    }
  });
});

describe("probeStatusNotifierWatcher", () => {
  it("asks gdbus for the watcher Chromium registers with", async () => {
    const calls = [];
    const run = async (tool, args) => {
      calls.push([tool, args]);
      return "(true,)";
    };
    assert.equal(await probeStatusNotifierWatcher({ run, env: {} }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "gdbus");
    assert.ok(calls[0][1].includes(WATCHER));
    assert.equal(WATCHER, "org.kde.StatusNotifierWatcher");
  });

  it("falls back to dbus-send when gdbus is missing", async () => {
    const run = async (tool) => {
      if (tool === "gdbus") {
        throw Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" });
      }
      return "method return ...\n   boolean false\n";
    };
    assert.equal(await probeStatusNotifierWatcher({ run, env: {} }), false);
  });

  it("is null when neither tool can ask", async () => {
    const run = async () => {
      throw new Error("no session bus");
    };
    assert.equal(await probeStatusNotifierWatcher({ run, env: {} }), null);
  });

  it("does not hand the AppImage's library path to the host's tools", async () => {
    let seen;
    const run = async (_tool, _args, env) => {
      seen = env;
      return "(true,)";
    };
    await probeStatusNotifierWatcher({
      run,
      env: {
        APPIMAGE: "/home/a/pqp.AppImage",
        LD_LIBRARY_PATH: "/tmp/.mount_pqp/usr/lib",
        HOME: "/home/a",
      },
    });
    assert.equal(seen.LD_LIBRARY_PATH, undefined);
    assert.equal(seen.HOME, "/home/a");
  });

  it("leaves the library path alone outside an AppImage", () => {
    const env = { LD_LIBRARY_PATH: "/opt/x" };
    assert.equal(probeEnv(env), env);
  });
});

describe("linuxTrayHostAvailable", () => {
  it("believes the bus over the desktop's name", () => {
    // GNOME that is not Ubuntu, with the AppIndicator extension on: the old
    // guess said no tray and the app quit on close.
    assert.equal(linuxTrayHostAvailable(true, { XDG_CURRENT_DESKTOP: "GNOME" }), true);
    // A sway or Hyprland session with no tray module: the guess said yes and
    // hid the window to nowhere.
    assert.equal(linuxTrayHostAvailable(false, { XDG_CURRENT_DESKTOP: "sway" }), false);
    assert.equal(linuxTrayHostAvailable(false, { XDG_CURRENT_DESKTOP: "KDE" }), false);
  });

  it("guesses from the desktop's name only when the bus could not be asked", () => {
    assert.equal(linuxTrayHostAvailable(null, { XDG_CURRENT_DESKTOP: "GNOME" }), false);
    assert.equal(linuxTrayHostAvailable(null, { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), true);
    assert.equal(linuxTrayHostAvailable(null, { XDG_CURRENT_DESKTOP: "KDE" }), true);
  });
});

describe("trayNeedsRecreate", () => {
  it("only when the tray was made with no host and a host is there now", () => {
    assert.equal(trayNeedsRecreate(false, true), true);
    assert.equal(trayNeedsRecreate(true, true), false);
    assert.equal(trayNeedsRecreate(null, true), false);
    assert.equal(trayNeedsRecreate(false, false), false);
    assert.equal(trayNeedsRecreate(false, null), false);
  });
});

describe("main.js wiring", () => {
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");

  it("decides close with closeAction and a tray that is really drawn", () => {
    assert.match(main, /closeAction\(\{/);
    assert.match(main, /trayAvailable: trayCanHoldWindow\(\)/);
    assert.match(main, /linuxTrayHostAvailable\(trayHostWatcher\)/);
    assert.doesNotMatch(main, /trayLikelyAvailable\(process\.platform\)/);
  });

  it("minimizes rather than hides when closeAction says so", () => {
    assert.match(main, /action === "minimize"[\s\S]{0,80}mainWindow\?\.minimize\(\)/);
  });

  it("asks the bus before the tray is created", () => {
    const probe = main.indexOf("refreshTrayHost({ force: true })");
    const create = main.indexOf("createTray();", probe);
    assert.notEqual(probe, -1);
    assert.ok(create > probe);
  });
});
