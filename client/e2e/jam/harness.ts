/**
 * The jam engine with nothing around it, for `jam.spec.ts` and
 * `formats.spec.ts` to drive through `page.evaluate`. No React, no app, no
 * server: `window.jamTest` is the engine's modules plus two measuring
 * helpers that run in the page (so a few seconds of 48 kHz audio never has
 * to cross the Playwright bridge).
 */
import * as jam from "@/lib/jam";
import { ensureCaptureModule, CAPTURE_PROCESSOR_NAME } from "@/lib/jam/input";
import { assembleChunks, type StampedChunk } from "@/lib/jam/assemble";
import { pulseTrain, sweep } from "@/lib/jam/signals";
import { findPulse, locate } from "@/lib/jam/xcorr";

/** Every place `ref` occurs in `x` (normalised correlation above `minQuality`), at least `minGap` apart. */
function findAll(x: Float32Array, ref: Float32Array, sampleRate: number, minQuality = 0.5, minGapSec = 0.2): { position: number; quality: number }[] {
  const out: { position: number; quality: number }[] = [];
  const step = Math.round(minGapSec * sampleRate);
  let from = 0;
  while (from < x.length - ref.length) {
    const m = findPulse(x, ref, from, Math.min(x.length - ref.length, from + step), { sampleRate });
    if (m && m.quality >= minQuality) {
      out.push(m);
      from = Math.floor(m.position) + step;
    } else {
      from += step;
    }
  }
  return out;
}

/**
 * Tap whatever is connected into it with the capture worklet: the spec uses
 * it on the player's master bus to measure the REAL-TIME output, frame
 * stamped, rather than trusting the schedule.
 */
async function tap(context: AudioContext, from: AudioNode) {
  await ensureCaptureModule(context);
  const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
  });
  const sink = context.createGain();
  sink.gain.value = 0;
  from.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  const chunks: StampedChunk[] = [];
  let done: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent) => {
    if (e.data.type === "chunk") chunks.push({ frame: e.data.frame, channels: e.data.channels });
    else if (e.data.type === "stopped") done?.();
  };
  return {
    start(atFrame: number) {
      node.port.postMessage({ type: "start", atFrame, channels: 1 });
    },
    async stop() {
      await new Promise<void>((r) => {
        done = r;
        node.port.postMessage({ type: "stop" });
      });
      from.disconnect(node);
      node.disconnect();
      return assembleChunks(chunks);
    },
  };
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

declare global {
  interface Window {
    jamTest: typeof api;
  }
}

const api = { jam, pulseTrain, sweep, findPulse, findAll, locate, tap, fromBase64 };
window.jamTest = api;
document.getElementById("ready")!.textContent = "ready";
