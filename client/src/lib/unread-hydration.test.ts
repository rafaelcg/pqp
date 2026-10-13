import { describe, expect, it } from "vitest";
import {
  UNREAD_HYDRATION_MAX_SERVERS,
  UNREAD_RECONNECT_MIN_GAP_MS,
  UNREAD_VISIBLE_MIN_HIDDEN_MS,
  hydrateInBatches,
  reconnectNeedsUnreadRefresh,
  serversToHydrate,
  visibleNeedsUnreadRefresh,
} from "./unread-hydration";
import { rememberActivityChannel, unreadByServer } from "./notifications";

describe("which servers are asked about", () => {
  const servers = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("skips the open server on a first load, which was read already", () => {
    expect(
      serversToHydrate(servers, { skipServerId: "a", isMuted: () => false }),
    ).toEqual(["b", "c", "d"]);
  });

  it("includes every server when nothing is skipped (a reconnect)", () => {
    expect(serversToHydrate(servers, { isMuted: () => false })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("leaves out a muted server: its icon says nothing", () => {
    expect(
      serversToHydrate(servers, { isMuted: (id) => id === "c" }),
    ).toEqual(["a", "b", "d"]);
  });

  it("stops at the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}` }));
    expect(serversToHydrate(many, { isMuted: () => false })).toHaveLength(
      UNREAD_HYDRATION_MAX_SERVERS,
    );
  });
});

describe("when a gap is long enough to ask again", () => {
  it("re-reads after a socket that was down for a while", () => {
    expect(
      reconnectNeedsUnreadRefresh(0, UNREAD_RECONNECT_MIN_GAP_MS),
    ).toBe(true);
  });

  it("does not turn a deploy's few-second drain into a query per server per tab", () => {
    expect(reconnectNeedsUnreadRefresh(0, 3_000)).toBe(false);
  });

  it("asks when it never saw the socket close", () => {
    expect(reconnectNeedsUnreadRefresh(null, 1)).toBe(true);
  });

  it("re-reads a tab that was hidden for a minute, not one that blinked", () => {
    expect(visibleNeedsUnreadRefresh(0, UNREAD_VISIBLE_MIN_HIDDEN_MS)).toBe(true);
    expect(visibleNeedsUnreadRefresh(0, 5_000)).toBe(false);
    expect(visibleNeedsUnreadRefresh(null, 999_999)).toBe(false);
  });
});

describe("hydrateInBatches", () => {
  it("asks about every id, never more than `concurrency` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    await hydrateInBatches(
      ["a", "b", "c", "d", "e"],
      async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(id);
        inFlight -= 1;
      },
      { concurrency: 2 },
    );
    expect(seen.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(2);
  });

  it("stops asking once a newer pass has started", async () => {
    let stop = false;
    const seen: string[] = [];
    await hydrateInBatches(
      ["a", "b", "c", "d"],
      async (id) => {
        seen.push(id);
        stop = true;
      },
      { concurrency: 1, shouldStop: () => stop },
    );
    expect(seen).toEqual(["a"]);
  });

  it("tries a server whose read failed one more time, and only once", async () => {
    const calls: string[] = [];
    await hydrateInBatches(
      ["a", "b"],
      async (id) => {
        calls.push(id);
        return id !== "b"; // b always fails
      },
      { concurrency: 1, retryDelayMs: 1 },
    );
    expect(calls).toEqual(["a", "b", "b"]);
  });

  it("does not retry once a newer pass has started", async () => {
    let stop = false;
    const calls: string[] = [];
    await hydrateInBatches(
      ["a"],
      async (id) => {
        calls.push(id);
        stop = true;
        return false;
      },
      { concurrency: 1, shouldStop: () => stop, retryDelayMs: 1 },
    );
    expect(calls).toEqual(["a"]);
  });

  it("is fine with nothing to do", async () => {
    await expect(hydrateInBatches([], async () => {})).resolves.toBeUndefined();
  });
});

describe("a row from a server that is not open reaches that server's icon", () => {
  it("is skipped by the rail until the channel is placed, and counted once it is", () => {
    const channelId = "11111111-1111-4111-8111-111111111111";
    const unread = { [channelId]: { count: 3, mentions: 1 } };
    // The directory only knows the open server's list, so before this module
    // places the row, the rail has nowhere to put it. This is the production
    // symptom: the server held the unread and no icon lit.
    expect(unreadByServer(unread)).toEqual({});
    rememberActivityChannel(channelId, "other-server", "server");
    expect(unreadByServer(unread)).toEqual({
      "other-server": { count: 3, mentions: 1 },
    });
  });
});
