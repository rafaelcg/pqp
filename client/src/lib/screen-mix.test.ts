import { describe, expect, it, vi } from "vitest";
import { createScreenMix, type AudioNodeLike } from "./screen-mix";

class FakeTrack {
  kind: string;
  stopped = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
vi.stubGlobal("MediaStream", FakeStream);

function fakeContext() {
  const connections: string[] = [];
  const node = (name: string): AudioNodeLike & { name: string } => ({
    name,
    connect: () => {
      connections.push(name);
    },
    disconnect: () => {
      connections.splice(connections.indexOf(name), 1);
    },
  });
  const mixed = new FakeTrack("audio");
  let sources = 0;
  const closed = vi.fn();
  return {
    connections,
    mixed,
    closed,
    context: {
      createMediaStreamSource: (stream: FakeStream) =>
        node(`${stream.getAudioTracks().length > 0 ? "src" : "empty"}${sources++}`),
      createMediaStreamDestination: () => ({
        ...node("dest"),
        stream: new FakeStream([mixed]),
      }),
      close: closed,
    },
  };
}

describe("createScreenMix", () => {
  it("publishes the display video with ONE mixed audio track", () => {
    const f = fakeContext();
    const video = new FakeTrack("video");
    const display = new FakeStream([video, new FakeTrack("audio")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(
      display as unknown as MediaStream,
      mic as unknown as MediaStream,
      () => f.context as never,
    );
    expect((mix.stream as unknown as FakeStream).getVideoTracks()).toEqual([video]);
    expect((mix.stream as unknown as FakeStream).getAudioTracks()).toEqual([f.mixed]);
    // Both branches feed the destination.
    expect(f.connections).toHaveLength(2);
    expect(mix.micIn()).toBe(true);
  });

  it("is the microphone alone when the capture had no audio", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, mic as never, () => f.context as never);
    expect(f.connections).toHaveLength(1);
    expect(mix.micIn()).toBe(true);
  });

  it("swaps the microphone branch on a device change, and drops it on null", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, null, () => f.context as never);
    expect(mix.micIn()).toBe(false);
    mix.setMic(new FakeStream([new FakeTrack("audio")]) as never);
    expect(mix.micIn()).toBe(true);
    expect(f.connections).toHaveLength(2);
    mix.setMic(null);
    expect(mix.micIn()).toBe(false);
    expect(f.connections).toHaveLength(1);
  });

  it("closes the context and stops the mixed track", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, null, () => f.context as never);
    mix.close();
    expect(f.mixed.stopped).toBe(true);
    expect(f.closed).toHaveBeenCalled();
    expect(f.connections).toHaveLength(0);
  });
});
