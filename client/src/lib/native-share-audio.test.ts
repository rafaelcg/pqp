import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchShareConfig = vi.fn();
vi.mock("./api", () => ({ fetchShareConfig: (...args: unknown[]) => fetchShareConfig(...args) }));

import {
  describeNativeShareAudio,
  nativeShareAudioDiagnostics,
} from "./native-share-audio-diagnostics";
import {
  armNativeShareAudio,
  armOrFallBackToChromiumAudio,
  attachNativeShareAudio,
  discardPrimedNativeShareAudio,
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
  static instances: FakeAudioContext[] = [];
  static workletError: Error | null = null;
  sampleRate: number;
  state: string = FakeAudioContext.initialState;
  closed = false;
  audioWorklet = {
    addModule: vi.fn(async () => {
      if (FakeAudioContext.workletError) {
        throw FakeAudioContext.workletError;
      }
    }),
  };
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    FakeAudioContext.instances.push(this);
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
  static instances: FakeWorkletNode[] = [];
  port: { postMessage: (message: unknown) => void; onmessage: ((event: { data: unknown }) => void) | null } = {
    postMessage: (message: unknown) => posted.push(message),
    onmessage: null,
  };
  constructor() {
    FakeWorkletNode.instances.push(this);
  }
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
  FakeAudioContext.instances = [];
  FakeAudioContext.workletError = null;
  FakeWorkletNode.instances = [];
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

describe("the graph is built at arm time, in the share click", () => {
  const claim = { active: true, sessionId: "share-40", target: null } as const;

  it("builds and runs the audio graph before arming the shell, and attaches to that same graph", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    expect(await armNativeShareAudio()).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    const stream = new FakeStream();
    expect((await attachNativeShareAudio(stream as unknown as MediaStream)).attached).toBe(true);
    // One context, one module load: the attach did not build a second graph.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(stream.getAudioTracks()).toHaveLength(1);
  });

  it("does not arm the shell when the context will not run, and leaves the next share free to try again", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    FakeAudioContext.initialState = "suspended";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await armNativeShareAudio()).toBe(false);
    expect(shell.nativeShareAudioArm).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    // A context that was suspended may run on the next click: not a verdict.
    FakeAudioContext.initialState = "running";
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(true);
  });

  it("does not arm the shell when the worklet cannot load, and stops offering it this session", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    FakeAudioContext.workletError = new DOMException("blocked", "AbortError");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await armNativeShareAudio()).toBe(false);
    expect(shell.nativeShareAudioArm).not.toHaveBeenCalled();
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("does not arm the shell when the context cannot run at the shell's sample rate", async () => {
    const shell = bridge({ ...claim });
    fakeWindow.pqpDesktop = shell;
    class Rate44 extends FakeAudioContext {
      constructor() {
        super({ sampleRate: 44100 });
      }
    }
    vi.stubGlobal("AudioContext", Rate44);
    expect(await armNativeShareAudio()).toBe(false);
    expect(shell.nativeShareAudioArm).not.toHaveBeenCalled();
  });

  it("closes the graph when the picker never produced a share", async () => {
    fakeWindow.pqpDesktop = bridge({ ...claim });
    expect(await armNativeShareAudio()).toBe(true);
    discardPrimedNativeShareAudio();
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("closes a graph nobody used after the arm's own lifetime", async () => {
    fakeWindow.pqpDesktop = bridge({ ...claim });
    expect(await armNativeShareAudio()).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("closes the graph when the box was left unticked", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false, reason: "none" });
    expect(await armNativeShareAudio()).toBe(true);
    const result = await attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    expect(result.reason).toBe("none");
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });
});

