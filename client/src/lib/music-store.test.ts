import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicResolved, MusicState } from "@pqp/shared";
import {
  addTrack,
  addTracks,
  getMusicSnapshot,
  moveTrackTo,
  receiveMusic,
  resetMusicStoreForTests,
  setMusicSession,
} from "./music-store";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const resolved = (videoId: string): MusicResolved => ({
  provider: "youtube",
  videoId,
  title: `Track ${videoId}`,
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: null,
});

describe("music store writes", () => {
  const sent: Array<MusicState | null> = [];
  beforeEach(() => {
    resetMusicStoreForTests();
    sent.length = 0;
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-a",
      userId: "u1",
      displayName: "Ana",
      send: (state) => {
        sent.push(state);
      },
    });
  });

  it("starts the first track and queues the rest, in one write for a list", () => {
    expect(addTrack(resolved("a"))).toBe("playing");
    const outcome = addTracks([resolved("b"), resolved("c"), resolved("d")]);
    expect(outcome).toEqual({ added: 3, dropped: 0, startedPlaying: false });
    const state = getMusicSnapshot().state!;
    expect(state.current?.videoId).toBe("a");
    expect(state.queue.map((t) => t.videoId)).toEqual(["b", "c", "d"]);
    expect(sent).toHaveLength(2);
    expect(state.rev).toBe(2);
  });

  it("moves a track to a drop index, counting the gap the drag left", () => {
    addTracks([resolved("a"), resolved("b"), resolved("c"), resolved("d")]);
    const ids = () => getMusicSnapshot().state!.queue.map((t) => t.videoId);
    const [b, c, d] = getMusicSnapshot().state!.queue;
    // Drop b after d (index 3 = past the end).
    moveTrackTo(b!.id, 3);
    expect(ids()).toEqual(["c", "d", "b"]);
    // Drop d before c (index 0).
    moveTrackTo(d!.id, 0);
    expect(ids()).toEqual(["d", "c", "b"]);
    // Dropping onto its own slot is not a write.
    const before = sent.length;
    moveTrackTo(c!.id, 1);
    moveTrackTo(c!.id, 2);
    expect(sent.length).toBe(before);
  });

  it("ignores a stale frame and adopts a newer one", () => {
    addTrack(resolved("a"));
    const mine = getMusicSnapshot().state!;
    receiveMusic(CHANNEL, { ...mine, rev: mine.rev - 1, actorId: "peer-b" });
    expect(getMusicSnapshot().state).toBe(mine);
    const newer = { ...mine, rev: mine.rev + 1, actorId: "peer-b", status: "paused" as const };
    receiveMusic(CHANNEL, newer);
    expect(getMusicSnapshot().state?.status).toBe("paused");
  });

  it("does nothing without a seat", () => {
    setMusicSession(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(addTrack(resolved("a"))).toBe("no-session");
    expect(getMusicSnapshot().state).toBeNull();
  });
});
