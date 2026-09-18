import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { loginItemSupported } = require("./login-item.js");

describe("loginItemSupported", () => {
  it("is true on macOS and Windows, where Electron's login-item API works", () => {
    assert.equal(loginItemSupported("darwin"), true);
    assert.equal(loginItemSupported("win32"), true);
  });

  it("is false on Linux, where the API is a silent no-op", () => {
    assert.equal(loginItemSupported("linux"), false);
  });

  it("is false for anything unrecognized rather than assuming support", () => {
    assert.equal(loginItemSupported("freebsd"), false);
    assert.equal(loginItemSupported(undefined), false);
  });
});
