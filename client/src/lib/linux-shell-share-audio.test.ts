import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_SHARE_AUDIO_TTL_MS,
  armLinuxShellShareAudio,
  attachLinuxShellShareAudio,
  ensureLinuxShellShareAudio,
  linuxShellShareAudioReady,
  pickShareAudioInput,
  resetLinuxShellShareAudioForTests,
  shareAudioInputConstraints,
  shellCanBuildLinuxShareAudio,
  type AttachDeps,
  type EnsureDeps,
} from "./linux-shell-share-audio";
import {
  canExcludeCallFromSystemAudio,
  liveScreenCaptureEnvironment,
  needsShareAudioPrompt,
  offersShellSystemAudio,
  screenCaptureOptions,
  shellCarriesScreenAudio,
} from "./screen-capture-audio";

/** What the new Linux shell publishes (electron/preload.js). */
function linuxShell(overrides: Record<string, unknown> = {}) {
  return {
    isElectron: true,
    platform: "linux",
    sharePickerOffersAudio: true,
    capabilities: {
      displayMedia: true,
      systemAudio: "none",
      restrictOwnAudio: true,
      pickerOffersAudio: false,
      linuxShareAudio: true,
      version: "0.1.10",
    },
    linuxShareAudioStatus: async () => ({ available: true, server: "pipewire" }),
    linuxShareAudioArm: async () => true,
    linuxShareAudioClaim: async () => ({ active: true, label: "pqp-share-audio" }),
    ...overrides,
  };
}

function setShell(shell: unknown): void {
  (globalThis as { window?: unknown }).window =
    shell === undefined ? {} : { pqpDesktop: shell };
}

function deps(flag: boolean | "throws", now = 0): EnsureDeps & { fetches: number } {
  const d = {
    fetches: 0,
    shellCan: shellCanBuildLinuxShareAudio,
    fetchConfig: async () => {
      d.fetches += 1;
      if (flag === "throws") {
        throw new Error("offline");
      }
      return { linuxDesktopSystemAudio: flag };
    },
    status: () =>
      (globalThis as { window?: { pqpDesktop?: { linuxShareAudioStatus?: () => Promise<{ available: boolean }> } } })
        .window?.pqpDesktop?.linuxShareAudioStatus?.(),
    now: () => now,
  };
  return d;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  resetLinuxShellShareAudioForTests();
});

describe("ensureLinuxShellShareAudio", () => {
  it("offers nothing outside the Linux shell, and asks nobody", async () => {
    setShell(linuxShell({ platform: "win32" }));
    const d = deps(true);
    expect(await ensureLinuxShellShareAudio(d)).toBe(false);
    expect(d.fetches).toBe(0);
  });

  it("offers nothing from a shell that cannot build the bus, flag or not", async () => {
    const shell = linuxShell();
    delete (shell.capabilities as { linuxShareAudio?: boolean }).linuxShareAudio;
    setShell(shell);
    expect(await ensureLinuxShellShareAudio(deps(true))).toBe(false);
  });

  it("stays off while the runtime flag is off: today's Linux share", async () => {
    setShell(linuxShell());
    expect(await ensureLinuxShellShareAudio(deps(false))).toBe(false);
    const env = liveScreenCaptureEnvironment();
    expect(env.shellLinuxShareAudio).toBe(false);
    expect(offersShellSystemAudio(env)).toBe(false);
    // The request stays video-only, which is what every Linux shell sent.
    expect(screenCaptureOptions(true, env).audio).toBe(false);
  });

  it("never asks the shell about the sound server while the flag is off", async () => {
    let asked = 0;
    setShell(
      linuxShell({
        linuxShareAudioStatus: async () => {
          asked += 1;
          return { available: true, server: "pipewire" };
        },
      }),
    );
    expect(await ensureLinuxShellShareAudio(deps(false))).toBe(false);
    expect(await ensureLinuxShellShareAudio(deps("throws"))).toBe(false);
    expect(asked).toBe(0);
  });

  it("stays off without a sound server, and when the config cannot be read", async () => {
    setShell(linuxShell({ linuxShareAudioStatus: async () => ({ available: false, server: null }) }));
    expect(await ensureLinuxShellShareAudio(deps(true))).toBe(false);
    resetLinuxShellShareAudioForTests();
    setShell(linuxShell());
    expect(await ensureLinuxShellShareAudio(deps("throws"))).toBe(false);
  });

  it("with all three, asks first and requests audio only on a yes", async () => {
    setShell(linuxShell());
    expect(await ensureLinuxShellShareAudio(deps(true))).toBe(true);
    const env = liveScreenCaptureEnvironment();
    expect(env.shellLinuxShareAudio).toBe(true);
    expect(shellCarriesScreenAudio(env)).toBe(true);
    expect(canExcludeCallFromSystemAudio(env)).toBe(true);
    // The legacy `sharePickerOffersAudio: true` must not skip the question:
    // on Wayland the shell's picker never opens to ask it.
    expect(env.sharePickerOffersAudio).toBe(false);
    expect(needsShareAudioPrompt(env)).toBe(true);
    expect(screenCaptureOptions(false, env).audio).toBe(false);
    expect(screenCaptureOptions(true, env).audio).not.toBe(false);
  });

  it("reads the flag on every share, so turning it off takes effect at once", async () => {
    setShell(linuxShell());
    expect(await ensureLinuxShellShareAudio(deps(true, 0))).toBe(true);
    const off = deps(false, 1);
    expect(await ensureLinuxShellShareAudio(off)).toBe(false);
    expect(off.fetches).toBe(1);
    expect(linuxShellShareAudioReady()).toBe(false);
    // And back on, with the sound-server answer still trusted.
    expect(await ensureLinuxShellShareAudio(deps(true, 2))).toBe(true);
  });

  it("trusts the sound-server answer for a minute, then asks the shell again", async () => {
    let asked = 0;
    setShell(
      linuxShell({
        linuxShareAudioStatus: async () => {
          asked += 1;
          return { available: true, server: "pipewire" };
        },
      }),
    );
    await ensureLinuxShellShareAudio(deps(true, 0));
    await ensureLinuxShellShareAudio(deps(true, LINUX_SHARE_AUDIO_TTL_MS - 1));
    expect(asked).toBe(1);
    await ensureLinuxShellShareAudio(deps(true, LINUX_SHARE_AUDIO_TTL_MS));
    expect(asked).toBe(2);
  });
});

