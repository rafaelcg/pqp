import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAC_AUDIO_DEAD_WINDOW_MS,
  armMacShellShareAudio,
  ensureMacShellShareAudio,
  macShellShareAudioReady,
  resetMacShellShareAudioForTests,
  settleMacShareAudio,
  shellCanOfferMacShareAudio,
  watchMacShareAudioTrack,
  type MacEnsureDeps,
} from "./mac-shell-share-audio";
import {
  canExcludeCallFromSystemAudio,
  liveScreenCaptureEnvironment,
  needsShareAudioPrompt,
  offersShellSystemAudio,
  screenCaptureOptions,
  shellCarriesScreenAudio,
} from "./screen-capture-audio";

/** What the macOS shell publishes (electron/preload.js). */
function macShell(overrides: Record<string, unknown> = {}) {
  return {
    isElectron: true,
    platform: "darwin",
    sharePickerOffersAudio: false,
    capabilities: {
      displayMedia: true,
      systemAudio: "none",
      restrictOwnAudio: true,
      pickerOffersAudio: false,
      macShareAudio: true,
      version: "0.2.10",
    },
    macShareAudioStatus: async () => ({ supported: true, version: "15.1" }),
    macShareAudioArm: async () => true,
    macShareAudioOpenSettings: async () => true,
    ...overrides,
  };
}

function setShell(shell: unknown): void {
  (globalThis as { window?: unknown }).window =
    shell === undefined ? {} : { pqpDesktop: shell };
}

function deps(flag: boolean | "throws"): MacEnsureDeps & { fetches: number; statuses: number } {
  const d = {
    fetches: 0,
    statuses: 0,
    shellCan: shellCanOfferMacShareAudio,
    fetchConfig: async () => {
      d.fetches += 1;
      if (flag === "throws") {
        throw new Error("offline");
      }
      return { macDesktopSystemAudio: flag };
    },
    status: () => {
      d.statuses += 1;
      return (
        globalThis as {
          window?: {
            pqpDesktop?: {
              macShareAudioStatus?: () => Promise<{ supported: boolean }>;
            };
          };
        }
      ).window?.pqpDesktop?.macShareAudioStatus?.();
    },
  };
  return d;
}

/** A track whose `ended` can be fired by hand. */
function fakeTrack(readyState: "live" | "ended") {
  const handlers = new Set<() => void>();
  return {
    readyState,
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener(_type: "ended", listener: () => void) {
      handlers.add(listener);
    },
    removeEventListener(_type: "ended", listener: () => void) {
      handlers.delete(listener);
    },
    end() {
      this.readyState = "ended";
      for (const h of [...handlers]) {
        h();
      }
    },
    listeners: () => handlers.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
  resetMacShellShareAudioForTests();
});

describe("ensureMacShellShareAudio", () => {
  it("offers nothing outside the macOS shell, and asks nobody", async () => {
    for (const platform of ["win32", "linux"]) {
      setShell(macShell({ platform }));
      const d = deps(true);
      expect(await ensureMacShellShareAudio(d)).toBe(false);
      expect(d.fetches).toBe(0);
    }
  });

  it("offers nothing from a shell that predates it, flag or not", async () => {
    const shell = macShell();
    delete (shell.capabilities as { macShareAudio?: boolean }).macShareAudio;
    setShell(shell);
    expect(await ensureMacShellShareAudio(deps(true))).toBe(false);
  });

  it("stays off while the runtime flag is off: today's Mac share, video only", async () => {
    setShell(macShell());
    const d = deps(false);
    expect(await ensureMacShellShareAudio(d)).toBe(false);
    expect(d.statuses).toBe(0);
    const env = liveScreenCaptureEnvironment();
    expect(env.shellMacShareAudio).toBe(false);
    expect(offersShellSystemAudio(env)).toBe(false);
    // The request stays audio-free, which is what every Mac shell sent. An
    // audio request a Mac shell cannot answer fails the whole capture.
    expect(screenCaptureOptions(true, env).audio).toBe(false);
  });

  it("stays off on a Mac older than 14.2 even with the flag on", async () => {
    setShell(macShell({ macShareAudioStatus: async () => ({ supported: false, version: "13.6" }) }));
    expect(await ensureMacShellShareAudio(deps(true))).toBe(false);
    expect(macShellShareAudioReady()).toBe(false);
    const env = liveScreenCaptureEnvironment();
    expect(env.shellMacShareAudio).toBe(false);
    expect(screenCaptureOptions(true, env).audio).toBe(false);
  });

  it("treats an offline flag read and a throwing status as no", async () => {
    setShell(macShell());
    expect(await ensureMacShellShareAudio(deps("throws"))).toBe(false);
    setShell(
      macShell({
        macShareAudioStatus: async () => {
          throw new Error("ipc");
        },
      }),
    );
    expect(await ensureMacShellShareAudio(deps(true))).toBe(false);
  });

  it("is ready with the shell, the flag and a new enough Mac", async () => {
    setShell(macShell());
    expect(await ensureMacShellShareAudio(deps(true))).toBe(true);
    expect(macShellShareAudioReady()).toBe(true);
  });

  it("reads the flag again every time: it is the kill switch", async () => {
    setShell(macShell());
    expect(await ensureMacShellShareAudio(deps(true))).toBe(true);
    expect(await ensureMacShellShareAudio(deps(false))).toBe(false);
    expect(macShellShareAudioReady()).toBe(false);
  });
});

