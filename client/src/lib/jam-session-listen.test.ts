import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JamAudioSource } from "@pqp/shared";
import { syncJamStems } from "./jam-session";
import { listenCopiesDisabled, resetListenCopyForTests } from "./jam-listen-copy";
import type { JamEngine } from "@/lib/jam";

/**
 * The listening copy as `syncJamStems` uses it: chosen only when LISTENING,
 * never blocking a stem, falling back to the original per stem, and replaced by
 * the original the moment something that is not listening (the studio) asks.
 */

type Loader = (url: string) => void | Promise<void>;

function fakeEngine(loader: Loader = () => undefined) {
  const stems = new Map<string, string>();
  const loadStem = vi.fn(async (id: string, url: string) => {
    await loader(url);
    stems.set(id, url);
  });
  const engine = {
    player: {
      stems: () => [...stems.keys()].map((id) => ({ id })),
      stem: (id: string) => (stems.has(id) ? { id } : null),
      removeStem: (id: string) => stems.delete(id),
      updateStem: vi.fn(),
      loadStem,
    },
  } as unknown as JamEngine;
  return { engine, loadStem, stems };
}

const sources = (id: string): JamAudioSource[] => [
  { url: `https://media.test/${id}.listen.ogg?s=1`, contentType: "audio/ogg", codec: "opus", bytes: 100 },
  { url: `https://media.test/${id}.flac?s=1`, contentType: "audio/flac", bytes: 700 },
];

const track = (id: string, withCopy = true) => ({
  id,
  inMix: true,
  audioUrl: `https://media.test/${id}.flac?s=1`,
  audioSources: withCopy ? sources(id) : undefined,
  offsetMs: 0,
  trimStartMs: 0,
  trimEndMs: 0,
  gain: 1,
});

const urls = (loadStem: { mock: { calls: unknown[][] } }) => loadStem.mock.calls.map((call) => String(call[1]));

beforeEach(() => resetListenCopyForTests(true));

