import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  createShareRefusal,
  SHARE_REFUSAL_MAX_PENDING,
  SHARE_REFUSAL_REASONS,
  SHARE_REFUSAL_WINDOW_MS,
} = require("./share-refusal.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(here, "..", "main.js"), "utf8");
const preload = readFileSync(path.join(here, "..", "preload.js"), "utf8");

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const win = "4:1";
const otherWin = "7:1";

describe("share refusal reason", () => {
  it("hands the reason to the frame that made the request, once", () => {
    const refusal = createShareRefusal();
    refusal.note("cancelled", win);
    assert.equal(refusal.take(otherWin), null);
    assert.equal(refusal.take(win), "cancelled");
    assert.equal(refusal.take(win), null);
  });

  it("forgets a reason after the window", () => {
    const c = clock();
    const refusal = createShareRefusal({ now: c.now });
    refusal.note("picker-failed", win);
    c.advance(SHARE_REFUSAL_WINDOW_MS + 1);
    assert.equal(refusal.take(win), null);
  });

  it("gives overlapping requests from one frame each their own reason, in order", () => {
    // A second share while the picker is open is refused at once as busy; the
    // first ends later as whatever the person did. Neither may read the other's.
    const refusal = createShareRefusal();
    refusal.note("busy", win);
    refusal.note("cancelled", otherWin);
    refusal.note("cancelled", win);
    assert.equal(refusal.take(win), "busy");
    assert.equal(refusal.take(win), "cancelled");
    assert.equal(refusal.take(win), null);
    assert.equal(refusal.take(otherWin), "cancelled");
  });

  it("keeps a bounded backlog for a page that never reads", () => {
    const refusal = createShareRefusal();
    for (let i = 0; i < SHARE_REFUSAL_MAX_PENDING + 3; i += 1) {
      refusal.note(i === SHARE_REFUSAL_MAX_PENDING + 2 ? "busy" : "cancelled", win);
    }
    let read = 0;
    let last = null;
    for (let next = refusal.take(win); next !== null; next = refusal.take(win)) {
      read += 1;
      last = next;
    }
    assert.equal(read, SHARE_REFUSAL_MAX_PENDING);
    assert.equal(last, "busy");
  });

  it("never matches a frame it could not identify, and reads an unknown reason as error", () => {
    const refusal = createShareRefusal();
    refusal.note("cancelled", null);
    assert.equal(refusal.take(null), null);
    refusal.note("something-new", win);
    assert.equal(refusal.take(win), "error");
  });

  /**
   * The handler's every `return null` is a refusal the page sees as
   * `AbortError: Invalid capture constraints`. Each has to say which one, or
   * the next report from a Windows 11 desktop user is as blind as the last.
   */
  it("names a reason on every path where main.js answers with nothing", () => {
    const start = main.indexOf("async function chooseDisplaySource(");
    const end = main.indexOf("\nfunction configureSessionSecurity(", start);
    assert.ok(start > 0 && end > start);
    const body = main.slice(start, end);
    const nulls = body.split("return null;").length - 1;
    const notes = body.split("shareRefusal.note(").length - 1;
    assert.ok(nulls >= 5, `expected the known refusal paths, found ${nulls}`);
    assert.equal(notes, nulls, "every `return null` in chooseDisplaySource notes a reason first");

    const picker = main.slice(
      main.indexOf("function showSourcePicker("),
      main.indexOf("async function startLinuxShareAudio("),
    );
    assert.doesNotMatch(picker, /finish\(null\)|resolve\(null\)/);
    for (const reason of ["busy", "cancelled", "picker-failed"]) {
      assert.match(picker, new RegExp(`refused: "${reason}"`));
    }

    const handler = main.slice(main.indexOf("ses.setDisplayMediaRequestHandler("));
    assert.match(handler, /shareRefusal\.note\("origin"/);
    assert.match(handler, /shareRefusal\.note\("error"/);
  });

  it("is reachable from the page through the bridge", () => {
    assert.match(main, /"pqp:share-refusal-reason",\n\s+\(event\) => shareRefusal\.take\(requesterKey\(event\.senderFrame\)\)/);
    assert.match(preload, /shareRefusalReason: true/);
    assert.match(preload, /ipcRenderer\.invoke\("pqp:share-refusal-reason"\)/);
    for (const reason of SHARE_REFUSAL_REASONS) {
      assert.ok(preload.includes(`"${reason}"`), `preload documents ${reason}`);
    }
  });
});