describe("a ready Mac shell in the capture environment", () => {
  async function ready() {
    // Chromium 152 in the shell knows `restrictOwnAudio`; jsdom does not.
    vi.stubGlobal("navigator", {
      mediaDevices: { getSupportedConstraints: () => ({ restrictOwnAudio: true }) },
    });
    setShell(macShell());
    await ensureMacShellShareAudio(deps(true));
    return liveScreenCaptureEnvironment();
  }

  it("carries sound, and says the picker is where it is asked", async () => {
    const env = await ready();
    expect(env.shellMacShareAudio).toBe(true);
    expect(env.sharePickerOffersAudio).toBe(true);
    expect(shellCarriesScreenAudio(env)).toBe(true);
    expect(offersShellSystemAudio(env)).toBe(true);
    // No page prompt: the picker's switch is the consent.
    expect(needsShareAudioPrompt(env)).toBe(false);
  });

  it("asks for audio with restrictOwnAudio, which is what keeps the call out", async () => {
    const env = await ready();
    const options = screenCaptureOptions(true, env);
    expect(options.audio).not.toBe(false);
    expect((options.audio as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBe(
      env.supportsRestrictOwnAudio ? true : undefined,
    );
    expect(options.systemAudio).toBe("include");
  });

  it("only trusts the exclusion when the engine knows the constraint", async () => {
    const env = await ready();
    expect(canExcludeCallFromSystemAudio({ ...env, supportsRestrictOwnAudio: false })).toBe(false);
    expect(canExcludeCallFromSystemAudio({ ...env, supportsRestrictOwnAudio: true })).toBe(true);
    // A shell that says it cannot strip its own playback wins.
    expect(
      canExcludeCallFromSystemAudio({
        ...env,
        supportsRestrictOwnAudio: true,
        shellRestrictOwnAudio: false,
      }),
    ).toBe(false);
  });

  it("changes nothing for the Windows and Linux shells", async () => {
    setShell(macShell({ platform: "win32" }));
    await ensureMacShellShareAudio(deps(true));
    expect(liveScreenCaptureEnvironment().shellMacShareAudio).toBe(false);
  });
});

describe("armMacShellShareAudio", () => {
  it("is true when the shell armed, false for a refusal or a throw", async () => {
    expect(await armMacShellShareAudio(async () => true)).toBe(true);
    expect(await armMacShellShareAudio(async () => false)).toBe(false);
    expect(await armMacShellShareAudio(() => undefined)).toBe(false);
    expect(
      await armMacShellShareAudio(async () => {
        throw new Error("ipc");
      }),
    ).toBe(false);
  });
});

describe("watchMacShareAudioTrack", () => {
  it("reports a track that is already ended, at once", () => {
    const dead = vi.fn();
    watchMacShareAudioTrack(fakeTrack("ended"), dead);
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it("reports an ended that lands inside the window, once", () => {
    const track = fakeTrack("live");
    const dead = vi.fn();
    watchMacShareAudioTrack(track, dead);
    expect(dead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAC_AUDIO_DEAD_WINDOW_MS - 100);
    track.end();
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it("leaves a track that ends after the window alone: that is a stopped share", () => {
    const track = fakeTrack("live");
    const dead = vi.fn();
    watchMacShareAudioTrack(track, dead);
    vi.advanceTimersByTime(MAC_AUDIO_DEAD_WINDOW_MS + 1);
    expect(track.listeners()).toBe(0);
    track.end();
    expect(dead).not.toHaveBeenCalled();
  });

  it("does nothing for no track, and a disposer stops the watching", () => {
    const dead = vi.fn();
    watchMacShareAudioTrack(undefined, dead)();
    const track = fakeTrack("live");
    const dispose = watchMacShareAudioTrack(track, dead);
    dispose();
    track.end();
    expect(dead).not.toHaveBeenCalled();
  });
});

describe("settleMacShareAudio", () => {
  function streamOf(tracks: ReturnType<typeof fakeTrack>[]) {
    const list = [...tracks];
    return {
      getAudioTracks: () => list as readonly (typeof tracks)[number][],
      removeTrack: (track: unknown) => {
        const at = list.indexOf(track as (typeof tracks)[number]);
        if (at >= 0) {
          list.splice(at, 1);
        }
      },
      list,
    };
  }

  it("takes a dead track off the stream before it can be published, and says so", () => {
    const dead = fakeTrack("ended");
    const stream = streamOf([dead]);
    const onDead = vi.fn();
    settleMacShareAudio(stream, onDead);
    expect(stream.list).toHaveLength(0);
    expect(dead.stopped).toBe(true);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("keeps a live track, and says so only if it dies inside the window", () => {
    const live = fakeTrack("live");
    const stream = streamOf([live]);
    const onDead = vi.fn();
    settleMacShareAudio(stream, onDead);
    expect(stream.list).toHaveLength(1);
    expect(onDead).not.toHaveBeenCalled();
    live.end();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("is silent for a share with no sound track at all", () => {
    const onDead = vi.fn();
    settleMacShareAudio(streamOf([]), onDead);
    expect(onDead).not.toHaveBeenCalled();
  });
});