describe("a capture that ends while or after it is attached", () => {
  it("fails the attach when the end arrives before the attach finished, rather than leave a silent track", async () => {
    const shell = bridge({ active: true, sessionId: "share-50", target: null });
    const deliver = shell.nativeShareAudioClaim;
    // The shell reports the end in the middle of the attach: after the claim
    // answered, before the graph is wired. One event, never replayed.
    shell.nativeShareAudioClaim = vi.fn(async () => {
      const answer = await deliver();
      queueMicrotask(() => shell.ended.forEach((listener) => listener({ sessionId: "share-50", reason: "ended" })));
      return answer;
    });
    fakeWindow.pqpDesktop = shell;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = new FakeStream();
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result).toEqual({ attached: false, reason: "ended", target: null });
    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    expect(shell.unsubscribed).toBe(1);
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("tells the owner, stops the track and stops offering native sound when it ends under a live share", async () => {
    const shell = bridge({ active: true, sessionId: "share-51", target: null });
    fakeWindow.pqpDesktop = shell;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onEnded = vi.fn();
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream, { onEnded });
    shell.ended[0]?.({ sessionId: "share-51", reason: "failed" });
    expect(onEnded).toHaveBeenCalledWith({ reason: "failed" });
    expect(stream.getAudioTracks()[0]?.readyState).toBe("ended");
    expect(shell.nativeShareAudioStop).not.toHaveBeenCalled();
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("notices a context that stops running mid-share, asks it to resume, and gives up after three looks", async () => {
    const shell = bridge({ active: true, sessionId: "share-52", target: null });
    fakeWindow.pqpDesktop = shell;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onEnded = vi.fn();
    const stream = new FakeStream();
    await attachNativeShareAudio(stream as unknown as MediaStream, { onEnded });
    const context = FakeAudioContext.instances[0]!;
    const resume = vi.spyOn(context, "resume");
    context.state = "suspended";
    await vi.advanceTimersByTimeAsync(1000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnded).toHaveBeenCalledWith({ reason: "context-suspended" });
    // The shell's capture is stopped too: nothing is listening to it any more.
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-52");
  });

  it("does not give up on a context that recovers", async () => {
    fakeWindow.pqpDesktop = bridge({ active: true, sessionId: "share-53", target: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onEnded = vi.fn();
    await attachNativeShareAudio(new FakeStream() as unknown as MediaStream, { onEnded });
    const context = FakeAudioContext.instances[0]!;
    context.state = "suspended";
    await vi.advanceTimersByTimeAsync(2000);
    context.state = "running";
    await vi.advanceTimersByTimeAsync(5000);
    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe("what the worklet reports, and what the diagnostics say", () => {
  it("logs once when the native track starts delivering, and records the level", async () => {
    fakeWindow.pqpDesktop = bridge({ active: true, sessionId: "share-60", target: null });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    info.mockClear();
    const node = FakeWorkletNode.instances[0]!;
    node.port.onmessage?.({ data: { type: "first" } });
    node.port.onmessage?.({ data: { type: "first" } });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/delivering samples/);
    node.port.onmessage?.({ data: { type: "stats", chunks: 120, frames: 57600, peak: 0.42, underflows: 1 } });
    const line = describeNativeShareAudio();
    expect(line).toContain("chunks=120");
    expect(line).toContain("peak=0.420");
    expect(line).toContain("attached=true");
  });

  it("names the stage a failed share stopped at, for one console paste", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false, reason: "failed", stage: "initialize", hr: 0x88890010 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await attachNativeShareAudio(new FakeStream() as unknown as MediaStream);
    const diagnostics = nativeShareAudioDiagnostics();
    expect(diagnostics.failedStage).toBe("claim");
    expect(describeNativeShareAudio()).toMatch(/FAILED at claim: failed\/initialize\//);
  });

  it("names the graph as the failing stage when the context would not run", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    FakeAudioContext.initialState = "suspended";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await armNativeShareAudio();
    expect(describeNativeShareAudio()).toMatch(/graph=fail:suspended.*FAILED at graph: suspended/);
  });

  it("records the flag and the self-test of the page", async () => {
    fakeWindow.pqpDesktop = bridge({ active: false });
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    await ensureNativeShareAudio("server-1");
    expect(describeNativeShareAudio()).toContain("flag=true shell=ok");
  });
});

describe("an error nobody planned for still lets go of everything", () => {
  it("stops the shell's capture, closes the graph and reports a failed attach when the context throws at share start", async () => {
    const shell = bridge({ active: true, sessionId: "share-70", target: null });
    fakeWindow.pqpDesktop = shell;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await armNativeShareAudio()).toBe(true);
    const context = FakeAudioContext.instances[0]!;
    // Suspended between the arm and the attach, and resume() throws where the
    // spec says it rejects.
    context.state = "suspended";
    context.resume = () => {
      throw new TypeError("resume is not available");
    };
    const stream = new FakeStream();
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result).toEqual({ attached: false, reason: "error", target: null });
    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-70");
    expect(context.closed).toBe(true);
    expect(shell.unsubscribed).toBe(1);
    expect(describeNativeShareAudio()).toContain("FAILED at attach");
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: true });
    expect(await ensureNativeShareAudio(null)).toBe(false);
  });

  it("does not leave a live session behind when adding the track to the stream throws", async () => {
    const shell = bridge({ active: true, sessionId: "share-71", target: null });
    fakeWindow.pqpDesktop = shell;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = new FakeStream();
    stream.addTrack = () => {
      throw new Error("stream is closed");
    };
    const result = await attachNativeShareAudio(stream as unknown as MediaStream);
    expect(result.attached).toBe(false);
    expect(result.reason).toBe("error");
    expect(shell.nativeShareAudioStop).toHaveBeenCalledWith("share-71");
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    // The watch on the session is gone: nothing ticks for a share that never was.
    await vi.advanceTimersByTimeAsync(5000);
    expect(shell.nativeShareAudioStop).toHaveBeenCalledTimes(1);
  });
});
