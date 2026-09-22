import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicResolved, MusicState } from "@pqp/shared";
import { MUSIC_QUEUE_LIMIT } from "@pqp/shared";
import {
  addTrack,
  addTracks,
  autoplayAdvance,
  fillAutoplayBuffer,
  getMusicSnapshot,
  markCurrentEnded,
  moveTrackTo,
  musicPrevious,
  onTrackEnded,
  receiveMusic,
  readdFromHistory,
  resetMusicStoreForTests,
  seekTo,
  setAutoplay,
  setPositionProbe,
  setSeekApply,
  setListening,
  setMusicSession,
  setOpenControls,
  setRepeat,
  shuffle,
  skipToNext,
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

  /**
   * THE SERVER HAS ALREADY DECIDED, SO THE CLIENT MUST NOT DECIDE AGAIN.
   *
   * `musicWriteIsStale` is the room's conflict rule and the SERVER is where
   * it belongs: it picks which of two writes the room keeps. Applying it a
   * second time to what the server then broadcasts let a client throw the
   * room's truth away and go on playing alone, with nothing to bring it
   * back: on 22 Sep 2026 a call skipped its last track, it ended for two
   * people and the third kept hearing it.
   *
   * Our own echo is the one frame we may still refuse, because our
   * optimistic copy is a write ahead of it.
   */
  it("takes another peer's state even when ours looks newer", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    const held = getMusicSnapshot().state!;
    receiveMusic(CHANNEL, {
      ...held,
      current: null,
      queue: [],
      status: "paused",
      // Same rev, and a peer id that loses the old tie-break.
      rev: held.rev,
      actorId: "peer-a-aaa" < held.actorId ? "peer-a-aaa" : "peer-0",
    });
    expect(getMusicSnapshot().state?.current).toBeNull();
  });

  it("still refuses our own echo from behind our optimistic write", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    const held = getMusicSnapshot().state!;
    seekTo(30_000);
    receiveMusic(CHANNEL, { ...held, positionMs: 0 });
    expect(getMusicSnapshot().state?.positionMs).toBe(30_000);
  });

  it("restarts skip-back when past three seconds", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    const now = getMusicSnapshot().state!.current!;
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      history: [{ ...now, id: "old", videoId: "hhhhhhhhhhh", title: "Old" }],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    setPositionProbe(() => 5000);
    musicPrevious();
    expect(getMusicSnapshot().state?.current?.id).toBe(now.id);
    expect(getMusicSnapshot().state?.positionMs).toBe(0);
    expect(getMusicSnapshot().state?.history[0]?.videoId).toBe("hhhhhhhhhhh");
  });

  it("plays the last Tocadas row and requeues the current", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    addTrack(resolved("queuedddddd"));
    const now = getMusicSnapshot().state!.current!;
    const queued = getMusicSnapshot().state!.queue[0]!;
    const older = {
      ...now,
      id: "h1",
      videoId: "hhhhhhhhhhh",
      title: "Old",
    };
    const olderStill = {
      ...now,
      id: "h2",
      videoId: "ggggggggggg",
      title: "Older",
    };
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      skipVotes: ["u2"],
      history: [older, olderStill],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    setPositionProbe(() => 1000);
    musicPrevious();
    const state = getMusicSnapshot().state!;
    expect(state.current?.videoId).toBe("hhhhhhhhhhh");
    expect(state.current?.id).not.toBe("h1");
    expect(state.queue.map((track) => track.id)).toEqual([now.id, queued.id]);
    expect(state.history.map((track) => track.id)).toEqual(["h2"]);
    expect(state.skipVotes).toEqual([]);
    expect(state.status).toBe("playing");
    expect(state.positionMs).toBe(0);
  });

  /*
   * `startNow` gives the incoming tracks the cap first and the displaced
   * ones what is left, so a big add at the end of a track can evict most
   * of the queue. It used to report none of that.
   */
  it("counts the queued tracks a big add pushed off the end", () => {
    addTrack({ ...resolved("currenttttt"), durationMs: 180_000 });
    const filling = Array.from({ length: MUSIC_QUEUE_LIMIT }, (_, index) =>
      resolved(`old${String(index).padStart(8, "0")}`),
    );
    for (const track of filling) {
      addTrack(track);
    }
    expect(getMusicSnapshot().state?.queue.length).toBe(MUSIC_QUEUE_LIMIT);

    // The current track ends, which is what sends the next add through
    // `startNow` rather than the ordinary append.
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    const outcome = addTracks(
      Array.from({ length: 30 }, (_, index) =>
        resolved(`new${String(index).padStart(8, "0")}`),
      ),
    );
    expect(outcome.added).toBe(30);
    // The first new track plays, 29 queue behind it, and the finished
    // track goes to history rather than the queue. So the 50 tracks that
    // were queued compete for the 21 remaining slots and 29 fall off.
    expect(outcome.dropped).toBe(29);
    expect(getMusicSnapshot().state?.queue.length).toBe(MUSIC_QUEUE_LIMIT);
  });

  /*
   * The local "this track ended" mark is cleared when the room moves to a
   * different track. Under repeat-one the room moves to the SAME track, so
   * the mark used to stay set for the rest of that track's life, and the
   * next add took the end-of-track path: it pulled the looping track out
   * mid-song and pushed it into history and the front of the queue.
   */
  it("clears the ended mark when repeat-one restarts the same track", () => {
    addTrack({ ...resolved("loopinggggg"), durationMs: 180_000 });
    setRepeat("one");
    const playing = getMusicSnapshot().state!;
    const looping = playing.current!;
    markCurrentEnded(looping.id);
    // The room's echo of the repeat-one advance: same track, from the top.
    receiveMusic(CHANNEL, {
      ...playing,
      current: looping,
      positionMs: 0,
      status: "playing",
      rev: playing.rev + 1,
      actorId: "peer-b",
    });

    expect(addTrack(resolved("nexttttttttt"))).toBe("queued");
    const after = getMusicSnapshot().state!;
    expect(after.current?.id).toBe(looping.id);
    expect(after.history).toEqual([]);
    expect(after.queue.map((track) => track.videoId)).toEqual(["nexttttttttt"]);
  });

  it("restarts under repeat one, and when history is empty", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    const now = getMusicSnapshot().state!.current!;
    setRepeat("one");
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      history: [{ ...now, id: "old", videoId: "hhhhhhhhhhh", title: "Old" }],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    setPositionProbe(() => 1000);
    musicPrevious();
    expect(getMusicSnapshot().state?.current?.id).toBe(now.id);
    expect(getMusicSnapshot().state?.positionMs).toBe(0);

    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      repeat: "off",
      history: [],
      positionMs: 1000,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    setPositionProbe(() => 1000);
    musicPrevious();
    expect(getMusicSnapshot().state?.current?.id).toBe(now.id);
    expect(getMusicSnapshot().state?.positionMs).toBe(0);
  });

  it("trims the requeued current to the queue cap", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    const extras = Array.from({ length: MUSIC_QUEUE_LIMIT }, (_, index) =>
      resolved(`q${index.toString().padStart(10, "0")}`),
    );
    addTracks(extras);
    const now = getMusicSnapshot().state!.current!;
    const tail = getMusicSnapshot().state!.queue.at(-1)!;
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      history: [{ ...now, id: "old", videoId: "hhhhhhhhhhh", title: "Old" }],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    setPositionProbe(() => 500);
    musicPrevious();
    const state = getMusicSnapshot().state!;
    expect(state.queue).toHaveLength(MUSIC_QUEUE_LIMIT);
    expect(state.queue[0]?.id).toBe(now.id);
    expect(state.queue.some((track) => track.id === tail.id)).toBe(false);
  });

  /*
   * ONE TRACK CAN PUSH ONE OFF, AND SAYING NOTHING IS THE BUG.
   *
   * `addTracks` counts what a big add displaces; the single-track path
   * called the same helper and threw the number away. With repeat-one the
   * finished track goes back to the front of a queue already at the cap,
   * so the last row falls off and the person is told only "tocando agora".
   */
  it("says when starting one track pushed another off the end", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    addTracks(
      Array.from({ length: MUSIC_QUEUE_LIMIT }, (_, index) =>
        resolved(`q${index.toString().padStart(10, "0")}`),
      ),
    );
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      // Repeat-all rotates the finished track to the BACK, so a queue at
      // the cap genuinely loses its last row. Repeat-one does not: the
      // looped track is not requeued at all, so nothing is displaced.
      repeat: "all",
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    // The track has run out, so the add starts rather than queues.
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    expect(addTrack(resolved("zzzzzzzzzzz"))).toBe("playing-dropped");
    expect(getMusicSnapshot().state?.queue).toHaveLength(MUSIC_QUEUE_LIMIT);
  });

  it("still just says playing when nothing was pushed off", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    expect(addTrack(resolved("zzzzzzzzzzz"))).toBe("playing");
  });

  /*
   * SKIPPING WITH THE INFINITY ON MUST NOT END THE ROOM.
   *
   * A track running out goes through `onTrackEnded`, which asks for a
   * related pick before it gives up. The skip button went straight to
   * `advance`, which ends the room when the queue is empty whatever
   * `autoplay` says. So turning the mode on and pressing skip before the
   * buffer had filled was the one sequence that killed the queue with
   * "keep playing similar songs" switched on.
   */
  it("finds a similar track instead of ending the room", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    expect(getMusicSnapshot().state?.queue).toHaveLength(0);

    await skipToNext(async () => [resolved("similarrrrr")]);

    const state = getMusicSnapshot().state!;
    expect(state.current?.videoId).toBe("similarrrrr");
    expect(state.current?.autoplayed).toBe(true);
    expect(state.status).toBe("playing");
  });

  it("ends the room when there is nothing similar left", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    await skipToNext(async () => []);
    expect(getMusicSnapshot().state?.current).toBeNull();
  });

  it("ends the room when the lookup fails, rather than hanging on a track", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    await skipToNext(async () => {
      throw new Error("offline");
    });
    expect(getMusicSnapshot().state?.current).toBeNull();
  });

  /*
   * The lookup takes a round trip, and the room does not stand still for
   * it. Somebody turning the mode off, or queueing a track, during that
   * window means the pick is no longer what was asked for: the skip
   * should then be the ordinary one it would have been.
   */
  it("does not force a pick when the mode went off mid-lookup", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    addTracks([resolved("nextttttttt")]);
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      queue: [],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    await skipToNext(async () => {
      setAutoplay(false);
      return [resolved("similarrrrr")];
    });
    expect(getMusicSnapshot().state?.current?.videoId).not.toBe("similarrrrr");
  });

  it("does not force a pick when a track was queued mid-lookup", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    await skipToNext(async () => {
      addTracks([resolved("queuedddddd")]);
      return [resolved("similarrrrr")];
    });
    expect(getMusicSnapshot().state?.current?.videoId).toBe("queuedddddd");
  });

  it("is an ordinary skip when the queue has something in it", async () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    addTracks([resolved("nextttttttt")]);
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      autoplay: true,
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    let asked = false;
    await skipToNext(async () => {
      asked = true;
      return [resolved("similarrrrr")];
    });
    expect(asked).toBe(false);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("nextttttttt");
  });

  /*
   * A TRACK THAT LOOPED WAS NEVER DISPLACED, SO IT MUST NOT BE REQUEUED.
   *
   * `startNow` asks `musicAdvance` what would have played next and puts
   * that back at the front of the queue, which is right when it is a real
   * upcoming track. Under repeat-one, and under repeat-all with an empty
   * queue, `musicAdvance` answers with the FINISHED track looping, and it
   * has already filed that track into `history`. Requeuing it put the same
   * song in both places from one write: it then sat at the head of the
   * queue where repeat-one could never reach it, and turning repeat off
   * later replayed a song the room had just heard. One ghost per add, up
   * to the cap.
   */
  it("does not requeue the track that merely looped", () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 180_000 });
    setRepeat("one");
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    addTrack(resolved("bbbbbbbbbbb"));
    const state = getMusicSnapshot().state!;
    expect(state.current?.videoId).toBe("bbbbbbbbbbb");
    expect(state.queue).toHaveLength(0);
    expect(state.history.map((track) => track.videoId)).toEqual([
      "aaaaaaaaaaa",
    ]);
  });

  it("same for repeat-all with nothing else queued", () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 180_000 });
    setRepeat("all");
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    addTrack(resolved("bbbbbbbbbbb"));
    const state = getMusicSnapshot().state!;
    expect(state.queue).toHaveLength(0);
    expect(state.history.map((track) => track.videoId)).toEqual([
      "aaaaaaaaaaa",
    ]);
  });

  /* The ordinary case is untouched: a real next track goes back in front. */
  it("still puts a genuinely displaced track back at the front", () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 180_000 });
    addTracks([resolved("nnnnnnnnnnn")]);
    markCurrentEnded(getMusicSnapshot().state!.current!.id);
    addTrack(resolved("bbbbbbbbbbb"));
    const state = getMusicSnapshot().state!;
    expect(state.current?.videoId).toBe("bbbbbbbbbbb");
    expect(state.queue.map((track) => track.videoId)).toEqual([
      "nnnnnnnnnnn",
    ]);
  });

  it("starts the first track and queues the rest, in one write for a list", () => {
    expect(addTrack(resolved("a"))).toBe("playing");
    expect(getMusicSnapshot().open).toBe(false);
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
    // Both voters are seated, which is what the server will count.
    const seated = ["u1", "u2"];
    addTrack(resolved("a"));
    addTrack(resolved("b"));
    voteSkip(2, seated);
    expect(getMusicSnapshot().state?.skipVotes).toEqual(["u1"]);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("a");
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      skipVotes: ["u2"],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    voteSkip(2, seated);
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

  it("fills three related tracks onto the queue before the current one ends", async () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 90_000 });
    setAutoplay(true);
    const fetchRelated = vi.fn(async () => [
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
      { ...resolved("ccccccccccc"), durationMs: 180_000 },
      { ...resolved("ddddddddddd"), durationMs: 180_000 },
      { ...resolved("eeeeeeeeeee"), durationMs: 180_000 },
    ]);
    await fillAutoplayBuffer(true, fetchRelated, async () => {
      throw new Error("actor must not wait");
    });
    expect(fetchRelated).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(getMusicSnapshot().state?.queue.map((track) => track.videoId)).toEqual([
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
    ]);
    expect(getMusicSnapshot().state?.queue.every((track) => track.autoplayed)).toBe(true);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("aaaaaaaaaaa");
  });

  it("onTrackEnded with a related buffer only advances", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    await fillAutoplayBuffer(true, async () => [
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
      { ...resolved("ccccccccccc"), durationMs: 180_000 },
      { ...resolved("ddddddddddd"), durationMs: 180_000 },
    ]);
    const ended = getMusicSnapshot().state!.current!;
    const fetchRelated = vi.fn(async () => []);
    await onTrackEnded(ended.id, true, fetchRelated);
    expect(fetchRelated).not.toHaveBeenCalled();
    expect(getMusicSnapshot().state?.current?.videoId).toBe("bbbbbbbbbbb");
    expect(getMusicSnapshot().state?.queue.map((track) => track.videoId)).toEqual([
      "ccccccccccc",
      "ddddddddddd",
    ]);
  });

  it("starts a new pick when the current track has ended", () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), title: "Old" });
    setAutoplay(true);
    const ended = getMusicSnapshot().state!.current!;
    markCurrentEnded(ended.id);
    expect(addTrack({ ...resolved("bbbbbbbbbbb"), title: "New" })).toBe("playing");
    const next = getMusicSnapshot().state!;
    expect(next.current?.videoId).toBe("bbbbbbbbbbb");
    expect(next.current?.title).toBe("New");
    expect(next.status).toBe("playing");
    expect(next.positionMs).toBe(0);
    expect(next.history[0]?.id).toBe(ended.id);
  });

  it("queues a pick while the current track is still playing", () => {
    addTrack(resolved("aaaaaaaaaaa"));
    expect(addTrack(resolved("bbbbbbbbbbb"))).toBe("queued");
    expect(getMusicSnapshot().state?.current?.videoId).toBe("aaaaaaaaaaa");
    expect(getMusicSnapshot().state?.queue.map((track) => track.videoId)).toEqual(["bbbbbbbbbbb"]);
  });

  it("drops pending autoplayed rows when autoplay is turned off, and when a new pick starts after end", async () => {
    addTrack(resolved("aaaaaaaaaaa"));
    addTrack(resolved("zzzzzzzzzzz"));
    setAutoplay(true);
    await fillAutoplayBuffer(true, async () => [
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
      { ...resolved("ccccccccccc"), durationMs: 180_000 },
      { ...resolved("ddddddddddd"), durationMs: 180_000 },
    ]);
    expect(getMusicSnapshot().state?.queue.some((track) => track.autoplayed)).toBe(true);
    const ended = getMusicSnapshot().state!.current!;
    markCurrentEnded(ended.id);
    expect(addTrack(resolved("nnnnnnnnnnn"))).toBe("playing");
    const after = getMusicSnapshot().state!;
    expect(after.current?.videoId).toBe("nnnnnnnnnnn");
    expect(after.queue.every((track) => !track.autoplayed)).toBe(true);
    expect(after.queue.map((track) => track.videoId)).toEqual(["zzzzzzzzzzz"]);

    addTrack(resolved("aaaaaaaaaaa"));
    setAutoplay(true);
    await fillAutoplayBuffer(true, async () => [
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
    ]);
    setAutoplay(false);
    expect(getMusicSnapshot().state?.autoplay).toBe(false);
    expect(getMusicSnapshot().state?.queue.every((track) => !track.autoplayed)).toBe(true);
  });

  it("drops an in-flight fill when the seat moves to another room", async () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 90_000 });
    setAutoplay(true);
    let finish!: (tracks: MusicResolved[]) => void;
    const fetchRelated = vi.fn(
      () =>
        new Promise<MusicResolved[]>((resolve) => {
          finish = resolve;
        }),
    );
    const filling = fillAutoplayBuffer(true, fetchRelated);
    await vi.waitFor(() => expect(fetchRelated).toHaveBeenCalledTimes(1));
    setMusicSession({
      channelId: "22222222-2222-4222-8222-222222222222",
      peerId: "peer-b",
      userId: "u1",
      displayName: "Ana",
      send: (state) => {
        sent.push(state);
      },
    });
    addTrack({ ...resolved("zzzzzzzzzzz"), durationMs: 90_000 });
    setAutoplay(true);
    finish([
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
      { ...resolved("ccccccccccc"), durationMs: 180_000 },
      { ...resolved("ddddddddddd"), durationMs: 180_000 },
    ]);
    await filling;
    expect(getMusicSnapshot().state?.current?.videoId).toBe("zzzzzzzzzzz");
    expect(getMusicSnapshot().state?.queue).toEqual([]);
  });

  it("does not append related for a seed that is no longer last in the queue", async () => {
    addTrack({ ...resolved("aaaaaaaaaaa"), durationMs: 90_000 });
    setAutoplay(true);
    let finish!: (tracks: MusicResolved[]) => void;
    const fetchRelated = vi.fn(
      () =>
        new Promise<MusicResolved[]>((resolve) => {
          finish = resolve;
        }),
    );
    const filling = fillAutoplayBuffer(true, fetchRelated);
    await vi.waitFor(() => expect(fetchRelated).toHaveBeenCalledWith("aaaaaaaaaaa"));
    expect(addTrack(resolved("zzzzzzzzzzz"))).toBe("queued");
    finish([
      { ...resolved("bbbbbbbbbbb"), durationMs: 180_000 },
      { ...resolved("ccccccccccc"), durationMs: 180_000 },
      { ...resolved("ddddddddddd"), durationMs: 180_000 },
    ]);
    await filling;
    expect(getMusicSnapshot().state?.queue.map((track) => track.videoId)).toEqual(["zzzzzzzzzzz"]);
  });
});

