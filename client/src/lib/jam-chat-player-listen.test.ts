import type { JamAudioSource } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JamEngine } from "@/lib/jam";
import { resetListenCopyForTests } from "./jam-listen-copy";

/**
 * A card in a conversation only LISTENS, so it plays a song read as a listener (a recipient outside the
 * song's channel) from the Opus copies the server offers, and the originals when it offers none.
 */

const stems = new Map<string, string>();
const loadStem = vi.fn(async (id: string, url: string) => {
  stems.set(id, url);
});
const play = vi.fn(async () => undefined);
const engine = {
  context: { state: "running", resume: async () => undefined },
  player: {
    state: "stopped",
    stems: () => [...stems.keys()].map((id) => ({ id })),
    stem: (id: string) => (stems.has(id) ? { id } : null),
    removeStem: (id: string) => stems.delete(id),
    updateStem: vi.fn(),
    loadStem,
    stop: vi.fn(),
    play,
    pause: vi.fn(),
  },
} as unknown as JamEngine;

let detail: { tracks: unknown[] } = { tracks: [] };

vi.mock("@/lib/jam-api", () => ({ fetchJamSong: async () => detail }));
vi.mock("@/lib/jam-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jam-session")>()),
  getJamEngine: async () => engine,
  peekJamEngine: () => engine,
  unlockJamAudio: () => undefined,
}));

import { toggleJamCardSong } from "./jam-chat-player";

const sources = (id: string): JamAudioSource[] => [
  { url: `https://media.test/${id}.listen.ogg?s=1`, contentType: "audio/ogg", codec: "opus", bytes: 100 },
  { url: `https://media.test/${id}.flac?s=1`, contentType: "audio/flac", bytes: 700 },
];
const track = (id: string, copy: boolean) => ({
  id,
  inMix: true,
  audioUrl: `https://media.test/${id}.flac?s=1`,
  audioSources: copy ? sources(id) : undefined,
  offsetMs: 0,
  trimStartMs: 0,
  trimEndMs: 0,
  gain: 1,
});

async function playCard(songId: string) {
  toggleJamCardSong(songId);
  for (let i = 0; i < 40 && play.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  stems.clear();
  loadStem.mockClear();
  play.mockClear();
  resetListenCopyForTests(true);
});

describe("a conversation card's player", () => {
  it("loads the Opus copy when the song's read offers one", async () => {
    detail = { tracks: [track("a", true), track("b", true)] };
    await playCard("card-song-1");
    expect([...stems.values()].sort()).toEqual([
      "https://media.test/a.listen.ogg?s=1",
      "https://media.test/b.listen.ogg?s=1",
    ]);
  });

  it("loads the originals when the read offers no copy (a channel member, or the flag off)", async () => {
    detail = { tracks: [track("c", false), track("d", false)] };
    await playCard("card-song-2");
    expect([...stems.values()].sort()).toEqual(["https://media.test/c.flac?s=1", "https://media.test/d.flac?s=1"]);
  });
});
