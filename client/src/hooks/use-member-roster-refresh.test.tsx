// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMembersMock = vi.hoisted(() => vi.fn());
const fetchStatusesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  fetchMembers: (...args: unknown[]) => fetchMembersMock(...args),
  fetchMemberStatuses: (...args: unknown[]) => fetchStatusesMock(...args),
}));

const { useMemberRosterRefresh, nudgeFloorMs } = await import(
  "./use-member-roster-refresh"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let refreshNow: () => Promise<ReadonlySet<string> | null>;
let applied: unknown[][] = [];
let appliedStatuses: unknown[] = [];
let held: {
  current: { serverId: string; token: string | null; count: number } | null;
} = { current: null };
let useLean = false;

function Probe(props: { nudge: number; size: number }) {
  refreshNow = useMemberRosterRefresh(
    "s1",
    props.nudge,
    (members) => applied.push(members),
    props.size,
    useLean
      ? { held, onStatuses: (statuses) => appliedStatuses.push(statuses) }
      : undefined,
  );
  return null;
}

let root: Root;
let host: HTMLElement;
let visibility: DocumentVisibilityState = "visible";

function render(nudge: number, size: number) {
  act(() => root.render(<Probe nudge={nudge} size={size} />));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMembersMock.mockReset().mockResolvedValue({ members: [] });
  fetchStatusesMock.mockReset();
  applied = [];
  appliedStatuses = [];
  held = { current: null };
  useLean = false;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useMemberRosterRefresh", () => {
  it("floors nudged reads at the poll cadence on a large roster", () => {
    expect(nudgeFloorMs(10)).toBe(3_000);
    expect(nudgeFloorMs(400)).toBe(15_000);
  });

  it("a presence storm on 400 members costs about the poll, not 20 reads a minute", async () => {
    render(0, 400);
    for (let i = 1; i <= 60; i++) {
      render(i, 400);
      await advance(1_000);
    }
    // 60 s of one nudge per second: floor 15 s gives a handful, not ~20.
    expect(fetchMembersMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("small rosters still refresh quickly", async () => {
    render(0, 5);
    render(1, 5);
    await advance(3_500);
    expect(fetchMembersMock).toHaveBeenCalledTimes(1);
  });

  it("does not read on a nudge while the tab is hidden", async () => {
    render(0, 5);
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    render(1, 5);
    await advance(20_000);
    expect(fetchMembersMock).not.toHaveBeenCalled();
  });

  it("refreshNow reads at once, past the nudge floor, and says who the read held", async () => {
    render(0, 5);
    fetchMembersMock.mockResolvedValueOnce({ members: [{ id: "u1" }, { id: "u2" }] });
    let held: ReadonlySet<string> | null = null;
    await act(async () => {
      held = await refreshNow();
    });
    expect(held).toEqual(new Set(["u1", "u2"]));
    expect(fetchMembersMock).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([[{ id: "u1" }, { id: "u2" }]]);

    fetchMembersMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      held = await refreshNow();
    });
    expect(held).toBeNull();
    expect(applied).toHaveLength(1);
  });

  describe("the lean poll for a big roster", () => {
    const BIG = 250;

    it("asks only for the statuses while the roster token still matches", async () => {
      useLean = true;
      held.current = { serverId: "s1", token: "tok", count: BIG };
      fetchStatusesMock.mockResolvedValue({
        roster: "tok",
        count: BIG,
        statuses: { u1: "online" },
      });
      render(0, BIG);
      await advance(15_500);
      expect(fetchStatusesMock).toHaveBeenCalledTimes(1);
      expect(fetchMembersMock).not.toHaveBeenCalled();
      expect(appliedStatuses).toEqual([{ u1: "online" }]);
      expect(applied).toHaveLength(0);
    });

    it("reads the whole list when somebody joined or left, then goes lean again", async () => {
      useLean = true;
      held.current = { serverId: "s1", token: "old", count: BIG };
      fetchStatusesMock.mockResolvedValue({
        roster: "new",
        count: BIG + 1,
        statuses: {},
      });
      fetchMembersMock.mockResolvedValue({
        roster: "new",
        members: Array.from({ length: BIG + 1 }, (_, i) => ({ id: `u${i}` })),
      });
      render(0, BIG);
      await advance(15_500);
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);
      expect(applied).toHaveLength(1);
      // The new token and count are the baseline now.
      expect(held.current).toEqual({ serverId: "s1", token: "new", count: BIG + 1 });

      await advance(15_000);
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);
      expect(fetchStatusesMock).toHaveBeenCalledTimes(2);
    });

    it("never goes lean for a small roster", async () => {
      useLean = true;
      held.current = { serverId: "s1", token: "tok", count: 50 };
      render(0, 50);
      await advance(15_500);
      expect(fetchStatusesMock).not.toHaveBeenCalled();
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);
    });

    it("reads the whole list when there is no token yet, or it is for another server", async () => {
      useLean = true;
      held.current = null;
      render(0, BIG);
      await advance(15_500);
      expect(fetchStatusesMock).not.toHaveBeenCalled();
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);

      fetchMembersMock.mockClear();
      held.current = { serverId: "other", token: "tok", count: BIG };
      await advance(15_500);
      expect(fetchStatusesMock).not.toHaveBeenCalled();
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the whole list when the lean read fails (an API without the route)", async () => {
      useLean = true;
      held.current = { serverId: "s1", token: "tok", count: BIG };
      fetchStatusesMock.mockRejectedValue(new Error("404"));
      render(0, BIG);
      await advance(15_500);
      expect(fetchStatusesMock).toHaveBeenCalledTimes(1);
      expect(fetchMembersMock).toHaveBeenCalledTimes(1);
    });

    it("refreshNow always reads the whole list: its caller needs the ids", async () => {
      useLean = true;
      held.current = { serverId: "s1", token: "tok", count: BIG };
      render(0, BIG);
      fetchMembersMock.mockResolvedValueOnce({
        roster: "tok",
        members: [{ id: "u1" }],
      });
      let ids: ReadonlySet<string> | null = null;
      await act(async () => {
        ids = await refreshNow();
      });
      expect(ids).toEqual(new Set(["u1"]));
      expect(fetchStatusesMock).not.toHaveBeenCalled();
    });
  });
});
