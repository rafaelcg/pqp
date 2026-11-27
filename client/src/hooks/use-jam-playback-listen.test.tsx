// @vitest-environment jsdom
import type { JamAudioSource, JamTrack } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamEngine } from "@/lib/jam";
import { resetListenCopyForTests } from "@/lib/jam-listen-copy";

/**
 * Which file each caller of the shared Jam engine loads.
 *
 *   - the song panel (`useJamPlayback`) LISTENS: the Opus copy the server offers, per stem falling back
 *     to the FLAC, except the viewer's own parts, which they adjust and audition and so stay on the FLAC;
 *   - the studio records against the original, always;
 *   - when the person goes from listening to recording, the engine ends on originals.
 *
 * The engine is a fake that records which URL each stem was loaded from; `syncJamStems` is the real one.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stems = new Map<string, string>();
const loadStem = vi.fn(async (id: string, url: string) => {
  if (failing.has(url)) {
    throw new Error("jam: fetch 404");
  }
  stems.set(id, url);
});
const failing = new Set<string>();
const engine = {
  context: { state: "suspended", resume: async () => undefined },
  player: {
    state: "stopped",
    stems: () => [...stems.keys()].map((id) => ({ id })),
    stem: (id: string) => (stems.has(id) ? { id } : null),
    removeStem: (id: string) => stems.delete(id),
    updateStem: vi.fn(),
    loadStem,
    stop: vi.fn(),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    seek: vi.fn(),
  },
} as unknown as JamEngine;

vi.mock("@/lib/jam-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jam-session")>()),
  getJamEngine: async () => engine,
}));
vi.mock("./use-jam-clock", () => ({
  useEngineClock: () => ({ clock: { current: () => 0, subscribe: () => () => undefined }, transport: "stopped", durationMs: 0 }),
}));

import { syncJamStems } from "@/lib/jam-session";
import { useJamPlayback } from "./use-jam-playback";

const sources = (id: string): JamAudioSource[] => [
  { url: `https://media.test/${id}.listen.ogg?s=1`, contentType: "audio/ogg", codec: "opus", bytes: 100 },
  { url: `https://media.test/${id}.flac?s=1`, contentType: "audio/flac", bytes: 700 },
];

const track = (id: string, authorId: string, copy = true): JamTrack =>
  ({
    id,
    authorId,
    inMix: true,
    instrument: "guitar",
    audioUrl: `https://media.test/${id}.flac?s=1`,
    audioSources: copy ? sources(id) : undefined,
    offsetMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    gain: 1,
  }) as unknown as JamTrack;

const flac = (id: string) => `https://media.test/${id}.flac?s=1`;
const opus = (id: string) => `https://media.test/${id}.listen.ogg?s=1`;
const loaded = () => loadStem.mock.calls.map((call) => String(call[1])).sort();

let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe({ tracks, viewerId }: { tracks: readonly JamTrack[]; viewerId?: string | null }) {
  useJamPlayback("song-1", tracks, viewerId === undefined ? {} : { viewerId });
  return null;
}

async function mount(tracks: readonly JamTrack[], viewerId?: string | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Probe tracks={tracks} viewerId={viewerId} />);
  });
  // getJamEngine resolves, the effect syncs, the stems decode.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  stems.clear();
  failing.clear();
  loadStem.mockClear();
  resetListenCopyForTests(true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the song panel's playback hook", () => {
  it("listens: a track the server offers a copy of is loaded from the Opus copy, one fetch per stem", async () => {
    await mount([track("a", "someone"), track("b", "someone-else")], "visitor");
    expect(loaded()).toEqual([opus("a"), opus("b")]);
  });

  it("loads the viewer's own part from the original, beside the others from their copies", async () => {
    await mount([track("mine", "visitor"), track("a", "someone")], "visitor");
    expect(loaded()).toEqual([flac("mine"), opus("a")].sort());
  });

  it("with no viewer id (signed out of the app's identity) nothing is treated as the viewer's own", async () => {
    await mount([track("a", "x")], null);
    expect(loaded()).toEqual([opus("a")]);
  });

  it("with the flag off the server sends no `audioSources`: everything is the original, as before", async () => {
    await mount([track("a", "x", false), track("b", "y", false)], "visitor");
    expect(loaded()).toEqual([flac("a"), flac("b")]);
  });

  it("a copy that 404s falls back to that stem's original", async () => {
    failing.add(opus("a"));
    await mount([track("a", "x"), track("b", "y")], "visitor");
    expect(stems.get("a")).toBe(flac("a"));
    expect(stems.get("b")).toBe(opus("b"));
  });

  it("a browser that cannot play Opus in Ogg loads the originals with no wasted fetch", async () => {
    resetListenCopyForTests(false);
    await mount([track("a", "x")], "visitor");
    expect(loaded()).toEqual([flac("a")]);
  });
});

describe("from listening to the studio", () => {
  it("the studio's sync (no `listen`, as use-jam-studio.ts calls it) puts every stem on its original", async () => {
    const band = [track("a", "x"), track("b", "y")];
    await mount(band, "visitor");
    expect(stems.get("a")).toBe(opus("a"));
    expect(stems.get("b")).toBe(opus("b"));

    // "Gravar minha parte": the studio mounts over the panel and syncs the backing as it does.
    await syncJamStems(engine, band);
    expect(stems.get("a")).toBe(flac("a"));
    expect(stems.get("b")).toBe(flac("b"));

    // The panel is still mounted behind the studio; a track arriving makes it sync again while listening. It
    // must not take a stem back to the lossy copy, and a new stem it loads is replaced by the studio's sync.
    const arrived = [...band, track("c", "z")];
    await act(async () => {
      root!.render(<Probe tracks={arrived} viewerId="visitor" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await syncJamStems(engine, arrived);
    expect(stems.get("a")).toBe(flac("a"));
    expect(stems.get("b")).toBe(flac("b"));
    expect(stems.get("c")).toBe(flac("c"));
  });

  it("the studio's own calls never ask to listen", async () => {
    const source = (await import("./use-jam-studio.ts?raw")).default;
    const calls = [...source.matchAll(/syncJamStems\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const args of calls) {
      expect(args).not.toMatch(/listen|originals/);
    }
  });

  it("the song panel hands its viewer to the hook, so their own parts stay on the original", async () => {
    const source = (await import("@/components/jam/jam-song-panel.tsx?raw")).default;
    expect(source).toMatch(/useJamPlayback\(song\.id, tracks, \{[^}]*\bviewerId\b[^}]*\}\)/s);
  });
});
