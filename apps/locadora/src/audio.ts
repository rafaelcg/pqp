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
  readonly sampleRate?: number;
  createGain(): HubGain;
  /** Deprecated and everywhere: the one way to read samples that needs no module, so it works in this sandbox. */
  createScriptProcessor?(bufferSize: number, inputs: number, outputs: number): HubProcessor;
}

interface HubGain {
  gain: { value: number; cancelScheduledValues?(time: number): unknown };
  connect(to: unknown): unknown;
  /** With a target: only that connection goes (the core's own wiring from this node stays). */
  disconnect?(to?: unknown): void;
}

/** What `createScriptProcessor` returns, as far as the tap goes. */
export interface HubProcessor {
  onaudioprocess: ((event: ProcessEvent) => void) | null;
  connect(to: unknown): unknown;
  disconnect?(): void;
}
export interface ProcessEvent {
  inputBuffer: { numberOfChannels: number; length: number; getChannelData(channel: number): Float32Array };
}

/** One block of the game's sound as the page wants it for a share (`share.audio`): stereo, interleaved. */
export interface TapBlock {
  rate: number;
  channels: 2;
  samples: ArrayBuffer;
}

export interface AudioHub {
  /** Silences (true) or restores (false) every context, the ones to come included. */
  setSilent(silent: boolean): void;
  readonly silent: boolean;
  /** How many contexts are being held (a test and the e2e read it). */
  readonly size: number;
  /**
   * THE SHARE'S COPY OF THE SOUND. While a listener is set, every held context hands it what the core plays, in
   * blocks, taken BEFORE the mute switch (`setSilent`): the person's M silences their own speakers, and the people
   * watching a share still hear the game. Blocks of silence are not sent. Null stops it and costs nothing after.
   */
  setTap(listener: ((block: TapBlock) => void) | null): void;
  /**
   * The share's copy goes quiet too (turbo above 3x, where the sound is a squeal nobody wants): the one silence
   * that is not the person's choice about their own speakers.
   */
  setTapSilent(silent: boolean): void;
  readonly tapping: boolean;
  readonly tapSilent: boolean;
}

type ContextConstructor = new (...args: unknown[]) => HubContext;

export interface AudioTarget {
  AudioContext?: ContextConstructor;
  webkitAudioContext?: ContextConstructor;
}

const HUB = Symbol.for("pqp.locadora.audioHub");

/** The gain a master node sits at: 1 is the sound exactly as the core wrote it. */
const OPEN = 1;

/** Frames per block the tap reads: about 43 ms at 48 kHz, so a block is a cheap message and the lag is small. */
const TAP_FRAMES = 2048;
/** A block whose loudest sample is under this is silence and is not sent (about -80 dBFS). */
const TAP_SILENCE = 1e-4;

/** One held context: the node the core wires to (`front`, before the mute), the mute master, the real speakers. */
interface Held {
  front: HubGain;
  master: HubGain;
  real: unknown;
  tap: { processor: HubProcessor; sink: HubGain } | null;
}

export function installAudioHub(target: AudioTarget = window as unknown as AudioTarget): AudioHub {
  const existing = (target as unknown as Record<symbol, AudioHub | undefined>)[HUB];
  if (existing) return existing;

  /** Each held context with the master gain in front of its speakers: a closed context takes its master with it. */
  const held = new Map<HubContext, Held>();
  let silent = false;
  let tapListener: ((block: TapBlock) => void) | null = null;
  let tapSilent = false;

  const level = () => (silent ? 0 : OPEN);

  function apply(master: HubGain) {
    try {
      master.gain.cancelScheduledValues?.(0);
    } catch {
      // a gain with nothing scheduled has nothing to cancel
    }
    master.gain.value = level();
  }

  /** Lets go of every context that has closed, so a frame that loads game after game holds only the live ones. */
  function prune() {
    for (const [context, entry] of [...held.entries()]) {
      if (context.state === "closed") {
        detachTap(entry);
        held.delete(context);
      }
    }
  }

  /** Puts the share's copy on one context: a processor beside the master that reads what the core plays and sends it up. */
  function attachTap(context: HubContext, entry: Held) {
    if (!tapListener || entry.tap || context.state === "closed" || typeof context.createScriptProcessor !== "function") return;
    try {
      const processor = context.createScriptProcessor(TAP_FRAMES, 2, 2);
      // a processor only runs while it reaches a destination; its output stays zero, so it adds no sound of its own
      const sink = context.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const listener = tapListener;
        if (!listener || tapSilent) return;
        const input = event.inputBuffer;
        const left = input.getChannelData(0);
        const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
        const out = new Float32Array(input.length * 2);
        let peak = 0;
        for (let i = 0; i < input.length; i += 1) {
          const l = left[i]!;
          const r = right[i]!;
          out[i * 2] = l;
          out[i * 2 + 1] = r;
          const loud = Math.max(Math.abs(l), Math.abs(r));
          if (loud > peak) peak = loud;
        }
        if (peak < TAP_SILENCE) return;
        listener({ rate: context.sampleRate ?? 48000, channels: 2, samples: out.buffer });
      };
      entry.front.connect(processor);
      processor.connect(sink);
      sink.connect(entry.real);
      entry.tap = { processor, sink };
    } catch {
      // a context that will not host the tap: the share goes without this one's sound
      entry.tap = null;
    }
  }

  function detachTap(entry: Held) {
    const tap = entry.tap;
    if (!tap) return;
    entry.tap = null;
    tap.processor.onaudioprocess = null;
    // each on its own: a node already gone with its context throws, and the others still have to be let go.
    // The tap point stays in front of the mute: only the connection into the processor is taken away.
    for (const detach of [
      () => entry.front.disconnect?.(tap.processor),
      () => tap.processor.disconnect?.(),
      () => tap.sink.disconnect?.(),
    ]) {
      try {
        detach();
      } catch {
        // already gone with its context
      }
    }
  }

  function adopt(context: HubContext) {
    // a new context is the moment the old ones are known to be done with, whether or not anyone toggles the sound
    prune();
    try {
      const real = context.destination;
      const master = context.createGain();
      master.gain.value = level();
      master.connect(real);
      // what the core wires to: a plain gain at 1 in front of the mute, so the share's copy (taken here) is not muted
      const front = context.createGain();
      front.gain.value = OPEN;
      front.connect(master);
      // code that reads the speakers' channel count (SDL does) must keep getting the speakers' answer
      const channels = (real as { maxChannelCount?: number } | null)?.maxChannelCount;
      if (typeof channels === "number") Object.defineProperty(front, "maxChannelCount", { configurable: true, value: channels });
      Object.defineProperty(context, "destination", { configurable: true, get: () => front });
      const entry: Held = { front, master, real, tap: null };
      held.set(context, entry);
      attachTap(context, entry);
      // and the close itself lets go of it at once
      (context as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener?.("statechange", () => {
        if (context.state === "closed") {
          detachTap(entry);
          held.delete(context);
        }
      });
    } catch {
      // a context that will not take the master is left as it is: the frontend's own volume still reaches the stock cores
    }
  }

  const hub: AudioHub = {
    setSilent(next) {
      silent = next;
      prune();
      for (const entry of held.values()) apply(entry.master);
    },
    setTap(listener) {
      tapListener = listener;
      prune();
      for (const [context, entry] of held) {
        if (listener) attachTap(context, entry);
        else detachTap(entry);
      }
    },
    setTapSilent(next) {
      tapSilent = next;
    },
    get tapSilent() {
      return tapSilent;
    },
    get tapping() {
      return tapListener !== null;
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
