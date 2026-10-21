import { describe, expect, it } from "vitest";
import { installAudioHub, type AudioTarget } from "./audio";

/*
 * Fake audio contexts shaped like the browser's: a destination, a gain factory and nothing else. The core's
 * own driver is what the first test plays: it makes a context and wires a source STRAIGHT to `destination`
 * (RetroArch's rwebaudio, the bsnes build), which EmulatorJS's volume setter never reaches.
 */

class FakeGain {
  gain = { value: 1, cancelScheduledValues() {} };
  /** The first thing this feeds (the speakers' path); a tap hangs off a second connection. */
  to: unknown = null;
  connections: unknown[] = [];
  connect(to: unknown) {
    if (this.to === null) this.to = to;
    this.connections.push(to);
    return to;
  }
  disconnect(to?: unknown) {
    this.connections = to === undefined ? [] : this.connections.filter((node) => node !== to);
  }
}

class FakeProcessor {
  onaudioprocess: ((event: unknown) => void) | null = null;
  connections: unknown[] = [];
  connect(to: unknown) {
    this.connections.push(to);
    return to;
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeContext {
  static made: FakeContext[] = [];
  state = "running";
  sampleRate = 48000;
  readonly destination: object = { maxChannelCount: 2, speakers: true };
  readonly processors: FakeProcessor[] = [];
  constructor() {
    FakeContext.made.push(this);
  }
  createGain() {
    return new FakeGain();
  }
  createScriptProcessor() {
    const processor = new FakeProcessor();
    this.processors.push(processor);
    return processor;
  }
}

function target(): AudioTarget & { AudioContext: typeof FakeContext } {
  FakeContext.made = [];
  return { AudioContext: FakeContext as never, webkitAudioContext: FakeContext as never } as never;
}

/** What reaches the speakers: the product of every gain between a source and the real destination. */
function levelAt(context: { destination: unknown }): number {
  let level = 1;
  let node = context.destination as FakeGain | { speakers?: boolean };
  while (node instanceof FakeGain) {
    level *= node.gain.value;
    node = node.to as FakeGain;
  }
  return level;
}

describe("the frame's audio hub", () => {
  it("catches every context a core makes and silences a source wired straight to its destination", () => {
    const window = target();
    const hub = installAudioHub(window);
    const context = new window.AudioContext();
    // the core: no OpenAL source, no volume the frontend knows of, just "the speakers"
    expect(hub.size).toBe(1);
    expect(levelAt(context)).toBe(1);
    hub.setSilent(true);
    expect(levelAt(context)).toBe(0);
    hub.setSilent(false);
    expect(levelAt(context)).toBe(1);
  });

  it("routes the destination through one master that feeds the real one, and keeps the speakers' channel count", () => {
    const window = target();
    installAudioHub(window);
    const context = new window.AudioContext();
    const front = context.destination as unknown as FakeGain & { maxChannelCount?: number };
    expect(front).toBeInstanceOf(FakeGain);
    expect(front.maxChannelCount).toBe(2);
    // the core's node feeds the mute master, which feeds the real speakers
    const master = front.to as FakeGain;
    expect(master).toBeInstanceOf(FakeGain);
    expect((master.to as { speakers?: boolean }).speakers).toBe(true);
  });

  it("silences contexts made AFTER the switch (a game loaded while muted) and the webkit-prefixed name too", () => {
    const window = target();
    const hub = installAudioHub(window);
    hub.setSilent(true);
    const later = new (window.webkitAudioContext as typeof FakeContext)();
    expect(levelAt(later)).toBe(0);
    const another = new window.AudioContext();
    expect(levelAt(another)).toBe(0);
    hub.setSilent(false);
    expect(levelAt(later)).toBe(1);
    expect(levelAt(another)).toBe(1);
  });

  it("is installed once: a second install answers with the same hub and does not wrap twice", () => {
    const window = target();
    const first = installAudioHub(window);
    const second = installAudioHub(window);
    expect(second).toBe(first);
    const context = new window.AudioContext();
    expect(FakeContext.made).toHaveLength(1);
    first.setSilent(true);
    expect(levelAt(context)).toBe(0);
  });

  it("forgets contexts the core closed", () => {
    const window = target();
    const hub = installAudioHub(window);
    const context = new window.AudioContext();
    (context as { state: string }).state = "closed";
    hub.setSilent(true);
    expect(hub.size).toBe(0);
    // its master is let go with it: a later switch does not touch it, so nothing of it is held for the frame's life
    const master = context.destination as unknown as FakeGain;
    master.gain.value = 0.5;
    hub.setSilent(false);
    expect(master.gain.value).toBe(0.5);
  });

  it("lets go of a closed context when the next one is made, with no mute or turbo change in between", () => {
    const window = target();
    const hub = installAudioHub(window);
    const first = new window.AudioContext();
    expect(hub.size).toBe(1);
    (first as { state: string }).state = "closed";
    new window.AudioContext();
    expect(hub.size).toBe(1);
  });

  it("lets go of a context the moment it reports closed", () => {
    class Listening extends FakeContext {
      listeners: Array<() => void> = [];
      addEventListener(_type: string, listener: () => void) {
        this.listeners.push(listener);
      }
    }
    const window = { AudioContext: Listening as never } as AudioTarget;
    const hub = installAudioHub(window);
    const context = new (window.AudioContext as never as typeof Listening)();
    expect(hub.size).toBe(1);
    context.state = "closed";
    for (const listener of context.listeners) listener();
    expect(hub.size).toBe(0);
  });

  it("never suspends a context: a core waiting on its audio clock would freeze", () => {
    const window = target();
    const hub = installAudioHub(window);
    const context = new window.AudioContext();
    hub.setSilent(true);
    expect(context.state).toBe("running");
  });

  it("leaves a context it cannot take the master into alone, without throwing", () => {
    class Stubborn {
      state = "running";
      get destination() {
        return {};
      }
      createGain(): never {
        throw new Error("no");
      }
    }
    const window = { AudioContext: Stubborn as never } as AudioTarget;
    const hub = installAudioHub(window);
    expect(() => new (window.AudioContext as never as typeof Stubborn)()).not.toThrow();
    expect(() => hub.setSilent(true)).not.toThrow();
  });

  it("does nothing where there is no Web Audio at all", () => {
    const hub = installAudioHub({});
    expect(() => hub.setSilent(true)).not.toThrow();
    expect(hub.silent).toBe(true);
  });

  describe("the share's copy of the sound (share.audio)", () => {
    function block(left: number[], right: number[] = left) {
      return {
        inputBuffer: {
          numberOfChannels: 2,
          length: left.length,
          getChannelData: (channel: number) => Float32Array.from(channel === 0 ? left : right),
        },
      };
    }

    it("reads nothing, and builds nothing, until the page wants it", () => {
      const window = target();
      const hub = installAudioHub(window);
      const context = new window.AudioContext() as FakeContext;
      expect(hub.tapping).toBe(false);
      expect(context.processors).toHaveLength(0);
    });

    it("taps the node the core plays into, BEFORE the mute: the sharer's M leaves the share's sound alone", () => {
      const window = target();
      const hub = installAudioHub(window);
      const context = new window.AudioContext() as FakeContext;
      const blocks: Array<{ rate: number; channels: number; samples: ArrayBuffer }> = [];
      hub.setTap((b) => blocks.push(b));
      expect(context.processors).toHaveLength(1);
      const front = context.destination as unknown as FakeGain;
      expect(front.connections).toContain(context.processors[0]);
      // the mute is the master, behind the tap point: silence does not reach the copy
      hub.setSilent(true);
      expect(levelAt(context)).toBe(0);
      context.processors[0]!.onaudioprocess!(block([0.5, -0.25], [0.1, 0.2]));
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.rate).toBe(48000);
      expect(blocks[0]!.channels).toBe(2);
      expect(Array.from(new Float32Array(blocks[0]!.samples))).toEqual([0.5, Math.fround(0.1), -0.25, Math.fround(0.2)]);
    });

    it("does not send silence, and a mono input is sent to both sides", () => {
      const window = target();
      const hub = installAudioHub(window);
      const context = new window.AudioContext() as FakeContext;
      const blocks: ArrayBuffer[] = [];
      hub.setTap((b) => blocks.push(b.samples));
      context.processors[0]!.onaudioprocess!(block([0, 0, 0, 0]));
      expect(blocks).toHaveLength(0);
      context.processors[0]!.onaudioprocess!({
        inputBuffer: { numberOfChannels: 1, length: 2, getChannelData: () => Float32Array.from([0.5, 0.25]) },
      });
      expect(Array.from(new Float32Array(blocks[0]!))).toEqual([0.5, 0.5, 0.25, 0.25]);
    });

    it("goes quiet while turbo has the game silent, even though the person did not mute", () => {
      const window = target();
      const hub = installAudioHub(window);
      const context = new window.AudioContext() as FakeContext;
      const blocks: ArrayBuffer[] = [];
      hub.setTap((b) => blocks.push(b.samples));
      hub.setTapSilent(true);
      context.processors[0]!.onaudioprocess!(block([0.5]));
      expect(blocks).toHaveLength(0);
      hub.setTapSilent(false);
      context.processors[0]!.onaudioprocess!(block([0.5]));
      expect(blocks).toHaveLength(1);
    });

    it("reaches a context made after the share started (the next game), and lets go when the share ends", () => {
      const window = target();
      const hub = installAudioHub(window);
      const blocks: ArrayBuffer[] = [];
      hub.setTap((b) => blocks.push(b.samples));
      const later = new window.AudioContext() as FakeContext;
      expect(later.processors).toHaveLength(1);
      later.processors[0]!.onaudioprocess!(block([0.5]));
      expect(blocks).toHaveLength(1);
      hub.setTap(null);
      expect(later.processors[0]!.onaudioprocess).toBeNull();
      expect(hub.tapping).toBe(false);
      // and nothing is left wired into the processor, while the core's own path to the speakers is untouched
      const front = later.destination as unknown as FakeGain;
      expect(front.connections).not.toContain(later.processors[0]);
      expect(front.connections).toHaveLength(1);
      expect(levelAt(later)).toBe(1);
    });

    it("keeps the processor off the speakers: it feeds a gain at zero, never the destination itself", () => {
      const window = target();
      const hub = installAudioHub(window);
      const context = new window.AudioContext() as FakeContext;
      hub.setTap(() => {});
      const sink = context.processors[0]!.connections[0] as FakeGain;
      expect(sink.gain.value).toBe(0);
      expect((sink.to as { speakers?: boolean }).speakers).toBe(true);
    });

    it("survives a context that cannot make a script processor", () => {
      class NoProcessor extends FakeContext {
        createScriptProcessor(): never {
          throw new Error("no");
        }
      }
      const window = { AudioContext: NoProcessor as never } as AudioTarget;
      const hub = installAudioHub(window);
      const context = new (window.AudioContext as never as typeof NoProcessor)();
      expect(() => hub.setTap(() => {})).not.toThrow();
      expect(levelAt(context)).toBe(1);
    });
  });
});
