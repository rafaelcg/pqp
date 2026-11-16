import voiceGateWorkletUrl from "./voice-gate-worklet.js?url&no-inline";
import { registerLiveGate, voiceGateEnabled } from "./voice-gate-flag";

/**
 * The voice gate as a Web Audio node, ready to wire in after RNNoise.
 *
 * Everything about what it does is in `voice-gate-worklet.js`; this file only
 * loads it, builds the node and hands back something that cleans up after
 * itself. It is the one place that asks the runtime flag, so the mic pipeline
 * and the settings "Ouvir meu microfone" loop get the same answer the same way.
 *
 * NEVER THROWS, and never leaves the microphone worse than plain RNNoise:
 * every failure (the module will not load, the node will not construct, the
 * flag says off) returns `null` and the caller simply does not wire a gate.
 */

export const VOICE_GATE_PROCESSOR = "pqp-voice-gate";

export interface VoiceGateHandle {
  /** The node to wire: input 0 the audio, input 1 the raw-mic sidechain. */
  node: AudioWorkletNode;
  /** Pin the gate open (true) or let it expand again (false), live. */
  setBypass(bypass: boolean): void;
  destroy(): void;
}

/** `addModule` is per context and is not idempotent enough to pay for twice. */
const modulesAdded = new WeakSet<BaseAudioContext>();

export async function createVoiceGate(
  context: AudioContext,
): Promise<VoiceGateHandle | null> {
  if (!voiceGateEnabled()) {
    return null;
  }
  try {
    if (!modulesAdded.has(context)) {
      await context.audioWorklet.addModule(voiceGateWorkletUrl);
      modulesAdded.add(context);
    }
    const node = new AudioWorkletNode(context, VOICE_GATE_PROCESSOR, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Mono in, mono out, whatever the microphone is: a worklet with two
      // inputs does not get the one-in-one-out channel matching, and a voice
      // does not need two channels.
      channelCount: 1,
      channelCountMode: "explicit",
      // The sidechain is the raw microphone, which is ahead of the audio by
      // RNNoise's own delay (about 20 ms), so the gate adds none of its own.
      // Without a sidechain this would be the 8 ms default.
      processorOptions: { lookaheadMs: 0 },
    });
    let destroyed = false;
    const handle: VoiceGateHandle = {
      node,
      setBypass: (bypass) => {
        if (!destroyed) {
          node.port.postMessage({ bypass });
        }
      },
      destroy: () => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        unregister();
        node.onprocessorerror = null;
        try {
          node.disconnect();
        } catch {
          // Already gone with its context.
        }
      },
    };
    const unregister = registerLiveGate(handle);
    return handle;
  } catch (err) {
    console.warn("[mic] voice gate unavailable", err);
    return null;
  }
}
