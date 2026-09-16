import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicResolved, MusicState } from "@pqp/shared";
import {
  addTrack,
  addTracks,
  autoplayAdvance,
  getMusicSnapshot,
  moveTrackTo,
  onTrackEnded,
  receiveMusic,
  readdFromHistory,
  resetMusicStoreForTests,
  seekTo,
  setAutoplay,
  setSeekApply,
  setListening,
  setMusicSession,
  setOpenControls,
  setRepeat,
  shuffle,
  voteSkip,
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
  const listeningSent: boolean[] = [];
  beforeEach(() => {
    resetMusicStoreForTests();
    sent.length = 0;
    listeningSent.length = 0;
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-a",
      userId: "u1",
      displayName: "Ana",
      send: (state) => {
        sent.push(state);
      },
      sendListening: (listening) => {
        listeningSent.push(listening);
      },
    });
  });

  it("moves the local player in the same tick as a seek write", () => {
    addTrack({ ...resolved("a"), durationMs: 180_000 });
    const applied: number[] = [];
    setSeekApply((positionMs) => {
      applied.push(positionMs);
    });
    seekTo(45_000);
    expect(applied).toEqual([45_000]);
    expect(getMusicSnapshot().state?.positionMs).toBe(45_000);
  });

  it("starts the first track and queues the rest, in one write for a list", () => {
    expect(addTrack(resolved("a"))).toBe("playing");
    expect(getMusicSnapshot().open).toBe(true);
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

  it("keeps the sheet closed when a room is already playing", () => {
    expect(getMusicSnapshot().open).toBe(false);
    receiveMusic(CHANNEL, {
      current: {
        id: "t1",
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "A",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 1,
        addedByUserId: "u1",
        addedByName: "Ana",
      },
      queue: [],
      status: "playing",
      positionMs: 0,
      atMs: 1,
      rev: 1,
      actorId: "peer-b",
      openControls: false,
      repeat: "off",
      skipVotes: [],
      history: [],
    });
    expect(getMusicSnapshot().open).toBe(false);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("aaaaaaaaaaa");
  });

  it("votes to skip and advances when the room has enough votes", () => {
    addTrack(resolved("a"));
    addTrack(resolved("b"));
    voteSkip(2);
    expect(getMusicSnapshot().state?.skipVotes).toEqual(["u1"]);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("a");
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      skipVotes: ["u2"],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    voteSkip(2);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("b");
    expect(getMusicSnapshot().state?.skipVotes).toEqual([]);
  });

  it("writes repeat, openControls, and a shuffled queue", () => {
    addTracks([resolved("a"), resolved("b"), resolved("c"), resolved("d")]);
    setRepeat("all");
    expect(getMusicSnapshot().state?.repeat).toBe("all");
    setOpenControls(true);
    expect(getMusicSnapshot().state?.openControls).toBe(true);
    const before = getMusicSnapshot().state!.queue.map((t) => t.videoId);
    vi.spyOn(Math, "random").mockReturnValue(0);
    shuffle();
    const after = getMusicSnapshot().state!.queue.map((t) => t.videoId);
    expect(after).toHaveLength(before.length);
    expect(new Set(after)).toEqual(new Set(before));
    expect(after).not.toEqual(before);
  });

  it("re-adds a history row as a new track under this user", () => {
    addTrack(resolved("a"));
    const finished = getMusicSnapshot().state!.current!;
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      current: {
        ...finished,
        id: "other",
        videoId: "bbbbbbbbbbb",
        title: "Track bbbbbbbbbbb",
      },
      history: [finished],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    expect(readdFromHistory(finished.id)).toBe("queued");
    const queued = getMusicSnapshot().state!.queue.at(-1);
    expect(queued?.videoId).toBe("a");
    expect(queued?.id).not.toBe(finished.id);
    expect(queued?.addedByUserId).toBe("u1");
  });

  it("tells the session when this machine stops listening", () => {
    setListening(false);
    expect(getMusicSnapshot().listening).toBe(false);
    expect(listeningSent).toEqual([false]);
  });

  it("writes autoplay from a manager action", () => {
    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    expect(getMusicSnapshot().state?.autoplay).toBe(true);
    setAutoplay(false);
    expect(getMusicSnapshot().state?.autoplay).toBe(false);
  });

  it("autoplay-advances a pick under this user and keeps history like advance", () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), title: "Now" });
    const finished = getMusicSnapshot().state!.current!;
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      skipVotes: ["u2"],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    autoplayAdvance(finished.id, {
      ...resolved("bbbbbbbbbbb"),
      title: "Parecida",
      durationMs: 180_000,
    });
    const next = getMusicSnapshot().state!;
    expect(next.current?.videoId).toBe("bbbbbbbbbbb");
    expect(next.current?.title).toBe("Parecida");
    expect(next.current?.autoplayed).toBe(true);
    expect(next.current?.addedByUserId).toBe("u1");
    expect(next.current?.addedByName).toBe("Ana");
    expect(next.current?.id).not.toBe(finished.id);
    expect(next.queue).toEqual([]);
    expect(next.status).toBe("playing");
    expect(next.positionMs).toBe(0);
    expect(next.skipVotes).toEqual([]);
    expect(next.history[0]?.id).toBe(finished.id);
    expect(next.autoplay).toBe(true);
  });

  it("ignores autoplayAdvance for a track the room already left", () => {
    addTrack(resolved("aaaaaaaaaaa"));
    const finished = getMusicSnapshot().state!.current!;
    const before = sent.length;
    autoplayAdvance("not-this", resolved("bbbbbbbbbbb"));
    expect(sent.length).toBe(before);
    expect(getMusicSnapshot().state?.current?.id).toBe(finished.id);
  });

  it("onTrackEnded fetches a related pick when autoplay is on and this machine is the actor", async () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 90_000 });
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    const fetchRelated = vi.fn(async () => [
      { ...resolved("aaaaaaaaaaa"), durationMs: 90_000 },
      { ...resolved("bbbbbbbbbbb"), title: "Next", durationMs: 180_000 },
    ]);
    await onTrackEnded(ended.id, true, fetchRelated, async () => {
      throw new Error("actor must not wait");
    });
    expect(fetchRelated).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(getMusicSnapshot().state?.current?.videoId).toBe("bbbbbbbbbbb");
    expect(getMusicSnapshot().state?.current?.autoplayed).toBe(true);
  });

  it("onTrackEnded waits when this machine is not the actor, then continues", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    let waited = 0;
    await onTrackEnded(
      ended.id,
      false,
      async () => [{ ...resolved("bbbbbbbbbbb"), durationMs: 180_000 }],
      async (ms) => {
        waited = ms;
      },
    );
    expect(waited).toBe(1500);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("bbbbbbbbbbb");
  });

  it("onTrackEnded falls back to a normal advance when related lookup fails", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    await onTrackEnded(ended.id, true, async () => {
      throw new Error("innertube down");
    });
    expect(getMusicSnapshot().state?.current).toBeNull();
    expect(getMusicSnapshot().state?.status).toBe("paused");
    expect(getMusicSnapshot().state?.history[0]?.id).toBe(ended.id);
  });

  it("onTrackEnded advances the queued track when autoplay does not apply", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    addTrack(resolved("ccccccccccc"));
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    const fetchRelated = vi.fn(async () => []);
    await onTrackEnded(ended.id, true, fetchRelated);
    expect(fetchRelated).not.toHaveBeenCalled();
    expect(getMusicSnapshot().state?.current?.videoId).toBe("ccccccccccc");
  });

  it("onTrackEnded stops the room when autoplay finds no candidate", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    await onTrackEnded(ended.id, true, async () => [
      { ...resolved("aaaaaaaaaaa"), durationMs: 180_000 },
    ]);
    expect(getMusicSnapshot().state?.current).toBeNull();
    expect(getMusicSnapshot().state?.status).toBe("paused");
    expect(getMusicSnapshot().state?.history[0]?.id).toBe(ended.id);
  });
});
