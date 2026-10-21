import { describe, expect, it } from "vitest";
import { installAudioHub, type AudioTarget } from "./audio";

/*
 * Fake audio contexts shaped like the browser's: a destination, a gain factory and nothing else. The core's
 * own driver is what the first test plays: it makes a context and wires a source STRAIGHT to `destination`
 * (RetroArch's rwebaudio, the bsnes build), which EmulatorJS's volume setter never reaches.
 */

class FakeGain {
  gain = { value: 1, cancelScheduledValues() {} };
  to: unknown = null;
  connect(to: unknown) {
    this.to = to;
    return to;
  }
}

class FakeContext {
  static made: FakeContext[] = [];
  state = "running";
  readonly destination: object = { maxChannelCount: 2, speakers: true };
  constructor() {
    FakeContext.made.push(this);
  }
  createGain() {
    return new FakeGain();
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
    const master = context.destination as unknown as FakeGain & { maxChannelCount?: number };
    expect(master).toBeInstanceOf(FakeGain);
    expect(master.maxChannelCount).toBe(2);
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
});
