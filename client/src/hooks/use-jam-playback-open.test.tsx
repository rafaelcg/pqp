// @vitest-environment jsdom
import type { JamTrack } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamEngine } from "@/lib/jam";

/**
 * THE RULE: opening a song never starts sound. Sound starts only on that song's own play press, and a
 * play is counted only when a person started it (launch screenshots, problem 1: after a first listen the
 * browser's audio context was running, so every later open that carried a "start it" wish played at once).
 *
 * The hook is run with the audio context ALREADY RUNNING, which is the state after a first listen and the
 * one that used to make the difference. The engine is a fake that records `play`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stems = new Map<string, string>();
const engine = {
  context: { state: "running", resume: vi.fn(async () => undefined) },
  player: {
    state: "stopped",
    stems: () => [...stems.keys()].map((id) => ({ id })),
    stem: (id: string) => (stems.has(id) ? { id } : null),
    removeStem: (id: string) => stems.delete(id),
    updateStem: vi.fn(),
    loadStem: vi.fn(async (id: string, url: string) => {
      stems.set(id, url);
    }),
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

import { type JamPlayback, useJamPlayback } from "./use-jam-playback";

const track = (id: string): JamTrack =>
  ({
    id,
    authorId: "someone",
    inMix: true,
    instrument: "guitar",
    audioUrl: `https://media.test/${id}.flac?s=1`,
    offsetMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    gain: 1,
  }) as unknown as JamTrack;

let root: Root | null = null;
let host: HTMLElement | null = null;
let playback: JamPlayback | null = null;
const onPersonPlay = vi.fn();

function Probe({ songId, autoplay, tracks }: { songId: string; autoplay?: boolean; tracks: readonly JamTrack[] }) {
  playback = useJamPlayback(songId, tracks, { autoplay, onPersonPlay });
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function render(props: { songId: string; autoplay?: boolean; tracks: readonly JamTrack[] }) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<Probe {...props} />);
  });
  await settle();
}

beforeEach(() => {
  stems.clear();
  vi.mocked(engine.player.play).mockClear();
  vi.mocked(engine.player.pause).mockClear();
  onPersonPlay.mockClear();
  (engine.player as { state: string }).state = "stopped";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  playback = null;
});

describe("opening a song", () => {
  it("never plays it, even with the audio context already running", async () => {
    await render({ songId: "song-b", tracks: [track("b1")] });
    expect(engine.context.state).toBe("running");
    expect(engine.player.play).not.toHaveBeenCalled();
    expect(onPersonPlay).not.toHaveBeenCalled();
  });

  it("plays only on a press, and says a person started it", async () => {
    await render({ songId: "song-b", tracks: [track("b1")] });
    await act(async () => playback!.toggle());
    expect(engine.player.play).toHaveBeenCalledTimes(1);
    expect(onPersonPlay).toHaveBeenCalledTimes(1);
  });

  it("a press that PAUSES is not a start", async () => {
    await render({ songId: "song-b", tracks: [track("b1")] });
    (engine.player as { state: string }).state = "playing";
    await act(async () => playback!.toggle());
    expect(engine.player.pause).toHaveBeenCalledTimes(1);
    expect(engine.player.play).not.toHaveBeenCalled();
    expect(onPersonPlay).not.toHaveBeenCalled();
  });

  it("the round play button's wish (`autoplay`) plays the song it was made for once the stems are in", async () => {
    await render({ songId: "song-a", autoplay: true, tracks: [track("a1")] });
    expect(engine.player.play).toHaveBeenCalledTimes(1);
  });

  it("a wish made for one song is never inherited by the next one opened on the same hook", async () => {
    await render({ songId: "song-a", autoplay: true, tracks: [track("a1")] });
    vi.mocked(engine.player.play).mockClear();
    await render({ songId: "song-b", autoplay: true, tracks: [track("b1")] });
    expect(engine.player.play).not.toHaveBeenCalled();
  });
});
