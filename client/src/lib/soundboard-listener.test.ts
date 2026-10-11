// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a LISTENER lives through when somebody else plays a clip: whether it
 * stops when they deafen or mute the person, how long the mark stays, the
 * name it carries after a rename, and two tabs of one account agreeing.
 */

const audio = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  sources: [] as Array<{ stop: (when?: number) => void }>,
}));
const api = vi.hoisted(() => ({
  fetchSoundboard: vi.fn(),
}));

vi.mock("@/lib/sounds", () => ({
  sharedAudioContext: () => ({
    state: "running",
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    createGain: () => ({
      gain: { value: 1, cancelScheduledValues: () => undefined },
      context: { currentTime: 0 },
      connect: () => undefined,
    }),
    createBufferSource: () => {
      const source = {
        connect: () => undefined,
        start: () => {
          audio.starts += 1;
        },
        stop: (when?: number) => {
          if (when === undefined) {
            audio.stops += 1;
          }
        },
      };
      audio.sources.push(source);
      return source;
    },
  }),
  decodeAudioBuffer: async () => ({}) as AudioBuffer,
  unlockSounds: () => undefined,
}));
vi.mock("@/lib/api", () => ({ fetchSoundboard: api.fetchSoundboard }));

const RAFA = "user-rafa";
const ANA = "user-ana";
const CUSTOM = "9d6f6a4e-3b0f-4c58-9a57-6f0c4d1c2a11";

function custom(name: string, durationMs = 1500) {
  return {
    id: CUSTOM,
    name,
    emoji: "🔔",
    contentType: "audio/mpeg" as const,
    byteSize: 1000,
    durationMs,
    volume: 1,
    url: "https://cdn.test/clip.mp3?sig=1",
  };
}

async function load() {
  vi.resetModules();
  return import("./soundboard");
}

beforeEach(() => {
  localStorage.clear();
  audio.starts = 0;
  audio.stops = 0;
  audio.sources = [];
  api.fetchSoundboard.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a clip already sounding", () => {
  it("is cut when the listener deafens, without forgetting the player's overlap", async () => {
    const lib = await load();
    await lib.playSoundboardClip("builtin:trombone", true, RAFA);
    await lib.playSoundboardClip("builtin:palmas", true, ANA);
    expect(audio.starts).toBe(2);
    lib.silenceSoundboardClips();
    expect(audio.stops).toBe(2);
  });

  it("is cut when the listener mutes the person who played it, and only theirs", async () => {
    const lib = await load();
    await lib.playSoundboardClip("builtin:trombone", true, RAFA);
    await lib.playSoundboardClip("builtin:palmas", true, ANA);
    lib.setSoundboardUserMuted(RAFA, true);
    expect(audio.stops).toBe(1);
  });

  it("takes the muted person's mark down at once", async () => {
    vi.useFakeTimers();
    const lib = await load();
    lib.showSoundboardMark({
      userId: RAFA,
      displayName: "Rafa",
      emoji: "🎺",
      soundId: "builtin:trombone",
    });
    lib.setSoundboardUserMuted(RAFA, true);
    vi.advanceTimersByTime(1);
    const seen: unknown[] = [];
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    function Probe() {
      seen.push(lib.useSoundboardMark(RAFA));
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createElement } = await import("react");
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBeNull();
    act(() => root.unmount());
  });

  it("does not start when the person is muted while it loads", async () => {
    const lib = await load();
    const pending = lib.playSoundboardClip("builtin:grilo", true, RAFA);
    lib.setSoundboardUserMuted(RAFA, true);
    await pending;
    expect(audio.starts).toBe(0);
  });
});

describe("how long a play is marked", () => {
  async function markLasts(lib: typeof import("./soundboard"), soundId: string) {
    const { createRoot } = await import("react-dom/client");
    const { act, createElement } = await import("react");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let current: unknown = null;
    function Probe() {
      current = lib.useSoundboardMark(RAFA);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    act(() =>
      lib.showSoundboardMark({
        userId: RAFA,
        displayName: "Rafa",
        emoji: "x",
        soundId,
      }),
    );
    const visibleAt = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      return current !== null;
    };
    return { visibleAt, unmount: () => act(() => root.unmount()) };
  }

  it("lasts as long as a long built-in clip", async () => {
    vi.useFakeTimers();
    const lib = await load();
    const probe = await markLasts(lib, "builtin:trombone"); // 4600 ms
    expect(await probe.visibleAt(4000)).toBe(true);
    expect(await probe.visibleAt(700)).toBe(false);
    probe.unmount();
  });

  it("lasts as long as a custom clip the catalog knows", async () => {
    vi.useFakeTimers();
    api.fetchSoundboard.mockResolvedValue({
      sounds: [custom("Sino", 5200)],
      maxSounds: 24,
    });
    const lib = await load();
    lib.setSoundboardCatalogServer("srv");
    lib.noteSoundboardCatalog("srv", [custom("Sino", 5200)]);
    const probe = await markLasts(lib, CUSTOM);
    expect(await probe.visibleAt(5000)).toBe(true);
    expect(await probe.visibleAt(400)).toBe(false);
    probe.unmount();
  });

  it("never drops below a short minimum", async () => {
    vi.useFakeTimers();
    const lib = await load();
    lib.setSoundboardCatalogServer("srv");
    lib.noteSoundboardCatalog("srv", [custom("Pip", 200)]);
    api.fetchSoundboard.mockResolvedValue({ sounds: [custom("Pip", 200)], maxSounds: 24 });
    const probe = await markLasts(lib, CUSTOM);
    expect(await probe.visibleAt(1000)).toBe(true);
    expect(await probe.visibleAt(400)).toBe(false);
    probe.unmount();
  });
});

