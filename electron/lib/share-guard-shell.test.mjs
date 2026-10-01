import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, "..", ...parts), "utf8");
const main = read("main.js");
const preload = read("preload.js");
const priority = read("lib", "share-priority.js");

/**
 * THE SHELL'S HALF OF `share_high_motion_guard`, READ OFF THE SOURCE.
 *
 * `main.js` cannot be required without an Electron runtime, so the wiring is
 * pinned the way `share-capabilities.test.mjs` pins the preload: by reading
 * it. The behaviour of the priority boost and the GPU summary has real unit
 * tests beside this (`share-priority.test.mjs`, `gpu-status.test.mjs`); what
 * is pinned here is that they are connected, scoped to the app window, and
 * undone on every way a share can end.
 */
describe("the share priority wiring in main.js", () => {
  it("answers the app window only, on both channels", () => {
    for (const channel of ["share-live", "share-health"]) {
      const at = main.indexOf(`ipcMain.handle("pqp:${channel}"`);
      assert.notEqual(at, -1, `no handler for ${channel}`);
      const body = main.slice(at, main.indexOf("\n  });", at));
      assert.match(body, /senderMatchesAppOrigin\(event, sessionAppOrigin\)/, channel);
    }
  });

  it("raises on an explicit true only, and treats anything else as over", () => {
    assert.match(main, /live === true \? sharePriority\.start\(\) : sharePriority\.stop\(\)/);
  });

  it("hands the real process list, priorities and platform to the controller", () => {
    assert.match(main, /platform: process\.platform/);
    assert.match(main, /listProcesses: \(\) => app\.getAppMetrics\(\)/);
    assert.match(main, /PRIORITY_ABOVE_NORMAL/);
    assert.ok(!/PRIORITY_HIGH\b|PRIORITY_HIGHEST/.test(main), "the boost never goes past above-normal");
  });

  it("lets go when the page reloads, its renderer dies, or the app quits", () => {
    assert.match(main, /"did-start-navigation"[\s\S]{0,200}isMainFrame === true[\s\S]{0,120}sharePriority\.stop\(\)/);
    assert.match(main, /"render-process-gone", \(\) => sharePriority\.stop\(\)/);
    const quit = main.indexOf('app.on("before-quit"');
    assert.ok(main.slice(quit, quit + 300).includes("sharePriority.stop()"));
  });

  it("exposes both calls to the page, as the client contract declares", () => {
    assert.match(preload, /setShareLive\(live\)\s*\{[\s\S]*?"pqp:share-live"/);
    assert.match(preload, /shareHealth\(\)\s*\{[\s\S]*?"pqp:share-health"/);
  });
});

describe("hardware acceleration", () => {
  it("never turns the GPU, or hardware video encode, off", () => {
    // The bundled Chromium enables the Media Foundation hardware encoder on
    // Windows by default. A switch here that disabled acceleration would be
    // the only way this shell could end up on the software encoder by choice.
    assert.ok(!/disableHardwareAcceleration/.test(main));
    assert.ok(!/appendSwitch\(\s*["']disable-(gpu|accelerated|features)/.test(main));
    assert.ok(!/appendSwitch\(\s*["']in-process-gpu/.test(main));
  });

  it("logs the GPU feature status once at startup, and once more when the GPU info lands", () => {
    assert.match(main, /app\.getGPUFeatureStatus\(\)/);
    assert.match(main, /logGpuStatus\(\);\s*\n\s*app\.once\("gpu-info-update", logGpuStatus\)/);
  });
});

describe("the priority module", () => {
  it("only ever raises to above-normal and never past it", () => {
    assert.match(priority, /ABOVE_NORMAL: -7/);
    assert.ok(!/PRIORITY_HIGH|PRIORITY_REALTIME|HIGHEST/.test(priority));
  });
});
