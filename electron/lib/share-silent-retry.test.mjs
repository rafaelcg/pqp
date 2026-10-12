import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createShareSilentRetry, SILENT_RETRY_WINDOW_MS } = require("./share-silent-retry.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(here, "..", "main.js"), "utf8");
const preload = readFileSync(path.join(here, "..", "preload.js"), "utf8");

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const screen = { id: "screen:0:0", name: "Screen 1" };

describe("share silent retry (PQP-31)", () => {
  it("reuses the surface of a failed loopback request once, video-only", () => {
    const c = clock();
    const retry = createShareSilentRetry({ now: c.now });
    assert.equal(retry.take(true), null);
    retry.rememberLoopback(screen);
    assert.equal(retry.arm(), true);
    assert.equal(retry.take(false), screen);
    // One-shot: the next request opens the picker as usual.
    assert.equal(retry.take(false), null);
    assert.equal(retry.arm(), false);
  });

  it("arms nothing when the last request did not carry loopback", () => {
    const retry = createShareSilentRetry();
    assert.equal(retry.arm(), false);
    retry.rememberLoopback(screen);
    // A new request (a cancelled picker, a share without sound) clears it.
    assert.equal(retry.take(true), null);
    assert.equal(retry.arm(), false);
  });

  it("never hands the surface to a request that asks for sound again", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen);
    assert.equal(retry.arm(), true);
    assert.equal(retry.take(true), null);
    assert.equal(retry.take(false), null);
  });

  it("never reuses a surface without the page arming first", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen);
    assert.equal(retry.take(false), null);
  });

  it("expires, so a stale surface is never shared without a picker", () => {
    const c = clock();
    const retry = createShareSilentRetry({ now: c.now });
    retry.rememberLoopback(screen);
    c.advance(SILENT_RETRY_WINDOW_MS + 1);
    assert.equal(retry.arm(), false);
    assert.equal(retry.take(false), null);

    retry.rememberLoopback(screen);
    assert.equal(retry.arm(), true);
    c.advance(SILENT_RETRY_WINDOW_MS + 1);
    assert.equal(retry.take(false), null);
  });

  it("is wired into the display-media handler and origin-checked", () => {
    assert.match(main, /const silentRetrySource = shareSilentRetry\.take\(audioRequested\);/);
    assert.match(main, /return captureResponse\(silentRetrySource, platform, false, os\.release\(\)\);/);
    assert.match(main, /if \(response\?\.audio === "loopback"\) \{\s*shareSilentRetry\.rememberLoopback\(source\);/);
    const at = main.indexOf('ipcMain.handle("pqp:share-silent-retry-arm"');
    assert.ok(at > 0, "arm handler registered");
    assert.match(main.slice(at, at + 300), /senderMatchesAppOrigin\(event, sessionAppOrigin\)/);
  });

  it("is published to the page as a capability and a bridge method", () => {
    assert.match(preload, /silentRetry: true/);
    assert.match(preload, /ipcRenderer\.invoke\("pqp:share-silent-retry-arm"\)/);
  });
});