describe("voting to skip, counted the way the server counts", () => {
  /*
   * THE CLIENT COUNTED GHOSTS AND THE SERVER DID NOT.
   *
   * The server was taught to count only the votes of people still seated,
   * because the threshold is half the LIVE room and a vote whose owner
   * left was carrying it. The client kept counting every held vote, so it
   * would reach the threshold first, write the advance, and have it
   * refused: the vote was never recorded, the forced frame put the old
   * state back, and pressing again did the same thing for ever.
   *
   * Six seats, threshold three. Two held votes, one of them from somebody
   * who has left. A third person voting must ADD a vote, not advance.
   */
  beforeEach(() => {
    resetMusicStoreForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "u5",
      displayName: "Eu",
      send: () => {},
    });
  });

  const seated = ["u1", "u2", "u4", "u5", "u6", "u7"];

  it("adds a vote rather than advancing when one voter has gone", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      skipVotes: ["u3", "u4"],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    const before = getMusicSnapshot().state!.current!.videoId;
    voteSkip(6, seated);
    const after = getMusicSnapshot().state!;
    expect(after.current?.videoId).toBe(before);
    expect(after.skipVotes).toContain("u5");
  });

  it("advances once the live votes really do reach the threshold", () => {
    addTrack({ ...resolved("nowwwwwwwww"), durationMs: 180_000 });
    addTracks([resolved("nextttttttt")]);
    receiveMusic(CHANNEL, {
      ...getMusicSnapshot().state!,
      skipVotes: ["u1", "u4"],
      rev: getMusicSnapshot().state!.rev + 1,
      actorId: "peer-b",
    });
    voteSkip(6, seated);
    expect(getMusicSnapshot().state?.current?.videoId).toBe("nextttttttt");
  });
});

