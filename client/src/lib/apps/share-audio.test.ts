import { describe, expect, it, vi } from "vitest";
import {
  ShareAudioRelay,
  ShareAudioSink,
  SINK_BEHIND_SECONDS,
  SINK_LEAD_SECONDS,
  SINK_MAX_QUEUE_SECONDS,
  type SinkContext,
} from "./share-audio";

/** A Web Audio stand-in that records what is scheduled and when, with a clock the test moves. */
function fakeContext(options: { noTrack?: boolean; resumeRejects?: boolean; destinationThrows?: boolean } = {}) {
  const scheduled: Array<{ when: number; frames: number; rate: number; planes: Float32Array[] }> = [];
  const track = { stop: vi.fn(), kind: "audio" } as unknown as MediaStreamTrack;
  const state = { time: 0, closed: false, resumed: 0, run: "running" };
  const context: SinkContext = {
    get currentTime() {
      return state.time;
    },
    get state() {
      return state.run;
    },
    createBuffer(channels, frames, rate) {
      const planes = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        duration: frames / rate,
        copyToChannel(source: Float32Array, channel: number) {
          planes[channel]!.set(source);
        },
        planes,
        frames,
        rate,
      } as never;
    },
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        connect: vi.fn(),
        onended: null,
        start(when: number) {
          const buffer = source.buffer as { frames: number; rate: number; planes: Float32Array[] };
          scheduled.push({ when, frames: buffer.frames, rate: buffer.rate, planes: buffer.planes });
        },
      };
      return source;
    },
    createMediaStreamDestination() {
      if (options.destinationThrows) throw new Error("no destination");
      return {
        stream: { getAudioTracks: () => (options.noTrack ? [] : [track]) } as unknown as MediaStream,
      };
    },
    async resume() {
      state.resumed += 1;
      if (options.resumeRejects) throw new DOMException("not allowed", "NotAllowedError");
    },
    async close() {
      state.closed = true;
    },
  };
  return { context, scheduled, track, state };
}

/** 48 kHz stereo block of `frames` frames, left = 0.5, right = -0.25. */
function block(frames = 2048, rate = 48000) {
  const samples = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    samples[i * 2] = 0.5;
    samples[i * 2 + 1] = -0.25;
  }
  return { rate, channels: 2 as const, samples: samples.buffer };
}

