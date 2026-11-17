import { chooseMono } from "./assemble";
import type { JamInput } from "./input";
import {
  type LatencyResult,
  analyseLoopback,
  analyseTapAlong,
} from "./latency";
import { metronomeClick, pulseTrain, sweep } from "./signals";

/**
 * Playing clicks and listening for them. Both calibrations go straight to
 * the context's destination (not through the player's master, so a muted
 * mix does not mute the calibration) and capture through the same worklet a
 * take uses, so what they measure is the path a take travels.
 */

export interface LoopbackOptions {
  /** How many sweeps. Default 10. */
  pulses?: number;
  /** Time between sweeps, ms. Must exceed `maxLatencyMs`. Default 600. */
  periodMs?: number;
  /** Longest round trip looked for, ms. Default 550 (Bluetooth fits, which is how it gets flagged). */
  maxLatencyMs?: number;
  /** Sweep amplitude, 0..1. Default 0.5. */
  level?: number;
  /** For tests and diagnostics: the raw capture. */
  onCapture?: (capture: { samples: Float32Array; startFrame: number; emitted: number[] }) => void;
}

const LEAD_SEC = 0.2;
const FIRST_PULSE_SEC = 0.3;

function waitUntil(context: AudioContext, ctxTime: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const left = ctxTime - context.currentTime;
      if (left <= 0 || context.state !== "running") resolve();
      else setTimeout(check, Math.min(250, Math.max(10, left * 1000)));
    };
    check();
  });
}

function playAt(context: AudioContext, samples: Float32Array, frame: number): AudioBufferSourceNode {
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start(frame / context.sampleRate);
  return node;
}

/**
 * Loopback: the microphone must be able to hear the output. Sweeps go out,
 * each is found in the capture, and the round trip is the median lag.
 */
export async function calibrateLoopback(input: JamInput, options: LoopbackOptions = {}): Promise<LatencyResult> {
  const context = input.context;
  if (context.state !== "running") await context.resume();
  const sr = context.sampleRate;
  const pulses = Math.round(options.pulses ?? 10);
  const periodMs = options.periodMs ?? 600;
  if (!(pulses >= 3 && pulses <= 64)) throw new Error("jam: loopback needs 3 to 64 pulses");
  if (!(periodMs >= 100 && periodMs <= 5000)) throw new Error("jam: loopback period must be 100 to 5000 ms");
  const maxLatencyMs = Math.min(options.maxLatencyMs ?? 550, periodMs - 30);
  const reference = sweep(sr, { direction: "down", amplitude: options.level ?? 0.5 });
  const t0 = Math.round((context.currentTime + LEAD_SEC) * sr);
  const first = Math.round(FIRST_PULSE_SEC * sr);
  const period = Math.round((periodMs / 1000) * sr);
  const at = Array.from({ length: pulses }, (_, k) => first + k * period);
  const train = pulseTrain(first + pulses * period, reference, at);
  input.startCapture(t0);
  playAt(context, train, t0);
  const emitted = at.map((a) => t0 + a);
  await waitUntil(context, (emitted[emitted.length - 1] + reference.length) / sr + maxLatencyMs / 1000 + 0.15);
  const capture = await input.stopCapture();
  if (!capture) {
    return analyseLoopback({
      captured: new Float32Array(0),
      captureStartFrame: 0,
      emittedFrames: emitted,
      reference,
      sampleRate: sr,
      maxLatencyMs,
    });
  }
  const { samples } = chooseMono(capture.channels);
  options.onCapture?.({ samples, startFrame: capture.startFrame, emitted });
  return analyseLoopback({
    captured: samples,
    captureStartFrame: capture.startFrame,
    emittedFrames: emitted,
    reference,
    sampleRate: sr,
    maxLatencyMs,
  });
}

export interface TapAlongOptions {
  clicks?: number;
  bpm?: number;
  maxLatencyMs?: number;
}

/**
 * Tap-along: for headphones and direct-input interfaces, where the
 * microphone cannot hear the output. The player claps, taps the microphone
 * or hits muted strings on every click; the round trip is the median of
 * (tap heard) minus (click played), first two taps ignored.
 */
export async function calibrateTapAlong(input: JamInput, options: TapAlongOptions = {}): Promise<LatencyResult> {
  const context = input.context;
  if (context.state !== "running") await context.resume();
  const sr = context.sampleRate;
  const clicks = Math.round(options.clicks ?? 12);
  const bpm = options.bpm ?? 100;
  if (!(clicks >= 5 && clicks <= 64)) throw new Error("jam: tap-along needs 5 to 64 clicks");
  if (!(bpm >= 40 && bpm <= 240)) throw new Error("jam: tap-along tempo must be 40 to 240 BPM");
  const beat = Math.round((60 / bpm) * sr);
  const t0 = Math.round((context.currentTime + LEAD_SEC) * sr);
  const first = Math.round(0.5 * sr);
  const at = Array.from({ length: clicks }, (_, k) => first + k * beat);
  const accent = metronomeClick(sr, true);
  const plain = metronomeClick(sr, false);
  const train = new Float32Array(first + clicks * beat);
  at.forEach((a, k) => {
    const c = k % 4 === 0 ? accent : plain;
    for (let i = 0; i < c.length && a + i < train.length; i++) train[a + i] += c[i];
  });
  input.startCapture(t0);
  playAt(context, train, t0);
  const clickFrames = at.map((a) => t0 + a);
  await waitUntil(context, clickFrames[clickFrames.length - 1] / sr + 0.6);
  const capture = await input.stopCapture();
  const samples = capture ? chooseMono(capture.channels).samples : new Float32Array(0);
  return analyseTapAlong({
    captured: samples,
    captureStartFrame: capture?.startFrame ?? 0,
    clickFrames,
    sampleRate: sr,
    maxLatencyMs: options.maxLatencyMs,
  });
}
