import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ALLOW_OVERRIDE_ENV, resolveAppUrlSource } = require("./app-url.js");

const PROD = "https://pqp.gg/app";
const DEV = "http://localhost:5173/app";
const STAGING = "https://staging.pqp-3yr.pages.dev";

const pick = (env, isPackaged) =>
  resolveAppUrlSource({ env, isPackaged, prodUrl: PROD, devUrl: DEV });

describe("resolveAppUrlSource", () => {
  it("an installed build loads production and ignores PQP_APP_URL / VITE_APP_URL", () => {
    for (const env of [{ PQP_APP_URL: "https://evil.example" }, { VITE_APP_URL: "https://evil.example" }]) {
      assert.deepEqual(pick(env, true), { url: PROD, source: "default", ignored: true });
    }
  });

  it("an installed build with nothing set loads production, quietly", () => {
    assert.deepEqual(pick({}, true), { url: PROD, source: "default", ignored: false });
  });

  it("a development shell still honours both variables (pnpm electron:dev, the Playwright specs)", () => {
    assert.deepEqual(pick({ PQP_APP_URL: STAGING }, false), { url: STAGING, source: "override", ignored: false });
    assert.deepEqual(pick({ VITE_APP_URL: STAGING }, false), { url: STAGING, source: "override", ignored: false });
    assert.equal(pick({ PQP_APP_URL: "http://127.0.0.1:4000", VITE_APP_URL: STAGING }, false).url, "http://127.0.0.1:4000");
  });

  it("a development shell with nothing set loads the Vite dev server", () => {
    assert.deepEqual(pick({}, false), { url: DEV, source: "default", ignored: false });
  });

  it("an installed build honours the override only behind the explicit switch", () => {
    for (const value of ["1", "true"]) {
      assert.deepEqual(pick({ PQP_APP_URL: STAGING, [ALLOW_OVERRIDE_ENV]: value }, true), {
        url: STAGING,
        source: "override",
        ignored: false,
      });
    }
    // Anything that is not exactly 1 / true is off.
    for (const value of ["0", "false", "yes", "", " 1"]) {
      assert.equal(pick({ PQP_APP_URL: STAGING, [ALLOW_OVERRIDE_ENV]: value }, true).url, PROD, value);
    }
  });

  it("the switch alone, with no URL, changes nothing", () => {
    assert.deepEqual(pick({ [ALLOW_OVERRIDE_ENV]: "1" }, true), { url: PROD, source: "default", ignored: false });
  });
});

describe("main.js", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainSource = readFileSync(path.join(here, "..", "main.js"), "utf8");

  it("reads PQP_APP_URL / VITE_APP_URL only through resolveAppUrlSource", () => {
    const reads = [...mainSource.matchAll(/process\.env\.(PQP_APP_URL|VITE_APP_URL)/g)];
    assert.equal(reads.length, 0, "main.js must not read the override variables directly");
    assert.match(mainSource, /resolveAppUrlSource\(\{\s*env: process\.env,\s*isPackaged: app\.isPackaged/);
  });
});
