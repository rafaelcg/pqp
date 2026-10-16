import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createShareSilentRetry, requesterKey, SILENT_RETRY_WINDOW_MS } = require("./share-silent-retry.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(here, "..", "main.js"), "utf8");
const preload = readFileSync(path.join(here, "..", "preload.js"), "utf8");

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const screen = { id: "screen:0:0", name: "Screen 1" };
const win = "4:1";
const otherWin = "7:1";

describe("share silent retry (PQP-31)", () => {
  it("reuses the surface of a failed loopback request once, video-only", () => {
    const c = clock();
    const retry = createShareSilentRetry({ now: c.now });
    assert.equal(retry.take(true, win), null);
    retry.rememberLoopback(screen, win);
    assert.equal(retry.arm(win), true);
    assert.equal(retry.take(false, win), screen);
    // One-shot: the next request opens the picker as usual.
    assert.equal(retry.take(false, win), null);
    assert.equal(retry.arm(win), false);
  });

  it("arms nothing when the last request did not carry loopback", () => {
    const retry = createShareSilentRetry();
    assert.equal(retry.arm(win), false);
    retry.rememberLoopback(screen, win);
    // A new request (a cancelled picker, a share without sound) clears it.
    assert.equal(retry.take(true, win), null);
    assert.equal(retry.arm(win), false);
  });

  it("never hands the surface to a request that asks for sound again", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen, win);
    assert.equal(retry.arm(win), true);
    assert.equal(retry.take(true, win), null);
    assert.equal(retry.take(false, win), null);
  });

  it("never reuses a surface without the page arming first", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen, win);
    assert.equal(retry.take(false, win), null);
  });

  it("expires, so a stale surface is never shared without a picker", () => {
    const c = clock();
    const retry = createShareSilentRetry({ now: c.now });
    retry.rememberLoopback(screen, win);
    c.advance(SILENT_RETRY_WINDOW_MS + 1);
    assert.equal(retry.arm(win), false);
    assert.equal(retry.take(false, win), null);

    retry.rememberLoopback(screen, win);
    assert.equal(retry.arm(win), true);
    c.advance(SILENT_RETRY_WINDOW_MS + 1);
    assert.equal(retry.take(false, win), null);
  });

  it("belongs to the frame that made the request", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen, win);
    // Another window can neither arm it nor disarm it.
    assert.equal(retry.arm(otherWin), false);
    assert.equal(retry.arm(null), false);
    assert.equal(retry.arm(win), true);
    // Another window's request gets the picker, and the memory is gone.
    assert.equal(retry.take(false, otherWin), null);
    assert.equal(retry.arm(win), false);

    retry.rememberLoopback(screen, win);
    assert.equal(retry.arm(win), true);
    assert.equal(retry.take(false, null), null);
  });

  it("remembers nothing for a request whose frame is unknown", () => {
    const retry = createShareSilentRetry();
    retry.rememberLoopback(screen, null);
    assert.equal(retry.arm(null), false);
    assert.equal(retry.take(false, null), null);
  });

  it("keys a frame by its process and routing id, and never throws", () => {
    assert.equal(requesterKey({ processId: 4, routingId: 1 }), "4:1");
    assert.equal(requesterKey(null), null);
    assert.equal(requesterKey(undefined), null);
    assert.equal(requesterKey({ processId: 4 }), null);
    const disposed = {
      get processId() {
        throw new Error("Render frame was disposed");
      },
    };
    assert.equal(requesterKey(disposed), null);
  });

  it("is wired into the display-media handler and origin-checked", () => {
    assert.match(
      main,
      /chooseDisplaySource\(request\?\.audioRequested === true, requesterKey\(request\?\.frame\)\)/,
    );
    assert.match(main, /const silentRetrySource = shareSilentRetry\.take\(audioRequested, requester\);/);
    assert.match(main, /return captureResponse\(silentRetrySource, platform, false, os\.release\(\)\);/);
    assert.match(
      main,
      /if \(response\?\.audio === "loopback"\) \{\s*shareSilentRetry\.rememberLoopback\(source, requester\);/,
    );
    const at = main.indexOf('ipcMain.handle("pqp:share-silent-retry-arm"');
    assert.ok(at > 0, "arm handler registered");
    const handler = main.slice(at, at + 300);
    assert.match(handler, /senderMatchesAppOrigin\(event, sessionAppOrigin\)/);
    assert.match(handler, /shareSilentRetry\.arm\(requesterKey\(event\.senderFrame\)\)/);
  });

  it("is published to the page as a capability and a bridge method", () => {
    assert.match(preload, /silentRetry: true/);
    assert.match(preload, /ipcRenderer\.invoke\("pqp:share-silent-retry-arm"\)/);
  });
});
