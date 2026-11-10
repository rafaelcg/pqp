import { beforeEach, describe, expect, it, vi } from "vitest";
import { song, track } from "./jam-test-fixtures";

vi.mock("@/lib/jam-api", () => ({
  fetchJamSongs: vi.fn(),
  fetchJamSong: vi.fn(),
}));

import { fetchJamSong, fetchJamSongs } from "@/lib/jam-api";
import { dispatchJamFrame } from "./jam-frames";
import {
  JAM_FRESH_MS,
  applyJamVote,
  applyJamWrite,
  dropJamChannels,
  jamStoreEpoch,
  loadJamChannel,
  loadJamDetail,
  loadMoreJamSongs,
  putJamSongOnWall,
  readJamChannel,
  resetJamStoreForTests,
  setJamViewer,
} from "./jam-store";

const channelId = "22222222-2222-4222-8222-222222222222";
const otherChannel = "33333333-3333-4333-8333-333333333333";

const list = vi.mocked(fetchJamSongs);
const one = vi.mocked(fetchJamSong);

function page(...songs: ReturnType<typeof song>[]) {
  return { songs, nextCursor: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const refusal = (status: number) => Object.assign(new Error("refused"), { status });

beforeEach(() => {
  list.mockReset();
  one.mockReset();
  resetJamStoreForTests();
  setJamViewer(null);
});

describe("what the store holds belongs to one account", () => {
  it("is empty the moment another account is set, before anything could paint it", async () => {
    setJamViewer("first");
    list.mockResolvedValueOnce(page(song({ id: "private-title" })));
    await loadJamChannel(channelId);
    expect(readJamChannel(channelId).songs).toHaveLength(1);

    setJamViewer("second");
    // synchronous: a render for the second account reads nothing of the first one's
    expect(readJamChannel(channelId).songs).toHaveLength(0);
    expect(readJamChannel(channelId).status).toBe("idle");
  });

  it("asks the server again for the second account instead of answering from what the first loaded", async () => {
    setJamViewer("first");
    list.mockResolvedValueOnce(page(song({ id: "a" })));
    await loadJamChannel(channelId);
    expect(list).toHaveBeenCalledTimes(1);

    setJamViewer("second");
    list.mockRejectedValueOnce(refusal(403));
    await loadJamChannel(channelId);
    expect(list).toHaveBeenCalledTimes(2);
    // refused: nothing is shown for it
    expect(readJamChannel(channelId).songs).toHaveLength(0);
    expect(readJamChannel(channelId).status).toBe("error");
  });

  it("drops what was held when the server stops allowing the channel, and a song it says is gone", async () => {
    list.mockResolvedValueOnce(page(song({ id: "a" })));
    await loadJamChannel(channelId);
    list.mockRejectedValueOnce(refusal(403));
    await loadJamChannel(channelId, { force: true });
    expect(readJamChannel(channelId).songs).toHaveLength(0);

    list.mockResolvedValueOnce(page(song({ id: "b" })));
    await loadJamChannel(channelId, { force: true });
    one.mockRejectedValueOnce(refusal(404));
    await loadJamDetail(channelId, "b", { force: true });
    expect(readJamChannel(channelId).songs.map((s) => s.id)).toEqual([]);
  });

  it("does not install an answer asked for by the previous account", async () => {
    setJamViewer("first");
    const slow = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(slow.promise);
    const first = loadJamChannel(channelId);

    setJamViewer("second");
    slow.resolve(page(song({ id: "from-first" })));
    await first;
    expect(readJamChannel(channelId).songs).toHaveLength(0);
  });

  it("keeps the new account's load pending when the old one finishes late (one read, not two)", async () => {
    setJamViewer("first");
    const oldRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(oldRead.promise);
    const first = loadJamChannel(channelId);

    setJamViewer("second");
    const newRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(newRead.promise);
    const second = loadJamChannel(channelId);
    expect(list).toHaveBeenCalledTimes(2);

    oldRead.resolve(page(song({ id: "from-first" })));
    await first;
    // the old read ending must not have cleared the new one's slot: asking again joins it
    const again = loadJamChannel(channelId);
    expect(list).toHaveBeenCalledTimes(2);

    newRead.resolve(page(song({ id: "mine" })));
    await Promise.all([second, again]);
    expect(readJamChannel(channelId).songs.map((s) => s.id)).toEqual(["mine"]);
  });
});

describe("a read is a snapshot, a frame is newer", () => {
  it("keeps a song that arrived over the socket while the first page was out", async () => {
    const slow = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(slow.promise);
    const reading = loadJamChannel(channelId);
    dispatchJamFrame({ type: "jam-song-created", channelId, song: song({ id: "live" }) });
    slow.resolve(page(song({ id: "old" })));
    await reading;
    expect(readJamChannel(channelId).songs.map((s) => s.id).sort()).toEqual(["live", "old"]);
  });

  it("keeps a journal only for a channel that has a read out", async () => {
    // A frame for a channel with no read in flight leaves nothing behind to merge:
    // the later read of that channel is not changed by it.
    const slow = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(slow.promise);
    const reading = loadJamChannel(channelId);

    applyJamWrite(otherChannel, { type: "jam-song-created", channelId: otherChannel, song: song({ id: "elsewhere" }) });

    list.mockResolvedValueOnce(page());
    await loadJamChannel(otherChannel, { force: true });
    // an answer that does not hold it is the authority for that channel
    expect(readJamChannel(otherChannel).songs).toHaveLength(0);

    slow.resolve(page());
    await reading;
  });
});

describe("a read of the previous identity cannot touch the new one's bookkeeping", () => {
  it("does not end the new account's journal registration: frames during its read still survive", async () => {
    setJamViewer("first");
    const oldRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(oldRead.promise);
    const first = loadJamChannel(channelId);

    setJamViewer("second");
    const newRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(newRead.promise);
    const second = loadJamChannel(channelId);

    // the old read finishes while the new one is out: it must not take the new one's registration
    oldRead.resolve(page());
    await first;
    dispatchJamFrame({ type: "jam-song-created", channelId, song: song({ id: "live-for-second" }) });

    newRead.resolve(page(song({ id: "from-page" })));
    await second;
    expect(readJamChannel(channelId).songs.map((s) => s.id).sort()).toEqual(["from-page", "live-for-second"]);
  });

  it("does not let a reset clear the registration of a read that began after it", async () => {
    setJamViewer("first");
    const oldRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(oldRead.promise);
    void loadJamChannel(channelId);
    setJamViewer("second"); // clears the registrations
    const newRead = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(newRead.promise);
    const second = loadJamChannel(channelId);
    oldRead.reject(new Error("late"));
    await Promise.resolve();
    dispatchJamFrame({ type: "jam-song-created", channelId, song: song({ id: "kept" }) });
    newRead.resolve(page());
    await second;
    expect(readJamChannel(channelId).songs.map((s) => s.id)).toEqual(["kept"]);
  });

  it("drops the answer to a write made under the previous identity", () => {
    setJamViewer("first");
    const asked = jamStoreEpoch();
    setJamViewer("second");
    putJamSongOnWall(channelId, song({ id: "from-first" }), asked);
    expect(readJamChannel(channelId).songs).toHaveLength(0);
  });

  it("drops a second page asked for by the previous identity", async () => {
    setJamViewer("first");
    list.mockResolvedValueOnce({ songs: [song({ id: "a" })], nextCursor: "more" });
    await loadJamChannel(channelId);
    const late = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(late.promise);
    const more = loadMoreJamSongs(channelId);
    setJamViewer("second");
    late.resolve(page(song({ id: "second-page-of-first" })));
    await more;
    expect(readJamChannel(channelId).songs).toHaveLength(0);
  });

  it("signing out empties the store too", async () => {
    setJamViewer("first");
    list.mockResolvedValueOnce(page(song({ id: "a" })));
    await loadJamChannel(channelId);
    setJamViewer(null);
    expect(readJamChannel(channelId).songs).toHaveLength(0);
  });
});

describe("losing access without changing account", () => {
  it("answers a quiet ask from the store only while the server's confirmation is fresh", async () => {
    vi.useFakeTimers();
    try {
      list.mockResolvedValue(page(song({ id: "a" })));
      await loadJamChannel(channelId);
      await loadJamChannel(channelId); // quiet, fresh
      expect(list).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(JAM_FRESH_MS + 1);
      list.mockRejectedValueOnce(refusal(404));
      await loadJamChannel(channelId); // quiet but stale: goes to the API, which says no
      expect(list).toHaveBeenCalledTimes(2);
      expect(readJamChannel(channelId).songs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does the same for a song's detail", async () => {
    vi.useFakeTimers();
    try {
      list.mockResolvedValue(page(song({ id: "a" })));
      await loadJamChannel(channelId);
      one.mockResolvedValue({ song: song({ id: "a" }), tracks: [], viewer: viewerOf() });
      await loadJamDetail(channelId, "a");
      await loadJamDetail(channelId, "a");
      expect(one).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(JAM_FRESH_MS + 1);
      one.mockRejectedValueOnce(refusal(403));
      await loadJamDetail(channelId, "a");
      expect(one).toHaveBeenCalledTimes(2);
      expect(readJamChannel(channelId).details["a"]).toBeUndefined();
      expect(readJamChannel(channelId).songs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a channel at once when it leaves the server's list, and a read still out cannot bring it back", async () => {
    list.mockResolvedValueOnce(page(song({ id: "a" })));
    await loadJamChannel(channelId);
    const late = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(late.promise);
    const reading = loadJamChannel(channelId, { force: true });
    dropJamChannels([channelId]);
    expect(readJamChannel(channelId).songs).toHaveLength(0);
    late.resolve(page(song({ id: "a" })));
    await reading;
    expect(readJamChannel(channelId).songs).toHaveLength(0);
  });
});

describe("a detail answer and what happened while it was out", () => {
  it("keeps a vote cast while the detail was being read", async () => {
    list.mockResolvedValueOnce(page(song({ id: "a" })));
    await loadJamChannel(channelId);
    const t1 = track({ id: "t1", songId: "a" });
    one.mockResolvedValueOnce({ song: song({ id: "a" }), tracks: [t1], viewer: viewerOf() });
    await loadJamDetail(channelId, "a");

    const slow = deferred<{ song: ReturnType<typeof song>; tracks: ReturnType<typeof track>[]; viewer: ReturnType<typeof viewerOf> }>();
    one.mockReturnValueOnce(slow.promise);
    const reading = loadJamDetail(channelId, "a", { force: true });
    applyJamVote(channelId, { songId: "a", trackId: "t1", voteCount: 1, voted: true });
    // the answer was computed before the vote
    slow.resolve({ song: song({ id: "a" }), tracks: [t1], viewer: viewerOf() });
    await reading;
    expect(readJamChannel(channelId).details["a"]?.viewer.votedTrackIds).toEqual(["t1"]);
  });

  it("stays stale when a frame moved who may add while the detail was out", async () => {
    list.mockResolvedValueOnce(page(song({ id: "a", joinMode: "open" })));
    await loadJamChannel(channelId);
    const slow = deferred<{ song: ReturnType<typeof song>; tracks: ReturnType<typeof track>[]; viewer: ReturnType<typeof viewerOf> }>();
    one.mockReturnValueOnce(slow.promise);
    const reading = loadJamDetail(channelId, "a");
    dispatchJamFrame({ type: "jam-song-updated", channelId, song: song({ id: "a", joinMode: "closed" }) });
    slow.resolve({ song: song({ id: "a", joinMode: "open" }), tracks: [], viewer: viewerOf() });
    await reading;
    expect(readJamChannel(channelId).details["a"]?.viewerStale).toBe(true);
  });
});

function viewerOf() {
  return { isAuthor: false, canModerate: false, addableInstruments: ["bass" as const], votedTrackIds: [] as string[] };
}
