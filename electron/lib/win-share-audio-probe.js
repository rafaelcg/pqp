"use strict";

/**
 * `pqp.exe --probe-share-audio`: one minute on a real Windows PC answers the
 * question this whole feature hangs on.
 *
 * THE QUESTION. Which Windows 10 builds can open a WASAPI process loopback
 * stream? Microsoft's documentation lists build 20348; OBS ships its
 * application capture from 2004 (19041). Windows 10 22H2 is 19045, most of
 * the Brazilian desktop audience, and nobody in this repo has measured it. A
 * GitHub runner cannot: Server 2022 has no audio device, and a machine that
 * hears nothing looks exactly like a machine where everything passed.
 *
 * THE ANSWER IS MEASURED, NOT INFERRED FROM THE BUILD NUMBER. The probe plays
 * a quiet 440 Hz tone from a hidden window of its own (a renderer, so a child
 * of this process, which is exactly where the call lives), then:
 *
 * 1. INCLUDE our own tree: the tone must be there. That proves activation
 *    works on this build AND that audio actually flows, and it is the control
 *    for the next row: a deaf capture cannot pass it.
 * 2. EXCLUDE our own tree: the tone must be absent. That is the call-leak
 *    test itself, the same one `window.pqpShareAudioProbe` runs on a share.
 *
 * Anything else playing on the machine shows up in row 2's level, which is
 * the other half of a screen share and worth seeing too.
 *
 * Pure functions here; the Electron parts (the hidden window, the dialog,
 * the clipboard) are injected from `main.js`.
 */

const { formatHresult, MODE_INCLUDE, MODE_EXCLUDE } = require("./win-share-audio");

const PROBE_FLAG = "--probe-share-audio";
const PROBE_TONE_HZ = 440;
const SAMPLE_RATE = 48000;
/** Seconds of capture per mode. Long enough for a stable Goertzel bin. */
const LISTEN_MS = 1500;
/** Time for the tone to reach the engine after the window starts it. */
const TONE_SETTLE_MS = 600;
/** The tone is played at -14 dBFS. Anything above this is it, not the room. */
const TONE_PRESENT_DBFS = -45;

function wantsShareAudioProbe(argv) {
  return Array.isArray(argv) && argv.some((arg) => arg === PROBE_FLAG);
}

function toDb(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/** Interleaved stereo chunks to one mono Float32Array. */
function downmix(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    total += Math.floor(chunk.length / 2);
  }
  const mono = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      mono[offset] = (chunk[i] + chunk[i + 1]) / 2;
      offset += 1;
    }
  }
  return mono;
}

function rmsDbfs(samples) {
  if (samples.length === 0) {
    return -Infinity;
  }
  let sum = 0;
  for (const x of samples) {
    sum += x * x;
  }
  // RMS of a full-scale sine is 1/sqrt(2); scale so that sine reads 0 dBFS,
  // the same convention as the tone level below.
  return toDb(Math.sqrt(sum / samples.length) * Math.SQRT2);
}

/**
 * Peak amplitude of one frequency, in dBFS (a full-scale sine is 0). The same
 * single-bin Goertzel `client/src/lib/share-audio-probe.ts` uses, so the
 * numbers on both probes mean the same thing.
 */
function goertzelDbfs(samples, sampleRate, frequency) {
  const n = samples.length;
  if (n === 0) {
    return -Infinity;
  }
  const k = Math.round((n * frequency) / sampleRate);
  const coeff = 2 * Math.cos((2 * Math.PI * k) / n);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return toDb((2 * Math.sqrt(Math.max(power, 0))) / n);
}

function analyse(chunks) {
  const mono = downmix(chunks);
  return {
    seconds: mono.length / SAMPLE_RATE,
    levelDbfs: rmsDbfs(mono),
    toneDbfs: goertzelDbfs(mono, SAMPLE_RATE, PROBE_TONE_HZ),
  };
}

/**
 * One row's verdict. `include` is the control, `exclude` is the leak test.
 * HEARS_PQP / CLEAN are the passing pair.
 */
function verdictFor(mode, row) {
  if (!row.started) {
    return "FAILED";
  }
  const tone = row.toneDbfs >= TONE_PRESENT_DBFS;
  if (mode === MODE_INCLUDE) {
    return tone ? "HEARS_PQP" : "SILENT";
  }
  return tone ? "LEAK" : "CLEAN";
}

