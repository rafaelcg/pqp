import { describe, expect, it } from "vitest";
import { song, track } from "./jam-test-fixtures";
import {
  barsFromPeaks,
  competingInstruments,
  filterSongs,
  formatClock,
  jamChannelsGone,
  jamHasNews,
  latestActivity,
  orderTracks,
  planTiles,
  seededBars,
  songNeed,
  songTimeline,
  sortByActivity,
} from "./jam-wall";

describe("what a tile says a song needs", () => {
  it("is empty until a first track exists", () => {
    expect(songNeed(song({ trackCount: 0, instruments: [] }))).toEqual({ kind: "empty" });
  });

  it("is open for an open song, whatever is on it", () => {
    expect(songNeed(song({ joinMode: "open" }))).toEqual({ kind: "open" });
  });

  it("names the wanted instruments that are not on the song yet", () => {
    const need = songNeed(
      song({
        joinMode: "wanted",
        wantedInstruments: ["vocals", "bass", "guitar"],
        instruments: ["guitar"],
      }),
    );
    expect(need).toEqual({ kind: "missing", instruments: ["vocals", "bass"] });
  });

  it("is ready once everything wanted is there", () => {
    expect(
      songNeed(
        song({ joinMode: "wanted", wantedInstruments: ["vocals"], instruments: ["guitar", "vocals"] }),
      ),
    ).toEqual({ kind: "ready" });
  });

  it("is ready when the author closed it", () => {
    expect(songNeed(song({ joinMode: "closed" }))).toEqual({ kind: "ready" });
  });
});

