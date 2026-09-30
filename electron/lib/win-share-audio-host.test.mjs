import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

/**
 * The utility process's protocol, run against a fake add-on and a fake
 * `parentPort`, so the cleanup rules hold on any OS: a capture that stops (by
 * main's word or on its own) leaves no session, no open port and no echo.
 *
 * `win-share-audio-host.js` is a script, not a module: it reads
 * `process.parentPort` and `loadWinShareAudioAddon` when it is first
 * required, so both are in place before that one `require`.
 */
const require = createRequire(import.meta.url);

const sent = [];
const parentPort = new EventEmitter();
parentPort.postMessage = (message) => sent.push(message);
process.parentPort = parentPort;

const captures = [];
const fakeAddon = {
  startCapture(pid, mode, onChunk, onEvent) {
    const capture = { pid, mode, onChunk, onEvent, stopped: 0, stop() { this.stopped += 1; } };
    captures.push(capture);
    return capture;
  },
};
const shareAudio = require("./win-share-audio.js");
shareAudio.loadWinShareAudioAddon = () => ({ addon: fakeAddon, reason: null, file: "fake.node" });
require("./win-share-audio-host.js");

function fakePort() {
  const port = new EventEmitter();
  port.closed = false;
  port.posted = [];
  port.start = () => {};
  port.close = () => {
    port.closed = true;
  };
  port.postMessage = (chunk) => port.posted.push(chunk);
  return port;
}

function start(sessionId) {
  const port = fakePort();
  parentPort.emit("message", {
    data: {
      type: "start",
      sessionId,
      ownPid: 1,
      target: { mode: "include", pid: 4242 },
    },
    ports: [port],
  });
  return { port, capture: captures.at(-1) };
}

const sessionMessages = (sessionId) =>
  sent.filter((m) => m.type === "session" && m.sessionId === sessionId);

describe("the share-audio host", () => {
  it("says it is ready, with the add-on loaded", () => {
    assert.deepEqual(sent[0], { type: "ready", available: true, reason: null });
  });

  it("reports a started capture once", () => {
    const { capture } = start("h-1");
    capture.onEvent({ type: "started", autoConvert: true });
    assert.deepEqual(
      sessionMessages("h-1").map((m) => m.state),
      ["started"],
    );
  });

  it("ends a capture that stops on its own: session gone, port closed, page-side told once", () => {
    const { port, capture } = start("h-2");
    capture.onEvent({ type: "started" });
    capture.onEvent({ type: "ended", packets: 3, frames: 1440, silentPackets: 0, discontinuities: 0, dropped: 0 });
    assert.equal(port.closed, true, "the port is closed so the worklet stops waiting on it");
    assert.equal(capture.stopped, 1, "the native capture is stopped, not left to its thread");
    assert.deepEqual(
      sessionMessages("h-2").map((m) => m.state),
      ["started", "ended"],
    );
    // A second `ended` (the thread's own, after stop) is an echo.
    capture.onEvent({ type: "ended" });
    assert.equal(sessionMessages("h-2").filter((m) => m.state === "ended").length, 1);
    assert.equal(capture.stopped, 1);
  });

  it("ends and cleans up a stream that fails after it started", () => {
    const { port, capture } = start("h-3");
    capture.onEvent({ type: "started" });
    capture.onEvent({ type: "error", stage: "read", hr: 0x88890004 });
    assert.equal(port.closed, true);
    assert.equal(capture.stopped, 1);
    assert.equal(sessionMessages("h-3").at(-1).state, "failed");
  });

  it("stops and closes on main's word, and stays quiet about the capture's last events", () => {
    const { port, capture } = start("h-4");
    parentPort.emit("message", { data: { type: "stop", sessionId: "h-4" }, ports: [] });
    assert.equal(port.closed, true);
    assert.equal(capture.stopped, 1);
    // A stop during activation aborts it; a stop always ends with `ended`.
    capture.onEvent({ type: "error", stage: "activate", hr: 0x80004004 });
    capture.onEvent({ type: "started" });
    capture.onEvent({ type: "ended" });
    assert.deepEqual(sessionMessages("h-4"), [], "nothing is said about a session main already stopped");
  });

  it("stops the capture when the page's end of the port closes", () => {
    const { port, capture } = start("h-5");
    capture.onEvent({ type: "started" });
    port.emit("close");
    assert.equal(capture.stopped, 1);
    assert.equal(port.closed, true);
  });

  it("stops the capture when the port can no longer be written to", () => {
    const { port, capture } = start("h-6");
    port.postMessage = () => {
      throw new Error("port closed");
    };
    capture.onChunk(new Float32Array(960));
    assert.equal(capture.stopped, 1);
    assert.equal(port.closed, true);
  });

  it("stops the previous share when a new one starts: one share at a time", () => {
    const first = start("h-7");
    const second = start("h-8");
    assert.equal(first.capture.stopped, 1);
    assert.equal(first.port.closed, true);
    assert.equal(second.capture.stopped, 0);
    parentPort.emit("message", { data: { type: "stop", sessionId: "h-8" }, ports: [] });
    assert.equal(second.capture.stopped, 1);
  });
});