describe("a custom clip renamed since the call began", () => {
  it("is pulled again in the background when somebody plays it", async () => {
    const lib = await load();
    lib.setSoundboardCatalogServer("srv");
    lib.noteSoundboardCatalog("srv", [custom("Old name")]);
    expect(lib.soundboardCustomName(CUSTOM)).toBe("Old name");
    api.fetchSoundboard.mockResolvedValue({
      sounds: [custom("New name")],
      maxSounds: 24,
    });
    lib.showSoundboardMark({
      userId: RAFA,
      displayName: "Rafa",
      emoji: "x",
      soundId: CUSTOM,
    });
    await vi.waitFor(() => expect(lib.soundboardCustomName(CUSTOM)).toBe("New name"));
    expect(api.fetchSoundboard).toHaveBeenCalledTimes(1);
  });

  it("does not hammer the server when plays come in a burst", async () => {
    const lib = await load();
    lib.setSoundboardCatalogServer("srv");
    api.fetchSoundboard.mockResolvedValue({ sounds: [custom("Sino")], maxSounds: 24 });
    for (let i = 0; i < 4; i += 1) {
      lib.showSoundboardMark({
        userId: `u${i}`,
        displayName: "x",
        emoji: "x",
        soundId: CUSTOM,
      });
    }
    await vi.waitFor(() => expect(lib.soundboardCustomName(CUSTOM)).toBe("Sino"));
    expect(api.fetchSoundboard).toHaveBeenCalledTimes(1);
  });

  it("tells a mounted panel about uploads, renames and deletes", async () => {
    const lib = await load();
    const { createRoot } = await import("react-dom/client");
    const { act, createElement } = await import("react");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let names: string[] = [];
    function Probe() {
      names = (lib.useSoundboardCatalog("srv")?.sounds ?? []).map((s) => s.name);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    expect(names).toEqual([]);
    api.fetchSoundboard.mockResolvedValue({ sounds: [custom("Sino")], maxSounds: 24 });
    await act(async () => {
      await lib.refreshSoundboardCatalog("srv");
    });
    expect(names).toEqual(["Sino"]);
    api.fetchSoundboard.mockResolvedValue({ sounds: [custom("Sineta")], maxSounds: 24 });
    await act(async () => {
      await lib.prefetchSoundboard("srv");
    });
    expect(names).toEqual(["Sineta"]);
    api.fetchSoundboard.mockResolvedValue({ sounds: [], maxSounds: 24 });
    await act(async () => {
      await lib.prefetchSoundboard("srv");
    });
    expect(names).toEqual([]);
    act(() => root.unmount());
  });
});

describe("two tabs of one account", () => {
  function storage(key: string | null, newValue: string | null) {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  it("follows a person muted in the other tab, and cuts their clip", async () => {
    const lib = await load();
    await lib.playSoundboardClip("builtin:trombone", true, RAFA);
    expect(lib.isSoundboardUserMuted(RAFA)).toBe(false);
    localStorage.setItem("pqp:soundboard-muted-users", JSON.stringify([RAFA]));
    storage("pqp:soundboard-muted-users", JSON.stringify([RAFA]));
    expect(lib.isSoundboardUserMuted(RAFA)).toBe(true);
    expect(audio.stops).toBe(1);
    localStorage.setItem("pqp:soundboard-muted-users", "[]");
    storage("pqp:soundboard-muted-users", "[]");
    expect(lib.isSoundboardUserMuted(RAFA)).toBe(false);
  });

  it("follows the board mute and the volume, and tells the panel", async () => {
    const lib = await load();
    const seen: Array<[boolean, number]> = [];
    const { createRoot } = await import("react-dom/client");
    const { act, createElement } = await import("react");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function Probe() {
      const [muted] = lib.useSoundboardMuted();
      const [volume] = lib.useSoundboardListenerVolume();
      seen.push([muted, volume]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    localStorage.setItem("pqp:soundboard-muted", "1");
    localStorage.setItem("pqp:soundboard-volume", "0.25");
    act(() => storage("pqp:soundboard-muted", "1"));
    act(() => storage("pqp:soundboard-volume", "0.25"));
    expect(seen.at(-1)).toEqual([true, 0.25]);
    act(() => root.unmount());
  });
});

describe("the muted list", () => {
  it("keeps the newest 500 people", async () => {
    const lib = await load();
    for (let i = 0; i < 520; i += 1) {
      lib.setSoundboardUserMuted(`u${i}`, true);
    }
    const stored = JSON.parse(localStorage.getItem("pqp:soundboard-muted-users")!) as string[];
    expect(stored).toHaveLength(500);
    expect(stored.at(-1)).toBe("u519");
    expect(lib.isSoundboardUserMuted("u0")).toBe(false);
    expect(lib.isSoundboardUserMuted("u519")).toBe(true);
  });
});
