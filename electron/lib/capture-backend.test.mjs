import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { screenCapturerFor } = require("./capture-backend.js");

describe("screenCapturerFor (Chromium 152's choice, docs/DESKTOP.md)", () => {
  it("is Windows Graphics Capture for a screen from Windows 11 24H2 (build 26100)", () => {
    assert.deepEqual(screenCapturerFor("win32", "10.0.26100"), { build: 26100, screen: "wgc", window: "wgc" });
    assert.equal(screenCapturerFor("win32", "10.0.26200").screen, "wgc");
  });

  it("is DXGI duplication with GDI behind it below 24H2, Windows 10 included", () => {
    assert.equal(screenCapturerFor("win32", "10.0.22631").screen, "dxgi-gdi");
    assert.equal(screenCapturerFor("win32", "10.0.19045").screen, "dxgi-gdi");
  });

  it("says nothing it does not know", () => {
    assert.deepEqual(screenCapturerFor("darwin", "25.6.0"), { build: null, screen: null, window: null });
    assert.equal(screenCapturerFor("win32", "garbage").screen, null);
  });
});
