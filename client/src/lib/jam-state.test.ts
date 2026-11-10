import { describe, expect, it } from "vitest";
import {
  EMPTY_JAM_CHANNEL,
  applyJamFrame,
  mergeFirstPage,
  withDetail,
  withVote,
  type JamChannelState,
} from "./jam-state";
import { song, track } from "./jam-test-fixtures";

const channelId = "22222222-2222-4222-8222-222222222222";
const viewer = {
  isAuthor: false,
  canModerate: false,
  addableInstruments: ["bass" as const],
  votedTrackIds: [] as string[],
};

function ready(overrides: Partial<JamChannelState> = {}): JamChannelState {
  return { ...EMPTY_JAM_CHANNEL, status: "ready", ...overrides };
}

describe("jam frames", () => {
  it("puts a new song on the wall, newest activity first", () => {
    const older = song({ id: "old", updatedAt: "2026-11-09T09:00:00.000Z" });
    const next = applyJamFrame(ready({ songs: [older] }), {
      type: "jam-song-created",
      channelId,
      song: song({ id: "new", updatedAt: "2026-11-09T11:00:00.000Z" }),
    });
    expect(next.songs.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("is idempotent: the writer's own frame after its own answer changes nothing", () => {
    const created = song({ id: "x" });
    const frame = { type: "jam-song-created" as const, channelId, song: created };
    const once = applyJamFrame(ready(), frame);
    const twice = applyJamFrame(once, frame);
    expect(twice.songs).toHaveLength(1);
  });

  it("replaces a song that was updated and bumps it to the front", () => {
    const a = song({ id: "a", title: "A", updatedAt: "2026-11-09T09:00:00.000Z" });
    const b = song({ id: "b", title: "B", updatedAt: "2026-11-09T10:00:00.000Z" });
    const next = applyJamFrame(ready({ songs: [b, a] }), {
      type: "jam-song-updated",
      channelId,
      song: { ...a, title: "A2", updatedAt: "2026-11-09T12:00:00.000Z" },
    });
    expect(next.songs.map((s) => s.title)).toEqual(["A2", "B"]);
  });

  it("removes a deleted song and its detail", () => {
    const s = song({ id: "a" });
    const state = ready({
      songs: [s],
      details: { a: { tracks: [], viewer, viewerStale: false } },
    });
    const next = applyJamFrame(state, { type: "jam-song-deleted", channelId, songId: "a" });
    expect(next.songs).toEqual([]);
    expect(next.details).toEqual({});
  });

  it("adds a track to an opened song and to the summary, once", () => {
    const s = song({ id: "a", trackCount: 1 });
    const t = track({ id: "t1", songId: "a" });
    const state = ready({ songs: [s], details: { a: { tracks: [], viewer, viewerStale: false } } });
    const frame = {
      type: "jam-track-added" as const,
      channelId,
      song: { ...s, trackCount: 2, updatedAt: "2026-11-09T12:00:00.000Z" },
      track: t,
    };
    const once = applyJamFrame(state, frame);
    const twice = applyJamFrame(once, frame);
    expect(twice.songs[0]?.trackCount).toBe(2);
    expect(twice.details.a?.tracks.map((x) => x.id)).toEqual(["t1"]);
  });

  it("leaves an unopened song's detail unopened", () => {
    const s = song({ id: "a" });
    const next = applyJamFrame(ready({ songs: [s] }), {
      type: "jam-track-added",
      channelId,
      song: { ...s, trackCount: 2 },
      track: track({ songId: "a" }),
    });
    expect(next.details.a).toBeUndefined();
  });

  it("flips a track in or out of the mix", () => {
    const s = song({ id: "a" });
    const t = track({ id: "t1", songId: "a", inMix: false });
    const state = ready({ songs: [s], details: { a: { tracks: [t], viewer, viewerStale: false } } });
    const next = applyJamFrame(state, {
      type: "jam-track-updated",
      channelId,
      song: s,
      track: { ...t, inMix: true },
    });
    expect(next.details.a?.tracks[0]?.inMix).toBe(true);
  });

  it("drops a deleted track and the vote the viewer had on it", () => {
    const s = song({ id: "a" });
    const t = track({ id: "t1", songId: "a" });
    const state = ready({
      songs: [s],
      details: {
        a: { tracks: [t], viewer: { ...viewer, votedTrackIds: ["t1"] }, viewerStale: false },
      },
    });
    const next = applyJamFrame(state, { type: "jam-track-deleted", channelId, song: s, trackId: "t1" });
    expect(next.details.a?.tracks).toEqual([]);
    expect(next.details.a?.viewer.votedTrackIds).toEqual([]);
  });

  it("updates a vote count and never touches who voted", () => {
    const s = song({ id: "a" });
    const t = track({ id: "t1", songId: "a", voteCount: 1 });
    const state = ready({
      songs: [s],
      details: {
        a: { tracks: [t], viewer: { ...viewer, votedTrackIds: ["t1"] }, viewerStale: false },
      },
    });
    const next = applyJamFrame(state, {
      type: "jam-track-votes",
      channelId,
      songId: "a",
      trackId: "t1",
      voteCount: 4,
    });
    expect(next.details.a?.tracks[0]?.voteCount).toBe(4);
    expect(next.details.a?.viewer.votedTrackIds).toEqual(["t1"]);
  });

  it("marks the viewer stale when the join mode moves under an opened song", () => {
    const s = song({ id: "a", joinMode: "open" });
    const state = ready({ songs: [s], details: { a: { tracks: [], viewer, viewerStale: false } } });
    const next = applyJamFrame(state, {
      type: "jam-song-updated",
      channelId,
      song: { ...s, joinMode: "closed" },
    });
    expect(next.details.a?.viewerStale).toBe(true);
  });

  it("does not mark it stale for a track count change alone", () => {
    const s = song({ id: "a" });
    const state = ready({ songs: [s], details: { a: { tracks: [], viewer, viewerStale: false } } });
    const next = applyJamFrame(state, {
      type: "jam-song-updated",
      channelId,
      song: { ...s, trackCount: 5 },
    });
    expect(next.details.a?.viewerStale).toBe(false);
  });
});

describe("reads and local writes", () => {
  it("keeps what a detail read says, and refreshes the summary on the wall", () => {
    const s = song({ id: "a", trackCount: 1 });
    const next = withDetail(ready({ songs: [s] }), {
      song: { ...s, trackCount: 3 },
      tracks: [track({ songId: "a" })],
      viewer,
    });
    expect(next.songs[0]?.trackCount).toBe(3);
    expect(next.details.a?.tracks).toHaveLength(1);
    expect(next.details.a?.viewerStale).toBe(false);
  });

  it("applies the answer to the viewer's own vote", () => {
    const s = song({ id: "a" });
    const t = track({ id: "t1", songId: "a" });
    const state = ready({ songs: [s], details: { a: { tracks: [t], viewer, viewerStale: false } } });
    const voted = withVote(state, { songId: "a", trackId: "t1", voteCount: 1, voted: true });
    expect(voted.details.a?.viewer.votedTrackIds).toEqual(["t1"]);
    const taken = withVote(voted, { songId: "a", trackId: "t1", voteCount: 0, voted: false });
    expect(taken.details.a?.viewer.votedTrackIds).toEqual([]);
    expect(taken.details.a?.tracks[0]?.voteCount).toBe(0);
  });

  it("merges a fresh first page: replaces, adds and forgets what was deleted", () => {
    const a = song({ id: "a", updatedAt: "2026-11-09T12:00:00.000Z" });
    const deleted = song({ id: "gone", updatedAt: "2026-11-09T11:00:00.000Z" });
    const fresh = song({ id: "b", updatedAt: "2026-11-09T13:00:00.000Z" });
    const oldest = song({ id: "z", updatedAt: "2026-11-09T08:00:00.000Z" });
    const state = ready({ songs: [a, deleted, oldest] });
    const next = mergeFirstPage(state, { songs: [fresh, { ...a, title: "A!" }], nextCursor: null });
    expect(next.songs.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("keeps songs older than a page that has more behind it", () => {
    const old = song({ id: "old", updatedAt: "2026-11-01T00:00:00.000Z" });
    const page = [song({ id: "p1", updatedAt: "2026-11-09T12:00:00.000Z" })];
    const next = mergeFirstPage(ready({ songs: [old] }), { songs: page, nextCursor: "c" });
    expect(next.songs.map((s) => s.id)).toEqual(["p1", "old"]);
  });
});