describe("syncJamStems and the Opus listening copy", () => {
  it("loads the original, exactly as before, when it is not asked to listen, whatever the track offers", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a"), track("b")]);
    expect(urls(loadStem).sort()).toEqual(["https://media.test/a.flac?s=1", "https://media.test/b.flac?s=1"]);
  });

  it("loads the copy when listening, and only the copy: one fetch per stem", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a"), track("b")], undefined, undefined, { listen: true });
    expect(urls(loadStem).sort()).toEqual([
      "https://media.test/a.listen.ogg?s=1",
      "https://media.test/b.listen.ogg?s=1",
    ]);
  });

  it("loads the original for a track with no copy, beside one that has it", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a"), track("b", false)], undefined, undefined, { listen: true });
    expect(urls(loadStem).sort()).toEqual(["https://media.test/a.listen.ogg?s=1", "https://media.test/b.flac?s=1"]);
  });

  it("falls back to the original for a stem whose copy 404s, and does not stop trying copies for the others", async () => {
    const { engine, loadStem, stems } = fakeEngine((url) => {
      if (url.includes("a.listen")) throw new Error("jam: fetch 404");
    });
    const status: Record<string, string> = {};
    await syncJamStems(engine, [track("a"), track("b")], (id, next) => (status[id] = next), undefined, {
      listen: true,
    });
    expect(stems.get("a")).toBe("https://media.test/a.flac?s=1");
    expect(stems.get("b")).toBe("https://media.test/b.listen.ogg?s=1");
    expect(status).toEqual({ a: "ready", b: "ready" });
    expect(listenCopiesDisabled()).toBe(false);
    expect(loadStem).toHaveBeenCalledTimes(3);
  });

  it("falls back when the copy will not decode, and the next stems skip the copy altogether", async () => {
    const { engine, stems } = fakeEngine((url) => {
      if (url.includes(".listen.")) throw Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" });
    });
    // One stem at a time so the order is the order: the first pays, the rest do not.
    await syncJamStems(engine, [track("a")], undefined, undefined, { listen: true });
    expect(stems.get("a")).toBe("https://media.test/a.flac?s=1");
    expect(listenCopiesDisabled()).toBe(true);
    const next = fakeEngine();
    await syncJamStems(next.engine, [track("b")], undefined, undefined, { listen: true });
    expect(urls(next.loadStem)).toEqual(["https://media.test/b.flac?s=1"]);
  });

  it("a stem whose original fails too is an error, as it always was", async () => {
    const { engine } = fakeEngine(() => {
      throw new Error("jam: fetch 403");
    });
    const status: Record<string, string> = {};
    await syncJamStems(engine, [track("a")], (id, next) => (status[id] = next), undefined, { listen: true });
    expect(status.a).toBe("error");
  });

  it("the studio opening over a song being heard from copies replaces them with the originals; listening again keeps them", async () => {
    const { engine, loadStem, stems } = fakeEngine();
    await syncJamStems(engine, [track("a")], undefined, undefined, { listen: true });
    expect(stems.get("a")).toContain(".listen.");
    // A listening sync again: nothing is loaded twice.
    await syncJamStems(engine, [track("a")], undefined, undefined, { listen: true });
    expect(loadStem).toHaveBeenCalledTimes(1);
    // The studio (no `listen`): the backing is the original.
    await syncJamStems(engine, [track("a")]);
    expect(stems.get("a")).toBe("https://media.test/a.flac?s=1");
    expect(loadStem).toHaveBeenCalledTimes(2);
    // And a listening sync after that does not go back to the lossy copy: the original is better and already here.
    await syncJamStems(engine, [track("a")], undefined, undefined, { listen: true });
    expect(loadStem).toHaveBeenCalledTimes(2);
    expect(stems.get("a")).toBe("https://media.test/a.flac?s=1");
  });

  it("loads the original for the tracks named in `originals` while listening, and the copy for the rest", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("mine"), track("theirs")], undefined, undefined, {
      listen: true,
      originals: new Set(["mine"]),
    });
    expect(urls(loadStem).sort()).toEqual([
      "https://media.test/mine.flac?s=1",
      "https://media.test/theirs.listen.ogg?s=1",
    ]);
  });

  it("a stem heard from its copy is replaced by the original when a later listening sync names it in `originals`", async () => {
    const { engine, loadStem, stems } = fakeEngine();
    await syncJamStems(engine, [track("mine"), track("theirs")], undefined, undefined, { listen: true });
    expect(stems.get("mine")).toContain(".listen.");
    await syncJamStems(engine, [track("mine"), track("theirs")], undefined, undefined, {
      listen: true,
      originals: new Set(["mine"]),
    });
    expect(stems.get("mine")).toBe("https://media.test/mine.flac?s=1");
    expect(stems.get("theirs")).toContain(".listen.");
    // Only the named stem was fetched again.
    expect(loadStem).toHaveBeenCalledTimes(3);
  });

  it("`originals` without `listen` changes nothing: every stem is the original", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a"), track("b")], undefined, undefined, { originals: new Set(["a"]) });
    expect(urls(loadStem).sort()).toEqual(["https://media.test/a.flac?s=1", "https://media.test/b.flac?s=1"]);
  });

  it("a stem moved on the timeline is not decoded again, whichever file it came from", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a")], undefined, undefined, { listen: true });
    await syncJamStems(engine, [{ ...track("a"), offsetMs: 250 }], undefined, undefined, { listen: true });
    expect(loadStem).toHaveBeenCalledTimes(1);
    expect(engine.player.updateStem).toHaveBeenCalledWith("a", expect.objectContaining({ offsetMs: 250 }));
  });

  it("reports progress for the file actually being fetched, and again for the fallback", async () => {
    const seen: Array<[string, number, number | null]> = [];
    const stems = new Map<string, string>();
    const loadStem = vi.fn(
      async (id: string, url: string, _p: object, options?: { onProgress?: (l: number, t: number | null) => void }) => {
        options?.onProgress?.(10, url.includes(".listen.") ? 100 : 700);
        if (url.includes(".listen.")) throw new Error("jam: fetch 404");
        stems.set(id, url);
      },
    );
    const engine = {
      player: {
        stems: () => [...stems.keys()].map((id) => ({ id })),
        stem: (id: string) => (stems.has(id) ? { id } : null),
        removeStem: (id: string) => stems.delete(id),
        updateStem: vi.fn(),
        loadStem,
      },
    } as unknown as JamEngine;
    await syncJamStems(engine, [track("a")], undefined, (id, loaded, total) => seen.push([id, loaded, total]), {
      listen: true,
    });
    expect(seen).toEqual([
      ["a", 10, 100],
      ["a", 10, 700],
    ]);
  });
});
