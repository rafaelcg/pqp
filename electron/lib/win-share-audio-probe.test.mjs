import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  PROBE_TONE_HZ,
  wantsShareAudioProbe,
  goertzelDbfs,
  analyse,
  verdictFor,
  summarize,
  formatShareAudioProbe,
  runShareAudioProbe,
  windowsBuildOf,
} = require("./win-share-audio-probe.js");

const RATE = 48000;

function tone(frequency, amplitude, seconds) {
  const out = new Float32Array(Math.round(RATE * seconds) * 2);
  for (let i = 0; i < out.length / 2; i += 1) {
    const x = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE);
    out[2 * i] = x;
    out[2 * i + 1] = x;
  }
  return out;
}

describe("the flag", () => {
  it("is only the exact switch", () => {
    assert.equal(wantsShareAudioProbe(["pqp.exe", "--probe-share-audio"]), true);
    assert.equal(wantsShareAudioProbe(["pqp.exe", "--probe-share-audio-x"]), false);
    assert.equal(wantsShareAudioProbe(["pqp.exe"]), false);
  });
});

describe("goertzelDbfs", () => {
  it("reads a sine's peak level, 0 dBFS at full scale", () => {
    const mono = tone(PROBE_TONE_HZ, 1, 1).filter((_, i) => i % 2 === 0);
    assert.ok(Math.abs(goertzelDbfs(mono, RATE, PROBE_TONE_HZ)) < 0.5);
  });

  it("does not hear 440 in 880", () => {
    const mono = tone(880, 0.5, 1).filter((_, i) => i % 2 === 0);
    assert.ok(goertzelDbfs(mono, RATE, PROBE_TONE_HZ) < -60);
  });
});

describe("verdicts", () => {
  it("include hearing the tone is the control passing", () => {
    const row = { started: true, ...analyse([tone(PROBE_TONE_HZ, 0.2, 1.5)]) };
    assert.equal(verdictFor("include", row), "HEARS_PQP");
  });

  it("exclude hearing the tone is the leak", () => {
    const row = { started: true, ...analyse([tone(PROBE_TONE_HZ, 0.2, 1.5)]) };
    assert.equal(verdictFor("exclude", row), "LEAK");
  });

  it("exclude with other sound and no tone is clean", () => {
    const row = { started: true, ...analyse([tone(1000, 0.3, 1.5)]) };
    assert.equal(verdictFor("exclude", row), "CLEAN");
    assert.ok(row.levelDbfs > -20);
  });

  it("silence on include is not a pass: it is the probe being deaf", () => {
    const row = { started: true, ...analyse([]) };
    assert.equal(verdictFor("include", row), "SILENT");
    assert.equal(summarize(19045, [
      { mode: "include", started: true, verdict: "SILENT" },
      { mode: "exclude", started: true, verdict: "CLEAN" },
    ]).exitCode, 4);
  });

  it("names the build and the HRESULT when activation fails", () => {
    const summary = summarize(19045, [
      { mode: "include", started: false, stage: "activate", hr: 0x80070057 },
    ]);
    assert.equal(summary.exitCode, 2);
    assert.equal(summary.line, "NOT SUPPORTED on build 19045: include failed at activate 0x80070057");
  });
});

describe("runShareAudioProbe", () => {
  function fakePort(chunks) {
    const port = new EventEmitter();
    port.start = () => {
      for (const data of chunks) {
        port.emit("message", { data });
      }
    };
    port.close = () => {};
    return port;
  }

  it("plays the tone, runs include then exclude on our own tree, and stops the tone", async () => {
    const calls = [];
    const captured = {
      include: [tone(PROBE_TONE_HZ, 0.2, 1.5)],
      exclude: [tone(1000, 0.1, 1.5)],
    };
    let current = null;
    const controller = {
      status: async () => ({ available: true, reason: null, stage: null, hr: 0 }),
      start: ({ target }) => {
        calls.push(`start ${target.mode} ${target.pid}`);
        current = target.mode;
      },
      claim: async () => ({ active: true, autoConvert: true, port: fakePort(captured[current]) }),
      stop: () => calls.push("stop"),
    };
    const report = await runShareAudioProbe({
      controller,
      ownPid: 4000,
      about: { version: "0.1.9", electron: "44.0.0", release: "10.0.19045", arch: "x64" },
      playTone: async () => calls.push("tone on"),
      stopTone: async () => calls.push("tone off"),
      sleep: async () => {},
    });
    assert.deepEqual(calls, [
      "tone on",
      "start include 4000",
      "stop",
      "start exclude 4000",
      "stop",
      "tone off",
    ]);
    assert.deepEqual(report.rows.map((row) => row.verdict), ["HEARS_PQP", "CLEAN"]);
    assert.equal(report.summary.exitCode, 0);
    const text = formatShareAudioProbe(report);
    assert.match(text, /build 19045/);
    assert.match(text, /verdict: SUPPORTED on build 19045/);
  });

  it("stops the tone even when a row throws", async () => {
    let toneOff = false;
    const controller = {
      status: async () => ({ available: false, reason: "activate", stage: "activate", hr: 1 }),
      start: () => {
        throw new Error("boom");
      },
      claim: async () => ({ active: false }),
      stop: () => {},
    };
    await assert.rejects(
      runShareAudioProbe({
        controller,
        ownPid: 1,
        about: { release: "10.0.19045" },
        playTone: async () => {},
        stopTone: async () => {
          toneOff = true;
        },
        sleep: async () => {},
      }),
    );
    assert.equal(toneOff, true);
  });
});

describe("windowsBuildOf", () => {
  it("reads the NT build out of os.release()", () => {
    assert.equal(windowsBuildOf("10.0.19045"), 19045);
    assert.equal(windowsBuildOf("10.0.22631"), 22631);
    assert.equal(windowsBuildOf(undefined), 0);
  });
});
