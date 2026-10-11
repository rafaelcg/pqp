/**
 * Modo 2005's sounds, synthesized with WebAudio. Our own recipes, no samples
 * and nothing recorded from any other product. Envelopes are exponential from
 * 0.0001 so nothing clicks. Each recipe schedules its own nodes into the cue
 * bus `sounds.ts` hands it, which carries the output volume and device.
 *
 * Loaded with the look's lazy chunk, so nobody else downloads them.
 */

import type { SynthCue } from "@/lib/sounds";

function envelope(
  gain: GainNode,
  at: number,
  attack: number,
  peak: number,
  decay: number,
): void {
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
}

function bus(ctx: AudioContext, destination: AudioNode, volume: number): GainNode {
  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(destination);
  return out;
}

/**
 * "Acabou de entrar": two marimba-like notes, A5 then E6 90 ms later. A sine
 * plus a quick fourth partial for the mallet.
 */
export const friendOnlineSynth: SynthCue = (ctx, destination) => {
  const t = ctx.currentTime;
  const out = bus(ctx, destination, 0.35);
  for (const [frequency, delay] of [
    [880, 0],
    [1318.5, 0.09],
  ] as const) {
    const tone = ctx.createOscillator();
    const toneGain = ctx.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    envelope(toneGain, t + delay, 0.006, 0.8, 0.55);
    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = frequency * 4;
    envelope(partialGain, t + delay, 0.002, 0.18, 0.06);
    tone.connect(toneGain).connect(out);
    partial.connect(partialGain).connect(out);
    tone.start(t + delay);
    partial.start(t + delay);
    tone.stop(t + delay + 0.7);
    partial.stop(t + delay + 0.1);
  }
};

/** Mensagem nova: "ploc-plim", an upward sine glide and a tiny high tick. */
export const messageSynth: SynthCue = (ctx, destination) => {
  const t = ctx.currentTime;
  const out = bus(ctx, destination, 0.3);
  const glide = ctx.createOscillator();
  const glideGain = ctx.createGain();
  glide.type = "sine";
  glide.frequency.setValueAtTime(620, t);
  glide.frequency.exponentialRampToValueAtTime(990, t + 0.05);
  envelope(glideGain, t, 0.005, 0.8, 0.16);
  glide.connect(glideGain).connect(out);
  glide.start(t);
  glide.stop(t + 0.2);
  const tick = ctx.createOscillator();
  const tickGain = ctx.createGain();
  tick.type = "sine";
  tick.frequency.value = 1480;
  envelope(tickGain, t + 0.07, 0.003, 0.4, 0.09);
  tick.connect(tickGain).connect(out);
  tick.start(t + 0.07);
  tick.stop(t + 0.2);
};
