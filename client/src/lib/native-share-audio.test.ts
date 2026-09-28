import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchShareConfig = vi.fn();
vi.mock("./api", () => ({ fetchShareConfig: (...args: unknown[]) => fetchShareConfig(...args) }));

import {
  attachNativeShareAudio,
  ensureNativeShareAudio,
  nativeShareAudioBridge,
  nativeShareAudioReady,
  releaseNativeShareAudioFor,
  resetNativeShareAudioForTests,
} from "./native-share-audio";
import type { NativeShareAudioClaim, PqpDesktop } from "./desktop";

/** Enough of a window for the port handshake: listeners and postMessage. */
class FakeWindow extends EventTarget {
  pqpDesktop: Partial<PqpDesktop> | undefined;
  deliver(sessionId: string, port: object) {
    const event = new Event("message") as Event & { data: unknown; ports: unknown[] };
    Object.assign(event, { data: { type: "pqp:native-share-audio-port", sessionId }, ports: [port] });
    this.dispatchEvent(event);
  }
}

/** A MediaStreamTrack that knows it was stopped, as the real one does. */
class FakeTrack {
  readyState: "live" | "ended" = "live";
  constructor(readonly kind: string) {}
  stop() {
    this.readyState = "ended";
  }
}

class FakeStream {
  tracks: FakeTrack[] = [new FakeTrack("video")];
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
}

const posted: unknown[] = [];

class FakeAudioContext {
  sampleRate: number;
  state = "running";
  closed = false;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack("audio");
    return { stream: { getAudioTracks: () => [track] } };
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}

class FakeWorkletNode {
  port = { postMessage: (message: unknown) => posted.push(message) };
  connect() {}
  disconnect() {}
}

function bridge(claim: NativeShareAudioClaim, options: { available?: boolean } = {}) {
  return {
    capabilities: { nativeShareAudio: true } as PqpDesktop["capabilities"],
    nativeShareAudioStatus: vi.fn(async () => ({
      available: options.available ?? true,
      reason: options.available === false ? "activate" : null,
      stage: null,
      hr: null,
      build: 19045,
    })),
    nativeShareAudioArm: vi.fn(async () => true),
    nativeShareAudioClaim: vi.fn(async () => {
      if (claim.active && claim.sessionId) {
        fakeWindow.deliver(claim.sessionId, { close: vi.fn() });
      }
      return claim;
    }),
    nativeShareAudioStop: vi.fn(async () => {}),
  };
}

let fakeWindow: FakeWindow;

beforeEach(() => {
  vi.useFakeTimers();
  fakeWindow = new FakeWindow();
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  fetchShareConfig.mockReset();
  posted.length = 0;
  resetNativeShareAudioForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("nativeShareAudioBridge", () => {
  it("needs the capability AND every method, so an older shell is left alone", () => {
    expect(nativeShareAudioBridge(undefined)).toBeNull();
    const full = bridge({ active: false });
    expect(nativeShareAudioBridge(full as unknown as PqpDesktop)).not.toBeNull();
    const noCapability = { ...full, capabilities: undefined };
    expect(nativeShareAudioBridge(noCapability as unknown as PqpDesktop)).toBeNull();
    const partial = { ...full, nativeShareAudioClaim: undefined };
    expect(nativeShareAudioBridge(partial as unknown as PqpDesktop)).toBeNull();
  });
});

describe("ensureNativeShareAudio", () => {
  it("never touches the shell while the flag is off", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: false });
    expect(await ensureNativeShareAudio("server-1")).toBe(false);
    expect(shell.nativeShareAudioStatus).not.toHaveBeenCalled();
    expect(nativeShareAudioReady()).toBe(false);
  });

  it("is ready when the flag is on for the call's server and the shell self-tested", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio("server-1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledWith("server-1");
    expect(nativeShareAudioReady()).toBe(true);
    // Cached per server: the next share does not ask the API again.
    await ensureNativeShareAudio("server-1");
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
  });

  it("is not ready on a Windows build whose self-test failed", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false }, { available: false });
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("reads an unreachable API as off, without caching the failure", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockRejectedValueOnce(new Error("offline"));
    expect(await ensureNativeShareAudio(null)).toBe(false);
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(true);
  });
});

describe("attachNativeShareAudio", () => {
  it("adds the shell's capture to the stream as its audio track", async () => {
    fakeWindow.pqpDesktop = bridge({
      active: true,
      sessionId: "share-1",
      target: { mode: "include", reason: "window-app", exe: "chrome.exe" },
    });
    const stream = new FakeStream();
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result.attached).toBe(true);
    expect(result.target?.exe).toBe("chrome.exe");
    expect(stream.getAudioTracks()).toHaveLength(1);
    // The PCM port went to the worklet, not through this thread.
    expect(posted[0]).toMatchObject({ type: "port" });
  });

  it("leaves the stream silent when the box was not ticked", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false, reason: "none" });
    const stream = new FakeStream();
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result).toEqual({ attached: false, reason: "none", target: null });
    expect(stream.getAudioTracks()).toHaveLength(0);
  });

  it("stops only its own capture, by session, when the share ends", async () => {
    const shell = bridge({ active: true, sessionId: "share-7", target: null });
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream);
    releaseNativeShareAudioFor([new FakeTrack("audio") as unknown as MediaStreamTrack]);
    expect(shell.nativeShareAudioStop).not.toHaveBeenCalled();
    releaseNativeShareAudioFor(stream.getTracks() as unknown as MediaStreamTrack[]);
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-7");
    expect(stream.getAudioTracks()[0]?.readyState).toBe("ended");
  });

  it("notices a share stopped from outside (the video track ended)", async () => {
    const shell = bridge({ active: true, sessionId: "share-8", target: null });
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream);
    stream.getVideoTracks()[0]?.stop();
    vi.advanceTimersByTime(1000);
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-8");
  });

  it("gives up and stops the capture when no port arrives", async () => {
    const shell = bridge({ active: true, sessionId: "share-9", target: null });
    shell.nativeShareAudioClaim = vi.fn(async () => ({ active: true, sessionId: "share-9" }));
    fakeWindow.pqpDesktop = shell;
    const pending = attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).reason).toBe("port");
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-9");
  });
});
