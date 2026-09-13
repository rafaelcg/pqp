/**
 * Noise suppression, in three settings instead of a tick box.
 *
 * The microphone used to get exactly one noise suppressor: the `getUserMedia`
 * `noiseSuppression` constraint, which is whatever the browser happens to
 * implement. It is cheap and it is everywhere, and it is also the thing people
 * mean when they say the call "eats consonants": it is a stationary-noise
 * filter, so it takes a fan and leaves a keyboard, a dog and a room.
 *
 * `advanced` swaps it for RNNoise, the Xiph recurrent-network suppressor,
 * compiled to WebAssembly and run inside an `AudioWorklet` on the render
 * thread. It is trained on speech against real noise, so it removes the
 * transients the constraint cannot — and it costs a few percent of one core.
 *
 * THE TWO NEVER STACK. `advanced` sets the browser constraint FALSE, because
 * a suppressor fed an already-suppressed signal is trained on nothing like
 * what it is hearing, and the result is worse than either alone.
 *
 * Everything here is lazy on purpose. The wasm (~150 kB) and the worklet
 * (~63 kB) are only fetched once somebody picks `advanced`, so a default
 * install downloads nothing and runs no new code at all.
 */

import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";

/**
 * `off` is no suppressor at all (a boom arm in a treated room).
 * `browser` is the `getUserMedia` constraint, the default, what everyone has.
 * `advanced` is RNNoise in a worklet, opt-in.
 */
export type NoiseSuppressionMode = "off" | "browser" | "advanced";

/** Order as offered in settings: none, some, a lot. */
export const NOISE_SUPPRESSION_MODES: readonly NoiseSuppressionMode[] = [
  "off",
  "browser",
  "advanced",
];

/**
 * RNNoise is trained at 48 kHz and the worklet says so in as many words.
 *
 * A machine whose default `AudioContext` rate is 44.1 kHz (plenty of Macs with
 * an interface attached) would otherwise feed it a signal 9% off, which sounds
 * like a suppressor that is slightly deaf. Asked for ONLY in advanced mode, so
 * nobody who never turns this on gets a resampler they did not ask for.
 */
export const ADVANCED_SAMPLE_RATE = 48000;

/**
 * Read a persisted value, from any build that ever wrote one.
 *
 * The setting used to be a boolean, so `true` (and a missing value, which the
 * old loader also read as on) is `browser` and `false` is `off`. Anything
 * unrecognised — hand-edited storage, a mode a later build stopped offering —
 * lands on `browser`, which is the default and the only answer that is safe to
 * give somebody whose stored choice cannot be honoured.
 */
export function parseNoiseSuppressionMode(value: unknown): NoiseSuppressionMode {
  if (value === "off" || value === "browser" || value === "advanced") {
    return value;
  }
  if (value === false) {
    return "off";
  }
  return "browser";
}

/**
 * What to put in the `getUserMedia` constraint for a mode.
 *
 * True for `browser` only. `advanced` is deliberately FALSE — see the header:
 * the two suppressors must not stack.
 */
export function browserNoiseSuppression(mode: NoiseSuppressionMode): boolean {
  return mode === "browser";
}

/**
 * Can this browser run the advanced path at all?
 *
 * `AudioWorkletNode` is the honest probe: it is missing on anything without
 * worklets, and it is also missing outside a secure context, which is where a
 * worklet would fail later and less legibly. WebAssembly is checked beside it
 * because the wasm is the other half.
 */
export function advancedNoiseSuppressionSupported(): boolean {
  return (
    typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined"
  );
}

let binaryPromise: Promise<ArrayBuffer> | null = null;

/**
 * Fetch the RNNoise wasm once per page, SIMD build where the CPU has it.
 *
 * Cached as the promise rather than the result so two microphones opening at
 * once share one download. A failure clears the cache: a flaky fetch must not
 * pin the feature off for the rest of the session.
 */
export function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  if (!binaryPromise) {
    binaryPromise = import("@sapphi-red/web-noise-suppressor")
      .then((mod) =>
        mod.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
      )
      .catch((err: unknown) => {
        binaryPromise = null;
        throw err;
      });
  }
  return binaryPromise;
}

/** `addModule` is per context and is not idempotent enough to pay for twice. */
const modulesAdded = new WeakSet<BaseAudioContext>();

/**
 * The worklet node itself, ready to be wired in.
 *
 * `maxChannels: 2` because a microphone is allowed to be stereo and a
 * suppressor that silently drops a channel is a mic that half works.
 */
export async function createRnnoiseNode(
  context: AudioContext,
  binary: ArrayBuffer,
): Promise<AudioWorkletNode & { destroy(): void }> {
  const mod = await import("@sapphi-red/web-noise-suppressor");
  if (!modulesAdded.has(context)) {
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
    modulesAdded.add(context);
  }
  // `binary` is the one cached buffer every advanced pipeline shares
  // (`loadRnnoiseBinary`). Handing it straight to the worklet is a transfer
  // hazard: the node posts it to the render thread, which detaches it, so
  // whichever pipeline reuses the cache next gets a 0-byte buffer and fails
  // to initialise. A slice copies the bytes into a new, unshared buffer, so
  // the cache stays intact no matter how many pipelines are built from it.
  return new mod.RnnoiseWorkletNode(context, {
    maxChannels: 2,
    wasmBinary: binary.slice(0),
  });
}

/** The slice of `AudioNode` this module wires, so a test can hand it fakes. */
export interface MicChainNode {
  connect(destination: never): unknown;
  disconnect(): void;
}

/**
 * Where the suppressor sits: between the microphone and everything else.
 *
 * BEFORE the gain node, which means before the analyser that draws the level
 * meter, before the mute gate, and before the destination whose stream is what
 * gets published *and* what the watch-party mix carries. One insertion, and
 * every consumer of the processed stream is suppressed for free — which is the
 * whole reason it goes here rather than beside the publish call.
 */
export function connectMicChain({
  source,
  suppressor,
  gain,
}: {
  source: MicChainNode;
  suppressor: MicChainNode | null;
  gain: MicChainNode;
}): void {
  if (suppressor) {
    source.connect(suppressor as never);
    suppressor.connect(gain as never);
    return;
  }
  source.connect(gain as never);
}