describe("the filters", () => {
  const open = song({ id: "a", joinMode: "open" });
  const missing = song({ id: "b", joinMode: "wanted", wantedInstruments: ["vocals"] });
  const ready = song({ id: "c", joinMode: "closed" });
  const empty = song({ id: "d", trackCount: 0, instruments: [] });
  const all = [open, missing, ready, empty];

  it("keeps everything for all", () => {
    expect(filterSongs(all, "all").map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps what somebody could still add to for missing", () => {
    expect(filterSongs(all, "missing").map((s) => s.id)).toEqual(["a", "b", "d"]);
  });

  it("keeps the finished ones for ready", () => {
    expect(filterSongs(all, "ready").map((s) => s.id)).toEqual(["c"]);
  });
});

describe("ordering and tile sizes", () => {
  it("puts the most recently touched first and is stable on a tie", () => {
    const sorted = sortByActivity([
      song({ id: "b", updatedAt: "2026-11-09T10:00:00.000Z" }),
      song({ id: "c", updatedAt: "2026-11-09T12:00:00.000Z" }),
      song({ id: "a", updatedAt: "2026-11-09T10:00:00.000Z" }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("makes the first song the hero, then a fixed rhythm of small, wide and tall", () => {
    const songs = Array.from({ length: 10 }, (_, i) => song({ id: `s${i}` }));
    expect(planTiles(songs).map((t) => t.size)).toEqual([
      "hero",
      "small",
      "small",
      "wide",
      "small",
      "tall",
      "small",
      "small",
      "small",
      "wide",
    ]);
  });

  it("sizes follow the position and nothing else", () => {
    const a = planTiles([song({ id: "x", trackCount: 9 }), song({ id: "y", trackCount: 0 })]);
    const b = planTiles([song({ id: "x", trackCount: 0 }), song({ id: "y", trackCount: 9 })]);
    expect(a.map((t) => t.size)).toEqual(b.map((t) => t.size));
  });

  it("plans nothing for an empty wall", () => {
    expect(planTiles([])).toEqual([]);
  });
});

describe("waveform bars", () => {
  it("scales the loudest bar to the top", () => {
    const bars = barsFromPeaks([0.1, 0.2, 0.4, 0.2], 4);
    expect(Math.max(...bars)).toBe(1);
    expect(bars[0]).toBeCloseTo(0.25);
  });

  it("takes the loudest peak in each slice", () => {
    expect(barsFromPeaks([0.1, 0.9, 0.2, 0.3], 2)).toEqual([1, 0.3 / 0.9]);
  });

  it("is silent bars for no peaks and for silence", () => {
    expect(barsFromPeaks([], 3)).toEqual([0, 0, 0]);
    expect(barsFromPeaks([0, 0], 2)).toEqual([0, 0]);
  });

  it("makes the same stand-in bars for the same seed, never flat", () => {
    const a = seededBars("song-1", 24);
    expect(seededBars("song-1", 24)).toEqual(a);
    expect(seededBars("song-2", 24)).not.toEqual(a);
    expect(Math.min(...a)).toBeGreaterThan(0.1);
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });
});

describe("small helpers", () => {
  it("formats a length as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(134_000)).toBe("2:14");
    expect(formatClock(59_600)).toBe("1:00");
  });

  it("says there is news when anything moved after the last look", () => {
    const songs = [song({ updatedAt: "2026-11-09T10:00:00.000Z" })];
    expect(jamHasNews(songs, null)).toBe(true);
    expect(jamHasNews(songs, "2026-11-09T09:00:00.000Z")).toBe(true);
    expect(jamHasNews(songs, "2026-11-09T10:00:00.000Z")).toBe(false);
    expect(jamHasNews([], null)).toBe(false);
  });

  it("finds the latest activity", () => {
    expect(latestActivity([])).toBeNull();
    expect(
      latestActivity([
        song({ updatedAt: "2026-11-09T10:00:00.000Z" }),
        song({ updatedAt: "2026-11-09T11:00:00.000Z" }),
      ]),
    ).toBe("2026-11-09T11:00:00.000Z");
  });
});

describe("the lanes of an open song", () => {
  const guitar = track({ id: "g", instrument: "guitar", createdAt: "2026-11-09T10:00:00.000Z" });
  const voice = track({ id: "v", instrument: "vocals", createdAt: "2026-11-09T11:00:00.000Z" });
  const voiceTake2 = track({ id: "v2", instrument: "vocals", inMix: false, voteCount: 3, createdAt: "2026-11-09T12:00:00.000Z" });
  const voiceTake3 = track({ id: "v3", instrument: "vocals", inMix: false, voteCount: 1, createdAt: "2026-11-09T09:00:00.000Z" });

  it("groups by instrument, the in-mix take first, then by votes", () => {
    const ordered = orderTracks([voiceTake3, guitar, voiceTake2, voice]);
    expect(ordered.map((t) => t.id)).toEqual(["v", "v2", "v3", "g"]);
  });

  it("finds the instruments with more than one take", () => {
    expect([...competingInstruments([guitar, voice, voiceTake2])]).toEqual(["vocals"]);
    expect(competingInstruments([guitar, voice]).size).toBe(0);
  });

  it("ends the timeline at the last in-mix track, ignoring the ones out of the mix", () => {
    const early = track({ offsetMs: 0, durationMs: 30000, trimEndMs: 5000 });
    const late = track({ offsetMs: 10000, durationMs: 40000, trimEndMs: 0 });
    const out = track({ offsetMs: 0, durationMs: 999999, inMix: false });
    expect(songTimeline([early, late, out])).toEqual({ startMs: 0, endMs: 50000 });
    expect(songTimeline([])).toEqual({ startMs: 0, endMs: 1000 });
  });
});

describe("jam channels that left their server's list", () => {
  const ch = (id: string, serverId: string | null, type = "jam") => ({ id, type, serverId });

  it("names a jam channel that was listed and is not now", () => {
    const first = jamChannelsGone(new Map(), [ch("j1", "s1"), ch("j2", "s1"), ch("t1", "s1", "text")]);
    expect(first.gone).toEqual([]);
    const second = jamChannelsGone(first.next, [ch("j1", "s1"), ch("t1", "s1", "text")]);
    expect(second.gone).toEqual(["j2"]);
  });

  it("judges only a server whose list is present: another server's list is not 'everything vanished'", () => {
    const first = jamChannelsGone(new Map(), [ch("j1", "s1")]);
    const other = jamChannelsGone(first.next, [ch("x1", "s2")]);
    expect(other.gone).toEqual([]);
    expect(jamChannelsGone(other.next, [ch("j1", "s1")]).gone).toEqual([]);
  });

  it("an empty list says nothing", () => {
    const first = jamChannelsGone(new Map(), [ch("j1", "s1")]);
    expect(jamChannelsGone(first.next, []).gone).toEqual([]);
  });
});
