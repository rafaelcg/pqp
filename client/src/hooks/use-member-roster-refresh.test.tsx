// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMembersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  fetchMembers: (...args: unknown[]) => fetchMembersMock(...args),
}));

const { useMemberRosterRefresh, nudgeFloorMs } = await import(
  "./use-member-roster-refresh"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Probe(props: { nudge: number; size: number }) {
  useMemberRosterRefresh("s1", props.nudge, () => {}, props.size);
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
});
