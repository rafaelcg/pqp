// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissWatchNow,
  resetWatchNowDismissedForTests,
  type WatchNowStream,
} from "@/lib/watch-now";
import { useWatchNow, type UseWatchNowArgs } from "./use-watch-now";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const VOICE = "voice-1";

function args(overrides: Partial<UseWatchNowArgs> = {}): UseWatchNowArgs {
  return {
    enabled: true,
    viewerId: "me",
    scope: {
      kind: "server",
      channels: [{ id: VOICE, name: "filminho", type: "voice" }],
    },
    occupancy: {
      [VOICE]: [
        { userId: "alberto", displayName: "Alberto", sharingScreen: true },
        { userId: "bia", displayName: "Bia", sharingScreen: false },
      ],
    },
    parties: {},
    channelLive: {},
    blocked: new Set(),
    canConnect: () => true,
    seatedChannelId: null,
    connected: true,
    openChannelId: null,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
let latest: WatchNowStream[] = [];

function Probe({ value }: { value: UseWatchNowArgs }) {
  latest = useWatchNow(value);
  return null;
}

function render(value: UseWatchNowArgs) {
  act(() => root.render(<Probe value={value} />));
  return latest;
}

beforeEach(() => {
  resetWatchNowDismissedForTests();
  window.sessionStorage.clear();
  host = document.createElement("div");
  root = createRoot(host);
  latest = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useWatchNow", () => {
  it("answers nothing while the flag is off, and the stream once it is on", () => {
    expect(render(args({ enabled: false }))).toEqual([]);
    const streams = render(args());
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      channelId: VOICE,
      sharerName: "Alberto",
      watching: 1,
    });
  });

  it("keeps the same array while nothing it shows has changed", () => {
    const first = render(args());
    const second = render(args());
    expect(second).toBe(first);
    const third = render(
      args({
        occupancy: {
          [VOICE]: [
            { userId: "alberto", displayName: "Alberto", sharingScreen: true },
            { userId: "bia", displayName: "Bia", sharingScreen: false },
            { userId: "carlos", displayName: "Carlos", sharingScreen: false },
          ],
        },
      }),
    );
    expect(third).not.toBe(first);
    expect(third[0]!.watching).toBe(2);
  });

  it("hides a dismissed stream and brings the next one back once this one has ended", () => {
    const [stream] = render(args());
    act(() => dismissWatchNow(stream!.key));
    expect(render(args())).toEqual([]);

    // The share ends under this tab's eyes: the dismissal is forgotten...
    expect(render(args({ occupancy: { [VOICE]: [] } }))).toEqual([]);
    // ...so the next share in that room is a new stream and shows.
    expect(render(args())).toHaveLength(1);
  });

  it("does not forget a dismissal on a roster that has not arrived yet", () => {
    const [stream] = render(args());
    act(() => dismissWatchNow(stream!.key));
    // A reload: the tab has seen nothing live yet and the occupancy is empty.
    act(() => root.unmount());
    root = createRoot(host);
    resetWatchNowDismissedForTests();
    expect(render(args({ occupancy: {}, connected: true }))).toEqual([]);
    // The roster arrives with the same stream: still dismissed.
    expect(render(args())).toEqual([]);
  });

  it("a strip that is turned off forgets nothing and, turned on again, dates nothing it did not see begin", () => {
    const [stream] = render(args());
    act(() => dismissWatchNow(stream!.key));
    // Off while the share is still live: that is not the share ending.
    expect(render(args({ enabled: false }))).toEqual([]);
    expect(render(args())).toEqual([]);
  });

  it("dates nothing that was already running when the strip came on, however long the tab has been open", () => {
    vi.useFakeTimers();
    try {
      render(args({ enabled: false }));
      act(() => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      // Long past any grace measured from page load: the strip comes on over a
      // share that has been going for who knows how long.
      expect(render(args())[0]!.startedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks again when the rosters settle, so a dismissal from before a reload does not hide the next stream", () => {
    vi.useFakeTimers();
    try {
      const [stream] = render(args());
      act(() => dismissWatchNow(stream!.key));
      act(() => root.unmount());
      root = createRoot(host);
      resetWatchNowDismissedForTests();
      // Reloaded into a room nobody is sharing in: nothing changes for 20 s.
      expect(render(args({ occupancy: {} }))).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(21_000);
      });
      // The old stream is over for good; the same person sharing again is new.
      expect(render(args())).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect starts a fresh clock that already knows what is live, so the next roster change cannot make a running share look new", () => {
    vi.useFakeTimers();
    try {
      // Offline (or not yet connected) with a share already in the rosters.
      render(args({ connected: false }));
      render(args({ connected: true }));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      // A later roster change, long after the new clock's grace window.
      const next = render(
        args({
          occupancy: {
            [VOICE]: [
              { userId: "alberto", displayName: "Alberto", sharingScreen: true },
              { userId: "bia", displayName: "Bia", sharingScreen: false },
              { userId: "carlos", displayName: "Carlos", sharingScreen: false },
            ],
          },
        }),
      );
      expect(next[0]!.startedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an emptied roster across a disconnect is not the stream ending, so the dismissal survives the reconnect", () => {
    const [stream] = render(args());
    act(() => dismissWatchNow(stream!.key));
    // Seen live, then the socket drops and the rosters are cleared...
    expect(render(args({ connected: false, occupancy: {} }))).toEqual([]);
    // ...and the same stream is there again when it comes back.
    expect(render(args({ connected: true }))).toEqual([]);
  });

  it("dates only a share it saw begin", () => {
    // Already running when the clock started: no age.
    const [running] = render(args());
    expect(running!.startedAt).toBeNull();
  });
});