/** The one line a tester pastes, plus the exit code the CI smoke reads. */
function summarize(build, rows) {
  const include = rows.find((row) => row.mode === MODE_INCLUDE);
  const exclude = rows.find((row) => row.mode === MODE_EXCLUDE);
  const failed = rows.find((row) => !row.started);
  if (failed) {
    return {
      exitCode: 2,
      line: `NOT SUPPORTED on build ${build}: ${failed.mode} failed at ${failed.stage ?? failed.reason ?? "?"} ${formatHresult(failed.hr)}`,
    };
  }
  if (include?.verdict === "HEARS_PQP" && exclude?.verdict === "CLEAN") {
    return {
      exitCode: 0,
      line: `SUPPORTED on build ${build}: window and screen capture work and the call stays out`,
    };
  }
  if (exclude?.verdict === "LEAK") {
    return {
      exitCode: 3,
      line: `LEAK on build ${build}: exclude mode still carries pqp's own audio`,
    };
  }
  return {
    exitCode: 4,
    line: `INCONCLUSIVE on build ${build}: capture opens but the probe tone never arrived (volume up, an output device plugged in, then run again)`,
  };
}

function formatDb(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "silence";
}

function formatRow(row) {
  const label = row.mode === MODE_INCLUDE ? "include own tree (control)" : "exclude own tree (leak test)";
  if (!row.started) {
    return `${label}: FAILED at ${row.stage ?? row.reason ?? "?"} ${formatHresult(row.hr)}`;
  }
  return (
    `${label}: started${row.autoConvert ? "" : " (no AUTOCONVERTPCM)"}, ` +
    `${row.seconds.toFixed(2)} s, level ${formatDb(row.levelDbfs)}, ` +
    `${PROBE_TONE_HZ} Hz ${formatDb(row.toneDbfs)} -> ${row.verdict}`
  );
}

function formatShareAudioProbe(report) {
  const lines = [
    "pqp share audio probe",
    `pqp ${report.about.version} / Electron ${report.about.electron} / Windows ${report.about.release} (build ${report.build}) / ${report.about.arch}`,
    `self-test: ${
      report.status.available
        ? "OK"
        : `FAILED at ${report.status.stage ?? report.status.reason ?? "?"} ${formatHresult(report.status.hr)}`
    }`,
    ...report.rows.map(formatRow),
    `verdict: ${report.summary.line}`,
  ];
  return lines.join("\n");
}

function windowsBuildOf(release) {
  const build = Number.parseInt(String(release ?? "").split(".")[2] ?? "", 10);
  return Number.isFinite(build) ? build : 0;
}

function collect(port, ms, sleep) {
  const chunks = [];
  port.on("message", (event) => {
    const data = event?.data;
    // A typed array from another process can arrive as a view the local
    // `instanceof` does not recognise; its bytes are what matter.
    if (ArrayBuffer.isView(data)) {
      chunks.push(new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4)));
    }
  });
  port.start();
  return sleep(ms).then(() => {
    try {
      port.close();
    } catch {
      // Already closed by the host.
    }
    return chunks;
  });
}

/**
 * Run both rows. `controller` is `createShareAudioController`'s, `playTone` /
 * `stopTone` drive the hidden window, `about` is what the header prints.
 */
async function runShareAudioProbe({
  controller,
  ownPid,
  playTone,
  stopTone,
  about,
  listenMs = LISTEN_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const build = windowsBuildOf(about.release);
  const status = await controller.status();
  const rows = [];
  try {
    await playTone();
    await sleep(TONE_SETTLE_MS);
    for (const mode of [MODE_INCLUDE, MODE_EXCLUDE]) {
      controller.start({ target: { mode, pid: ownPid } });
      const claim = await controller.claim();
      if (!claim.active) {
        rows.push({ mode, started: false, stage: claim.stage, hr: claim.hr, reason: claim.reason });
        controller.stop();
        continue;
      }
      const chunks = await collect(claim.port, listenMs, sleep);
      controller.stop();
      const row = { mode, started: true, autoConvert: claim.autoConvert !== false, ...analyse(chunks) };
      row.verdict = verdictFor(mode, row);
      rows.push(row);
    }
  } finally {
    await stopTone();
  }
  return { about, build, status, rows, summary: summarize(build, rows) };
}

/** The hidden window's page: 440 Hz at -14 dBFS, nothing else. */
const PROBE_TONE_PAGE = `data:text/html,${encodeURIComponent(
  "<!doctype html><meta charset=utf-8><title>pqp probe tone</title><script>" +
    "const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();" +
    `o.frequency.value=${PROBE_TONE_HZ};g.gain.value=0.2;o.connect(g);g.connect(c.destination);o.start();` +
    "</script>",
)}`;

module.exports = {
  PROBE_FLAG,
  PROBE_TONE_HZ,
  PROBE_TONE_PAGE,
  TONE_PRESENT_DBFS,
  wantsShareAudioProbe,
  downmix,
  rmsDbfs,
  goertzelDbfs,
  analyse,
  verdictFor,
  summarize,
  formatShareAudioProbe,
  windowsBuildOf,
  runShareAudioProbe,
};
