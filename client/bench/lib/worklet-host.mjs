/**
 * Runs an AudioWorklet processor module in plain Node, 128 frames at a time,
 * the way the render thread would, so the suppressors and the voice gate can
 * be measured on deterministic audio without a browser.
 *
 * A worklet file only needs four globals: `AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate` and a `port`. They are stubbed here, the
 * module is imported once per file, and the registered class is instantiated
 * with the same `processorOptions` the real node would send.
 *
 * It is a stand-in for the render thread, not for the browser's scheduler:
 * CPU numbers from it are only ever compared against each other (RNNoise vs
 * GTCRN vs the gate), never read as a promise about a user's machine.
 */

import { pathToFileURL } from "node:url";

export const QUANTUM = 128;

const registry = new Map();
let installed = false;

function install(sampleRate) {
  globalThis.sampleRate = sampleRate;
  if (installed) {
    return;
  }
  installed = true;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = {
        addEventListener() {},
        postMessage() {},
        onmessage: null,
      };
    }
  };
  globalThis.registerProcessor = (name, ctor) => {
    registry.set(name, ctor);
  };
}

/**
 * @param {string} file absolute path of the worklet module
 * @param {string} name the name it registers under
 * @param {object} processorOptions
 * @param {number} sampleRate
 */
export async function createProcessor(file, name, processorOptions, sampleRate) {
  install(sampleRate);
  if (!registry.has(name)) {
    await import(pathToFileURL(file).href);
  }
  const Ctor = registry.get(name);
  if (!Ctor) {
    throw new Error(`worklet ${name} did not register from ${file}`);
  }
  // The emscripten glue inside the wasm suppressors sniffs `process.versions.node`
  // and then reaches for `__dirname` and `fs`, which a worklet scope does not
  // have. Hide `process` while one starts so it takes the browser branch.
  const realProcess = globalThis.process;
  globalThis.process = undefined;
  let instance;
  try {
    instance = new Ctor({ processorOptions });
    // The wasm suppressors start asynchronously and output silence until ready.
    for (
      let i = 0;
      i < 400 && "destroyed" in instance && !instance.processor;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    globalThis.process = realProcess;
  }
  return instance;
}

/** Feed a mono signal through a processor; returns the mono output, same length. */
export function runMono(instance, input) {
  const out = new Float32Array(input.length);
  const inBuf = new Float32Array(QUANTUM);
  const outBuf = new Float32Array(QUANTUM);
  for (let at = 0; at < input.length; at += QUANTUM) {
    const n = Math.min(QUANTUM, input.length - at);
    inBuf.fill(0);
    inBuf.set(input.subarray(at, at + n));
    outBuf.fill(0);
    instance.process([[inBuf]], [[outBuf]], {});
    out.set(outBuf.subarray(0, n), at);
  }
  return out;
}
