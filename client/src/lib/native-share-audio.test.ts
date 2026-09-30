import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchShareConfig = vi.fn();
vi.mock("./api", () => ({ fetchShareConfig: (...args: unknown[]) => fetchShareConfig(...args) }));

import {
  armNativeShareAudio,
  armOrFallBackToChromiumAudio,
  attachNativeShareAudio,
  ensureNativeShareAudio,
  nativeShareAudioBridge,
  prefetchNativeShareAudio,
  releaseNativeShareAudioFor,
  resetNativeShareAudioForTests,
} from "./native-share-audio";
import { screenCaptureEnvironment } from "./screen-capture-audio";
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
  /** What the next context starts in, and what its resume() does. */
  static initialState = "running";
  static onResume: (context: FakeAudioContext) => Promise<void> = async () => {};
  sampleRate: number;
  state: string = FakeAudioContext.initialState;
  closed = false;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack("audio");
    return { stream: { getAudioTracks: () => [track] } };
  }
  async resume() {
    await FakeAudioContext.onResume(this);
  }
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
  const ended: Array<(event: { sessionId: string; reason: string }) => void> = [];
  return {
    ended,
    unsubscribed: 0,
    onNativeShareAudioEnded: vi.fn(function (
      this: { unsubscribed: number },
      callback: (event: { sessionId: string; reason: string }) => void,
    ) {
      ended.push(callback);
      return () => {
        this.unsubscribed += 1;
        ended.splice(ended.indexOf(callback), 1);
      };
    }),
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
  FakeAudioContext.initialState = "running";
  FakeAudioContext.onResume = async () => {};
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
  });

  it("is ready when the flag is on for the call's server and the shell self-tested", async () => {
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    expect(await ensureNativeShareAudio("server-1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledWith("server-1");
    // Cached per server, and the self-test once per page.
    await ensureNativeShareAudio("server-1");
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
    expect(shell.nativeShareAudioStatus).toHaveBeenCalledTimes(1);
  });

  it("answers per server, never from another server's check", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockImplementation(async (serverId: string | null) => ({
      desktopShareAudioNative: serverId === "on",
    }));
    const [on, off] = await Promise.all([
      ensureNativeShareAudio("on"),
      ensureNativeShareAudio("off"),
    ]);
    expect(on).toBe(true);
    expect(off).toBe(false);
  });

  it("answers from a stale cache at once and refreshes behind it", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    await ensureNativeShareAudio("server-1");
    vi.advanceTimersByTime(61_000);
    fetchShareConfig.mockReturnValue(new Promise(() => {}));
    expect(await ensureNativeShareAudio("server-1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledTimes(2);
  });

  it("goes back to the old path for the rest of the session after the shell refuses", async () => {
    const shell = bridge({ active: false });
    shell.nativeShareAudioArm = vi.fn(async () => false);
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(true);
    expect(await armNativeShareAudio()).toBe(false);
    expect(await ensureNativeShareAudio(null)).toBe(false);
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

describe("the share-start path never waits on the flag for long", () => {
  it("lets the ordinary picker go ahead when the API is slow, without waiting out its timeout", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockReturnValue(new Promise(() => {}));
    const settled = vi.fn();
    void ensureNativeShareAudio("server-1").then(settled);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(false);
  });

  it("keeps the slow answer for the next share", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ desktopShareAudioNative: true }), 1000)),
    );
    const first = vi.fn();
    void ensureNativeShareAudio("server-1").then(first);
    await vi.advanceTimersByTimeAsync(400);
    expect(first).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(700);
    const second = vi.fn();
    void ensureNativeShareAudio("server-1").then(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledWith(true);
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
  });

  it("answers a server known to be off at once, even when its answer is stale and the API is down", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: false });
    expect(await ensureNativeShareAudio("server-1")).toBe(false);
    vi.advanceTimersByTime(61_000);
    fetchShareConfig.mockReturnValue(new Promise(() => {}));
    const settled = vi.fn();
    void ensureNativeShareAudio("server-1").then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(false);
    // The refresh still went out, behind the answer.
    expect(fetchShareConfig).toHaveBeenCalledTimes(2);
  });

  it("does not wait on a shell that is slow to self-test either", async () => {
    const shell = bridge({ active: false });
    shell.nativeShareAudioStatus = vi.fn(() => new Promise(() => {}));
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    const settled = vi.fn();
    void ensureNativeShareAudio("server-1").then(settled);
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toHaveBeenCalledWith(false);
  });
});

describe("prefetchNativeShareAudio", () => {
  it("warms the flag and the self-test so the share finds both ready", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    prefetchNativeShareAudio("server-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
    expect(shell.nativeShareAudioStatus).toHaveBeenCalledTimes(1);
    expect(await ensureNativeShareAudio("server-1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
    expect(shell.nativeShareAudioStatus).toHaveBeenCalledTimes(1);
  });

  it("does not start the shell's self-test when the flag is off", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: false });
    prefetchNativeShareAudio("server-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.nativeShareAudioStatus).not.toHaveBeenCalled();
  });

  it("shares one lookup with a share that starts while it is in flight", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ desktopShareAudioNative: true }), 100)),
    );
    prefetchNativeShareAudio("server-1");
    const result = ensureNativeShareAudio("server-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
  });

  it("never asks the API in a browser, or from a shell without the capability", async () => {
    fakeWindow.pqpDesktop = undefined;
    prefetchNativeShareAudio("server-1");
    fakeWindow.pqpDesktop = { ...bridge({ active: false }), capabilities: undefined };
    prefetchNativeShareAudio("server-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchShareConfig).not.toHaveBeenCalled();
  });

  it("does not start a lookup after the shell has refused this session", async () => {
    const shell = bridge({ active: false });
    shell.nativeShareAudioArm = vi.fn(async () => false);
    fakeWindow.pqpDesktop = shell;
    await armNativeShareAudio();
    prefetchNativeShareAudio("server-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchShareConfig).not.toHaveBeenCalled();
  });
});

