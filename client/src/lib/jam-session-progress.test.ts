import { describe, expect, it, vi } from "vitest";
import { syncJamStems } from "./jam-session";
import type { JamEngine } from "@/lib/jam";

/** A stand-in for the engine: one stem map, and a loadStem that records how it was called. */
function fakeEngine(report: (onProgress: (loaded: number, total: number | null) => void) => void = () => undefined) {
  const stems = new Map<string, object>();
  const loadStem = vi.fn(
    async (id: string, _url: string, _placement: object, options?: { onProgress?: (loaded: number, total: number | null) => void }) => {
      if (options?.onProgress) report(options.onProgress);
      stems.set(id, {});
    },
  );
  const engine = {
    player: {
      stems: () => [...stems.keys()].map((id) => ({ id })),
      stem: (id: string) => stems.get(id),
      removeStem: (id: string) => stems.delete(id),
      updateStem: vi.fn(),
      loadStem,
    },
  } as unknown as JamEngine;
  return { engine, loadStem };
}

const track = (id: string) => ({
  id,
  inMix: true,
  audioUrl: `https://media.test/${id}.flac?sig=1`,
  offsetMs: 0,
  trimStartMs: 0,
  trimEndMs: 0,
  gain: 1,
});

describe("syncJamStems download progress is opt-in", () => {
  it("loads exactly as before when nobody listens: no options reach the engine", async () => {
    const { engine, loadStem } = fakeEngine();
    await syncJamStems(engine, [track("a"), track("b")]);
    expect(loadStem).toHaveBeenCalledTimes(2);
    for (const call of loadStem.mock.calls) {
      expect(call).toHaveLength(4);
      expect(call[3]).toBeUndefined();
    }
  });

  it("hands each stem's bytes to the listener under that stem's id", async () => {
    const seen: Array<[string, number, number | null]> = [];
    const { engine } = fakeEngine((progress) => {
      progress(10, 100);
      progress(100, 100);
    });
    await syncJamStems(engine, [track("a"), track("b")], undefined, (id, loaded, total) => seen.push([id, loaded, total]));
    expect(seen).toContainEqual(["a", 10, 100]);
    expect(seen).toContainEqual(["b", 100, 100]);
    expect(seen).toHaveLength(4);
  });
});