describe("ShareAudioSink", () => {
  it("makes a live audio track and starts the context", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    expect(sink.track).toBe(rig.track);
    expect(rig.state.resumed).toBe(1);
  });

  it("closes the context it opened when the destination cannot be made", () => {
    const rig = fakeContext({ destinationThrows: true });
    expect(() => new ShareAudioSink({ createContext: () => rig.context })).toThrow("no destination");
    expect(rig.state.closed).toBe(true);
  });

  it("says whether the audio context started: a refusal (autoplay policy) is a track that would carry silence", async () => {
    const ok = new ShareAudioSink({ createContext: () => fakeContext().context });
    await expect(ok.ready).resolves.toBe(true);
    const refused = new ShareAudioSink({ createContext: () => fakeContext({ resumeRejects: true }).context });
    await expect(refused.ready).resolves.toBe(false);
  });

  it("says once that the audio is lost when the browser will not start a context that stopped mid-share", async () => {
    const rig = fakeContext();
    const lost = vi.fn();
    const sink = new ShareAudioSink({ createContext: () => rig.context, onLost: lost });
    await sink.ready;
    rig.context.resume = async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    };
    rig.state.run = "suspended";
    sink.push(block());
    sink.push(block());
    await Promise.resolve();
    await Promise.resolve();
    expect(lost).toHaveBeenCalledTimes(1);
    sink.close();
  });

  it("keeps one ask in flight while the context is suspended, and stops asking once the loss was said", async () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    await sink.ready;
    rig.state.resumed = 0;
    let settle!: () => void;
    rig.context.resume = () => {
      rig.state.resumed += 1;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    };
    rig.state.run = "suspended";
    for (let i = 0; i < 20; i += 1) sink.push(block());
    expect(rig.state.resumed).toBe(1);
    settle();
    await Promise.resolve();
    sink.push(block());
    expect(rig.state.resumed).toBe(2);
    // a refusal is the end of it: no more asks for the rest of the share
    rig.context.resume = () => {
      rig.state.resumed += 1;
      return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
    };
    await Promise.resolve();
    sink.push(block());
    await Promise.resolve();
    await Promise.resolve();
    const asked = rig.state.resumed;
    for (let i = 0; i < 10; i += 1) sink.push(block());
    expect(rig.state.resumed).toBe(asked);
  });

  it("asks the browser again with the next block when the context is not running", async () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    await sink.ready;
    expect(rig.state.resumed).toBe(1);
    rig.state.run = "suspended";
    sink.push(block());
    expect(rig.state.resumed).toBe(2);
  });

  it("is refused when the destination has no track, and closes what it opened", () => {
    const rig = fakeContext({ noTrack: true });
    expect(() => new ShareAudioSink({ createContext: () => rig.context })).toThrow();
    expect(rig.state.closed).toBe(true);
  });

  it("plays the app's samples: planar, in order, at the rate the app made them at", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.push(block(4, 44100));
    expect(rig.scheduled).toHaveLength(1);
    const first = rig.scheduled[0]!;
    expect(first.rate).toBe(44100);
    expect(Array.from(first.planes[0]!)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(first.planes[1]!)).toEqual([-0.25, -0.25, -0.25, -0.25]);
  });

  it("starts a short lead ahead of the clock, then queues each block right behind the last (gapless)", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.push(block());
    sink.push(block());
    const [a, b] = rig.scheduled;
    expect(a!.when).toBeCloseTo(SINK_LEAD_SECONDS, 6);
    expect(b!.when).toBeCloseTo(a!.when + 2048 / 48000, 6);
  });

  it("starts over a lead ahead of the clock after a silence, instead of playing late", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.push(block());
    // the app sends nothing while the game is silent: a second goes by
    rig.state.time = 1;
    sink.push(block());
    expect(rig.scheduled[1]!.when).toBeCloseTo(1 + SINK_LEAD_SECONDS, 6);
  });

  it("does not start over while the queue is still ahead of the clock (a block that arrives early is queued)", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.push(block());
    rig.state.time = 2048 / 48000 / 2;
    sink.push(block());
    expect(rig.scheduled[1]!.when).toBeCloseTo(SINK_LEAD_SECONDS + 2048 / 48000, 6);
    expect(SINK_BEHIND_SECONDS).toBeLessThan(SINK_LEAD_SECONDS);
  });

  it("drops blocks that arrive faster than they play rather than letting the sound lag further and further", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    // ~42.7 ms each at an instant: more than the queue's ceiling in a burst
    const blocks = Math.ceil(SINK_MAX_QUEUE_SECONDS / (2048 / 48000)) + 4;
    for (let i = 0; i < blocks; i += 1) sink.push(block());
    expect(sink.dropped).toBeGreaterThan(0);
    expect(sink.played).toBeLessThan(blocks);
  });

  it("loses a block it cannot make a buffer of, and carries on", () => {
    const rig = fakeContext();
    const createBuffer = rig.context.createBuffer.bind(rig.context);
    let calls = 0;
    rig.context.createBuffer = (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("bad rate");
      return createBuffer(...args);
    };
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.push(block());
    sink.push(block());
    expect(sink.dropped).toBe(1);
    expect(rig.scheduled).toHaveLength(1);
  });

  it("stops its track and closes the context, and plays nothing afterwards", () => {
    const rig = fakeContext();
    const sink = new ShareAudioSink({ createContext: () => rig.context });
    sink.close();
    sink.close();
    expect(rig.track.stop).toHaveBeenCalledTimes(1);
    expect(rig.state.closed).toBe(true);
    sink.push(block());
    expect(rig.scheduled).toHaveLength(0);
  });
});

