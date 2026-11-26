import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The take notices in the account's public-jam store: the durable list is the
 * truth, a live frame only asks again, answering the last waiting take on a song
 * empties that song's item at once, and the sender's `jam-take-decision` frame
 * rides the same door without a toast of its own.
 */

const api = vi.hoisted(() => ({
  me: vi.fn(),
  inbox: vi.fn(),
  notices: vi.fn(),
  ack: vi.fn(),
}));

vi.mock("@/lib/jam-public-nav", () => ({ openPublicJamById: vi.fn(), openPublicJam: vi.fn() }));
vi.mock("@/lib/jam-public-api", () => ({
  fetchJamPublicMe: api.me,
  fetchPublicJams: vi.fn(),
  fetchJamPublicConsents: vi.fn().mockResolvedValue({ pending: [] }),
  fetchJamPublicInbox: api.inbox,
  fetchJamTakeNotices: api.notices,
  ackJamTakeNotice: api.ack,
  answerJamConsent: vi.fn(),
}));

const store = await import("./jam-public-store");

const SONG = "11111111-1111-4111-8111-111111111111";
const take = (id: string, songId = SONG) =>
  ({ songId, songTitle: "Lua cheia", track: { id, instrument: "bass" } }) as never;
const notice = (id: string, kind: "take" | "accepted" | "refused" = "take", songId = SONG) => ({
  id,
  kind,
  songId,
  title: "Lua cheia",
  instruments: ["bass"],
  count: 1,
  createdAt: "2026-11-26T12:00:00.000Z",
  updatedAt: "2026-11-26T12:00:00.000Z",
});

beforeEach(async () => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.me.mockResolvedValue({ enabled: true, publishing: "open", uploads: true, announce: false });
  api.inbox.mockResolvedValue({ takes: [take("t1"), take("t2")] });
  api.notices.mockResolvedValue({ notices: [notice("n1")] });
  api.ack.mockResolvedValue({ ok: true });
  store.resetJamPublic();
  await store.loadJamPublicMe({ force: true });
  await store.loadJamPublicWaiting();
});

describe("the durable list", () => {
  it("is read with the rest of what is waiting, at boot", () => {
    expect(store.getJamPublicWaiting().notices.map((one) => one.id)).toEqual(["n1"]);
    expect(store.getJamPublicWaiting().inbox).toHaveLength(2);
  });

  it("a server that has no such list (404) leaves the card list empty and the rest intact", async () => {
    api.notices.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    store.resetJamPublic();
    await store.loadJamPublicMe({ force: true });
    await store.loadJamPublicWaiting();
    expect(store.getJamPublicWaiting().notices).toEqual([]);
    expect(store.getJamPublicWaiting().inbox).toHaveLength(2);
  });
});

describe("answering takes", () => {
  it("answering the LAST waiting take on a song empties its item; answering one of two keeps it", () => {
    store.dropInboxTake("t1");
    expect(store.getJamPublicWaiting().notices.map((one) => one.id)).toEqual(["n1"]);
    store.dropInboxTake("t2");
    expect(store.getJamPublicWaiting().notices).toEqual([]);
  });

  it("the sender's own items are not touched by answering takes on the same song", () => {
    api.notices.mockResolvedValue({ notices: [notice("n1"), notice("a1", "accepted")] });
    return store.loadJamPublicWaiting().then(() => {
      store.dropInboxTake("t1");
      store.dropInboxTake("t2");
      expect(store.getJamPublicWaiting().notices.map((one) => one.id)).toEqual(["a1"]);
    });
  });

  it("tapping spends the item at once and tells the server, whose failure changes nothing here", () => {
    api.ack.mockRejectedValue(new Error("offline"));
    store.ackTakeNotice("n1");
    expect(store.getJamPublicWaiting().notices).toEqual([]);
    expect(api.ack).toHaveBeenCalledWith("n1");
  });
});

describe("the live frames", () => {
  it("both frame types are recognised by the one handler", () => {
    expect(store.isJamPublicNotice({ type: "jam-public-notice" })).toBe(true);
    expect(store.isJamPublicNotice({ type: "jam-take-decision" })).toBe(true);
    expect(store.isJamPublicNotice({ type: "message-broadcast" })).toBe(false);
  });

  it("a sender's decision asks again and raises no toast", async () => {
    const heard = vi.fn();
    const off = store.subscribeJamPublicNotices(heard);
    api.notices.mockResolvedValue({ notices: [notice("n1"), notice("a1", "accepted")] });
    store.dispatchJamPublicNotice({
      type: "jam-take-decision",
      decision: "accepted",
      songId: SONG,
      title: "Lua cheia",
      instrument: "bass",
    });
    await vi.waitFor(() => expect(store.getJamPublicWaiting().notices.map((one) => one.id)).toEqual(["n1", "a1"]));
    expect(heard).not.toHaveBeenCalled();
    off();
  });
});
