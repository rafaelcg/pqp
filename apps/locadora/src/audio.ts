/**
 * The sound switch the game cannot get around. Import this before anything that can make sound.
 *
 * Why it exists: EmulatorJS's own volume setter scales the gain of the OpenAL sources of the stock cores and
 * nothing else. Locadora's SNES core (bsnes, built from source with RetroArch's `rwebaudio` driver) never creates
 * an OpenAL source: it makes its own `AudioContext` and wires a script node straight into its `destination`, so
 * `setVolume(0)` changed the icon and the `muted` flag and left the sound on. Asking each core to be quiet is a
 * promise every build has to keep. This is the one thing that does not depend on that.
 *
 * How: every `AudioContext` the frame creates is caught as it is made (the constructor is wrapped before any core
 * runs), and its `destination` is replaced by one master gain that feeds the real one. Whatever the core connects
 * to "the speakers" goes through that gain, whichever driver, library or build it came from. Silence is the gain
 * at 0. The context is never suspended on purpose: a core that waits on its audio clock would freeze the game,
 * and one that calls `resume()` itself would undo it.
 */

/** The slice of an `AudioContext` this touches, so a test can stand a fake in. */
export interface HubContext {
  readonly destination: unknown;
  readonly state?: string;
  createGain(): HubGain;
}

interface HubGain {
  gain: { value: number; cancelScheduledValues?(time: number): unknown };
  connect(to: unknown): unknown;
}

export interface AudioHub {
  /** Silences (true) or restores (false) every context, the ones to come included. */
  setSilent(silent: boolean): void;
  readonly silent: boolean;
  /** How many contexts are being held (a test and the e2e read it). */
  readonly size: number;
}

type ContextConstructor = new (...args: unknown[]) => HubContext;

export interface AudioTarget {
  AudioContext?: ContextConstructor;
  webkitAudioContext?: ContextConstructor;
}

const HUB = Symbol.for("pqp.locadora.audioHub");

/** The gain a master node sits at: 1 is the sound exactly as the core wrote it. */
const OPEN = 1;

export function installAudioHub(target: AudioTarget = window as unknown as AudioTarget): AudioHub {
  const existing = (target as unknown as Record<symbol, AudioHub | undefined>)[HUB];
  if (existing) return existing;

  /** Each held context with the master gain in front of its speakers: a closed context takes its master with it. */
  const held = new Map<HubContext, HubGain>();
  let silent = false;

  const level = () => (silent ? 0 : OPEN);

  function apply(master: HubGain) {
    try {
      master.gain.cancelScheduledValues?.(0);
    } catch {
      // a gain with nothing scheduled has nothing to cancel
    }
    master.gain.value = level();
  }

  function adopt(context: HubContext) {
    try {
      const real = context.destination;
      const master = context.createGain();
      master.gain.value = level();
      master.connect(real);
      // code that reads the speakers' channel count (SDL does) must keep getting the speakers' answer
      const channels = (real as { maxChannelCount?: number } | null)?.maxChannelCount;
      if (typeof channels === "number") Object.defineProperty(master, "maxChannelCount", { configurable: true, value: channels });
      Object.defineProperty(context, "destination", { configurable: true, get: () => master });
      held.set(context, master);
    } catch {
      // a context that will not take the master is left as it is: the frontend's own volume still reaches the stock cores
    }
  }

  const hub: AudioHub = {
    setSilent(next) {
      silent = next;
      for (const [context, master] of [...held]) {
        if (context.state === "closed") held.delete(context);
        else apply(master);
      }
    },
    get silent() {
      return silent;
    },
    get size() {
      return held.size;
    },
  };

  const wrapped = new Map<ContextConstructor, ContextConstructor>();
  function wrap(Native: ContextConstructor): ContextConstructor {
    const known = wrapped.get(Native);
    if (known) return known;
    class HeldAudioContext extends (Native as unknown as new (...args: unknown[]) => object) {
      constructor(...args: unknown[]) {
        super(...args);
        adopt(this as unknown as HubContext);
      }
    }
    const result = HeldAudioContext as unknown as ContextConstructor;
    wrapped.set(Native, result);
    return result;
  }

  for (const name of ["AudioContext", "webkitAudioContext"] as const) {
    const Native = target[name];
    if (typeof Native !== "function") continue;
    try {
      Object.defineProperty(target, name, { configurable: true, writable: true, value: wrap(Native) });
    } catch {
      // locked down by the browser: the frontend's own volume is all there is
    }
  }

  try {
    Object.defineProperty(target, HUB, { configurable: true, value: hub });
  } catch {
    // only the second install would notice
  }
  return hub;
}

/** The hub of this frame, installed on first use. */
export function audioHub(): AudioHub {
  return installAudioHub();
}

if (typeof window !== "undefined") {
  installAudioHub();
}