describe("armOrFallBackToChromiumAudio", () => {
  const nativeEnv = () =>
    screenCaptureEnvironment(true, "win32", {
      sharePickerOffersAudio: true,
      shellSystemAudio: "loopback",
      shellRestrictOwnAudio: true,
      osCanExcludeCallAudio: true,
      shellNativeShareAudio: true,
    });

  it("keeps the native path when the shell armed", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    const env = nativeEnv();
    const result = await armOrFallBackToChromiumAudio(false, env);
    expect(result.nativeAudio).toBe(true);
    expect(result.env).toBe(env);
    expect(shell.nativeShareAudioArm).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the environment WITHOUT native audio when the arm is refused, so Chromium's audio is asked for", async () => {
    const shell = bridge({ active: false });
    shell.nativeShareAudioArm = vi.fn(async () => {
      throw new Error("ipc rejected");
    });
    fakeWindow.pqpDesktop = shell;
    const result = await armOrFallBackToChromiumAudio(false, nativeEnv());
    expect(result.nativeAudio).toBe(false);
    expect(result.env.shellNativeShareAudio).toBe(false);
    // The rest of the environment is untouched: only the native half goes.
    expect(result.env.sharePickerOffersAudio).toBe(true);
    expect(result.env.isDesktopShell).toBe(true);
    // And the next share does not try again this session.
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("does not arm a share that was never going to use it", async () => {
    const shell = bridge({ active: false });
    fakeWindow.pqpDesktop = shell;
    const env = { ...nativeEnv(), shellNativeShareAudio: false };
    const result = await armOrFallBackToChromiumAudio(false, env);
    expect(result).toEqual({ nativeAudio: false, env });
    expect(shell.nativeShareAudioArm).not.toHaveBeenCalled();
  });
});

describe("a suspended audio graph is a failed attach, not a silent share", () => {
  const claim = { active: true, sessionId: "share-20", target: null } as const;

  it("fails when resume() rejects and the context stays suspended", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.onResume = async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    };
    const stream = new FakeStream();
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result).toEqual({ attached: false, reason: "audio-graph", target: null });
    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-20");
    // The next share takes the old path rather than failing the same way.
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("fails when resume() resolves into a context that is still not running", async () => {
    fakeWindow.pqpDesktop = bridge({ ...claim });
    FakeAudioContext.initialState = "suspended";
    const result = await attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    expect(result.reason).toBe("audio-graph");
  });

  it("does not hang the share when resume() never settles", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.onResume = () => new Promise(() => {});
    const pending = attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).reason).toBe("audio-graph");
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-20");
  });

  it("attaches when resume() brings the context to running", async () => {
    fakeWindow.pqpDesktop = bridge({ ...claim });
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.onResume = async (context) => {
      context.state = "running";
    };
    const stream = new FakeStream();
    expect((await attachNativeShareAudio(stream as unknown as MediaStream)).attached).toBe(true);
    expect(stream.getAudioTracks()).toHaveLength(1);
  });
});

describe("a capture that ends on its own", () => {
  it("stops the track and frees the graph, without asking the shell to stop what it already stopped", async () => {
    const shell = bridge({ active: true, sessionId: "share-30", target: null });
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(shell.ended).toHaveLength(1);
    shell.ended[0]({ sessionId: "share-30", reason: "ended" });
    expect(stream.getAudioTracks()[0]?.readyState).toBe("ended");
    expect(shell.nativeShareAudioStop).not.toHaveBeenCalled();
    expect(shell.unsubscribed).toBe(1);
  });

  it("ignores another session's end", async () => {
    const shell = bridge({ active: true, sessionId: "share-31", target: null });
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream);
    shell.ended[0]({ sessionId: "share-other", reason: "ended" });
    expect(stream.getAudioTracks()[0]?.readyState).toBe("live");
  });

  it("stops listening when the share itself ends", async () => {
    const shell = bridge({ active: true, sessionId: "share-32", target: null });
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream);
    releaseNativeShareAudioFor(stream.getTracks() as unknown as MediaStreamTrack[]);
    expect(shell.unsubscribed).toBe(1);
    expect(shell.ended).toHaveLength(0);
  });

  it("works with a shell from before the event existed", async () => {
    const shell = {
      ...bridge({ active: true, sessionId: "share-33", target: null }),
      onNativeShareAudioEnded: undefined,
    };
    fakeWindow.pqpDesktop = shell;
    const stream = new FakeStream();
    expect((await attachNativeShareAudio(stream as unknown as MediaStream)).attached).toBe(true);
  });
});
