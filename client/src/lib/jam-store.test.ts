import { beforeEach, describe, expect, it, vi } from "vitest";
import { song } from "./jam-test-fixtures";

vi.mock("@/lib/jam-api", () => ({
  fetchJamSongs: vi.fn(),
  fetchJamSong: vi.fn(),
}));

import { fetchJamSong, fetchJamSongs } from "@/lib/jam-api";
import { dispatchJamFrame } from "./jam-frames";
import {
  applyJamWrite,
  loadJamChannel,
  loadJamDetail,
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