describe("the capture device", () => {
  it("is found by its label among inputs only", () => {
    const devices = [
      { kind: "audiooutput", label: "pqp-share-audio", deviceId: "out" },
      { kind: "audioinput", label: "Built-in mic", deviceId: "mic" },
      { kind: "audioinput", label: "pqp-share-audio", deviceId: "bus" },
    ];
    expect(pickShareAudioInput(devices, "pqp-share-audio")?.deviceId).toBe("bus");
    expect(pickShareAudioInput(devices, null)).toBeNull();
  });

  it("is opened exactly, with every voice stage off", () => {
    expect(shareAudioInputConstraints("bus")).toEqual({
      deviceId: { exact: "bus" },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    });
  });
});

describe("attachLinuxShellShareAudio", () => {
  function fakeTrack() {
    const listeners: Array<() => void> = [];
    return {
      stop: vi.fn(),
      addEventListener: (_type: "ended", listener: () => void) => {
        listeners.push(listener);
      },
      end: () => listeners.forEach((l) => l()),
    };
  }

  function fakeStream(audio: ReturnType<typeof fakeTrack>[] = []) {
    const video = fakeTrack();
    const tracks = [...audio];
    return {
      video,
      getAudioTracks: () => tracks,
      getVideoTracks: () => [video],
      addTrack: (t: ReturnType<typeof fakeTrack>) => {
        tracks.push(t);
      },
    };
  }

  function attachDeps(overrides: Partial<AttachDeps> = {}, track = fakeTrack()) {
    const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track] }));
    return {
      track,
      getUserMedia,
      deps: {
        claim: async () => ({ active: true, label: "pqp-share-audio" }),
        enumerate: async () => [
          { kind: "audioinput", label: "pqp-share-audio", deviceId: "bus" },
        ],
        getUserMedia,
        ...overrides,
      } as AttachDeps,
    };
  }

  it("puts the bus on the share, and stops it with the picture", async () => {
    const stream = fakeStream();
    const { deps: d, track, getUserMedia } = attachDeps();
    expect(await attachLinuxShellShareAudio(stream, d)).toBe("attached");
    expect(stream.getAudioTracks()).toEqual([track]);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: shareAudioInputConstraints("bus"),
      video: false,
    });
    stream.video.end();
    expect(track.stop).toHaveBeenCalled();
  });

  it("leaves a stream that already has sound alone", async () => {
    const stream = fakeStream([fakeTrack()]);
    const { deps: d, getUserMedia } = attachDeps();
    expect(await attachLinuxShellShareAudio(stream, d)).toBe("skipped");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("goes out silent, never failed, when anything is missing", async () => {
    for (const overrides of [
      { claim: async () => ({ active: false, label: null }) },
      { claim: () => undefined },
      { enumerate: async () => [] },
      {
        getUserMedia: async () => {
          throw new Error("NotReadableError");
        },
      },
    ] as Partial<AttachDeps>[]) {
      const stream = fakeStream();
      expect(await attachLinuxShellShareAudio(stream, attachDeps(overrides).deps)).toBe(
        "unavailable",
      );
      expect(stream.getAudioTracks()).toEqual([]);
    }
  });
});

describe("attachLinuxShellShareAudio deadline", () => {
  it("goes out silent when the device open hangs, and stops a track that lands late", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      let land: (media: { getAudioTracks(): { stop(): void }[] }) => void = () => {};
      const stream = {
        getAudioTracks: () => [] as { stop(): void }[],
        getVideoTracks: () => [] as { stop(): void }[],
        addTrack: vi.fn(),
      };
      const pending = attachLinuxShellShareAudio(
        stream,
        {
          claim: async () => ({ active: true, label: "pqp-share-audio" }),
          enumerate: async () => [
            { kind: "audioinput", label: "pqp-share-audio", deviceId: "bus" },
          ],
          getUserMedia: () => new Promise((resolve) => (land = resolve)),
        },
        1000,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe("unavailable");
      land({ getAudioTracks: () => [{ stop }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalled();
      expect(stream.addTrack).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("armLinuxShellShareAudio", () => {
  it("is true when the shell says it armed", async () => {
    expect(await armLinuxShellShareAudio(async () => true)).toBe(true);
  });

  it("is false for an older shell, a refusal or a throw, and never throws", async () => {
    expect(await armLinuxShellShareAudio(() => undefined)).toBe(false);
    expect(await armLinuxShellShareAudio(async () => false)).toBe(false);
    expect(
      await armLinuxShellShareAudio(async () => {
        throw new Error("ipc closed");
      }),
    ).toBe(false);
  });
});
