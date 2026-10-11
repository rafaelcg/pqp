import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { isFlatpak } = require("./flatpak.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, "..", ...parts), "utf8");

const none = () => false;

describe("isFlatpak", () => {
  it("is false on a plain Linux install", () => {
    assert.equal(isFlatpak({ env: {}, exists: none, platform: "linux" }), false);
  });

  it("is true when Flatpak set FLATPAK_ID", () => {
    assert.equal(isFlatpak({ env: { FLATPAK_ID: "gg.pqp.pqp" }, exists: none, platform: "linux" }), true);
  });

  it("is true when /.flatpak-info is there, even with a cleared environment", () => {
    const exists = (p) => p === "/.flatpak-info";
    assert.equal(isFlatpak({ env: {}, exists, platform: "linux" }), true);
  });

  it("ignores an empty FLATPAK_ID", () => {
    assert.equal(isFlatpak({ env: { FLATPAK_ID: "" }, exists: none, platform: "linux" }), false);
  });

  it("is false off Linux whatever the environment says", () => {
    assert.equal(isFlatpak({ env: { FLATPAK_ID: "x" }, exists: () => true, platform: "darwin" }), false);
    assert.equal(isFlatpak({ env: { FLATPAK_ID: "x" }, exists: () => true, platform: "win32" }), false);
  });

  it("treats a throwing probe as not a Flatpak", () => {
    const exists = () => {
      throw new Error("EACCES");
    };
    assert.equal(isFlatpak({ env: {}, exists, platform: "linux" }), false);
  });
});

/**
 * The wiring, read off the source (a sandboxed preload cannot require this
 * module, so the gate has to travel as an argument, like the Windows 11 one).
 */
describe("what a Flatpak build turns off", () => {
  const main = read("main.js");
  const preload = read("preload.js");
  const updater = read("lib", "updater.js");

  it("never runs the in-app updater", () => {
    assert.match(updater, /isFlatpak\(\)/);
  });

  it("builds no Linux share audio bus and tells the preload", () => {
    assert.match(main, /process\.platform === "linux" && !runningInFlatpak/);
    assert.match(main, /--pqp-flatpak=\$\{runningInFlatpak \? "1" : "0"\}/);
  });

  it("does not promise linuxShareAudio to the page, and says why", () => {
    assert.match(preload, /linuxShareAudio:\s*process\.platform === "linux" && !runningInFlatpak/);
    assert.match(preload, /flatpak:\s*runningInFlatpak/);
  });
});