describe("ShareAudioRelay", () => {
  function relay() {
    const rig = fakeContext();
    const made: ShareAudioSink[] = [];
    const instance = new ShareAudioRelay(() => {
      const sink = new ShareAudioSink({ createContext: () => rig.context });
      made.push(sink);
      return sink;
    });
    return { instance, rig, made };
  }

  it("begins by asking the app for its sound and hands back the track to publish", async () => {
    const { instance, rig } = relay();
    const wanted = vi.fn();
    instance.subscribe(wanted);
    expect(wanted).not.toHaveBeenCalled();
    expect(await instance.begin()).toBe(rig.track);
    expect(wanted).toHaveBeenCalledWith(true);
    expect(instance.active).toBe(true);
  });

  it("plays what the frame sends while a share runs, and nothing before or after", async () => {
    const { instance, rig } = relay();
    instance.push(block());
    expect(rig.scheduled).toHaveLength(0);
    await instance.begin();
    instance.push(block());
    expect(rig.scheduled).toHaveLength(1);
    instance.end();
    instance.push(block());
    expect(rig.scheduled).toHaveLength(1);
  });

  it("ends by telling the app to stop and closing the track", async () => {
    const { instance, rig } = relay();
    const wanted = vi.fn();
    await instance.begin();
    instance.subscribe(wanted);
    // a frame that mounts mid-share is told at once
    expect(wanted).toHaveBeenLastCalledWith(true);
    instance.end();
    expect(wanted).toHaveBeenLastCalledWith(false);
    expect(rig.track.stop).toHaveBeenCalled();
    expect(instance.active).toBe(false);
    // ending twice says nothing twice
    wanted.mockClear();
    instance.end();
    expect(wanted).not.toHaveBeenCalled();
  });

  it("gives no track and asks the app for nothing when the browser would not start the audio (the share goes out as a picture only)", async () => {
    const rig = fakeContext({ resumeRejects: true });
    const instance = new ShareAudioRelay(() => new ShareAudioSink({ createContext: () => rig.context }));
    const wanted = vi.fn();
    instance.subscribe(wanted);
    expect(await instance.begin()).toBeNull();
    expect(wanted).not.toHaveBeenCalled();
    expect(instance.active).toBe(false);
    expect(rig.state.closed).toBe(true);
    expect(rig.track.stop).toHaveBeenCalled();
  });

  it("tells its listeners when the audio of the running share is lost", async () => {
    const rig = fakeContext();
    const instance = new ShareAudioRelay((onLost) => new ShareAudioSink({ createContext: () => rig.context, onLost }));
    const lost = vi.fn();
    const off = instance.onLost(lost);
    await instance.begin();
    rig.context.resume = async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    };
    rig.state.run = "suspended";
    instance.push(block());
    await Promise.resolve();
    await Promise.resolve();
    expect(lost).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not wait for ever on a context that never answers", async () => {
    const rig = fakeContext();
    rig.context.resume = () => new Promise(() => {});
    const instance = new ShareAudioRelay(() => new ShareAudioSink({ createContext: () => rig.context }), 20);
    expect(await instance.begin()).toBeNull();
    expect(instance.active).toBe(false);
    expect(rig.state.closed).toBe(true);
  });

  it("a share that ended while the context was starting does not come back with a track", async () => {
    const { instance } = relay();
    const pending = instance.begin();
    instance.end();
    expect(await pending).toBeNull();
    expect(instance.active).toBe(false);
  });

  it("a second share starts a fresh sink and closes the first", async () => {
    const { instance, made } = relay();
    await instance.begin();
    await instance.begin();
    expect(made).toHaveLength(2);
    expect(instance.active).toBe(true);
  });

  it("gives no track, and asks the app for nothing, where there is no Web Audio", async () => {
    const instance = new ShareAudioRelay(() => {
      throw new Error("no Web Audio");
    });
    const wanted = vi.fn();
    instance.subscribe(wanted);
    expect(await instance.begin()).toBeNull();
    expect(wanted).not.toHaveBeenCalled();
    expect(instance.active).toBe(false);
  });

  it("one listener that throws does not stop the others, and an unsubscribed one hears nothing", async () => {
    const { instance } = relay();
    const good = vi.fn();
    instance.subscribe(() => {
      throw new Error("x");
    });
    const off = instance.subscribe(good);
    await instance.begin();
    expect(good).toHaveBeenCalledWith(true);
    off();
    good.mockClear();
    instance.end();
    expect(good).not.toHaveBeenCalled();
  });
});
