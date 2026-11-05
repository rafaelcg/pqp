import { fetchGlobalVoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * The runtime kill switch for the voice gate (`voice_gate`, env `VOICE_GATE`,
 * global, code default ON), served as `voiceGate` on the global
 * `GET /api/voice/config`. See `docs/NOISE_SUPPRESSION.md` §"The voice gate"
 * and `docs/FEATURE_FLAGS.md`.
 *
 * It differs from `clean-voice-default.ts` in one way that matters: UNKNOWN IS
 * ON. That flag is a default being granted, so not knowing means not granting
 * it. This one is an improvement that shipped on, with the old behaviour (plain
 * RNNoise) as the fallback, so an API that does not send the field yet, or a
 * first ask that has not come back, runs the gate. Only an explicit `false` is
 * the kill switch, and a failed later ask keeps the last answer.
 *
 * Two ways the answer is used:
 *
 *   - `voiceGateEnabled()`: asked when a microphone pipeline is built. Off
 *     builds no gate at all, so a device that never loads the module pays
 *     nothing.
 *   - `registerLiveGate(node)`: every running gate registers here, and a flip
 *     is posted to it as a bypass. Off therefore reaches a call that is
 *     already going, with no rebuild, no rejoin and no microphone swap: the
 *     node stays in the chain as a wire.
 */

/** The slice of the gate node this module drives. */
export interface BypassableGate {
  setBypass(bypass: boolean): void;
}

let flagOn = true;
let asked = 0;
let applied = 0;
const live = new Set<BypassableGate>();

function setFlag(next: boolean): void {
  if (next === flagOn) {
    return;
  }
  flagOn = next;
  for (const gate of live) {
    try {
      gate.setBypass(!next);
    } catch {
      // A node whose context is already closing; nothing left to switch.
    }
  }
}

export function voiceGateEnabled(): boolean {
  return flagOn;
}

/**
 * Track a running gate so a later flip reaches it. Applies the current answer
 * straight away (a gate built a moment before the flag turned off must not
 * start expanding). Returns the unregister.
 */
export function registerLiveGate(gate: BypassableGate): () => void {
  live.add(gate);
  if (!flagOn) {
    try {
      gate.setBypass(true);
    } catch {
      // See above.
    }
  }
  return () => {
    live.delete(gate);
  };
}

export async function loadVoiceGateFlag(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const answer = await fetchGlobalVoiceConfig();
    if (mine > applied) {
      applied = mine;
      // Absent is on: only a server that says `false` takes the gate away.
      setFlag(answer.voiceGate !== false);
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startVoiceGateFlag(): () => void {
  void loadVoiceGateFlag();
  const stop = onConfigRefresh(() => {
    void loadVoiceGateFlag();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    // Signed out: back to the code default, which is on.
    setFlag(true);
  };
}

/** Test seam. */
export function setVoiceGateForTests(on: boolean): void {
  setFlag(on);
}

/** Test seam: how many gates are being tracked. */
export function liveVoiceGateCount(): number {
  return live.size;
}
