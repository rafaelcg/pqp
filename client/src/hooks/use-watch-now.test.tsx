// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("dates only a share it saw begin", () => {
    // Already running when the clock started: no age.
    const [running] = render(args());
    expect(running!.startedAt).toBeNull();
  });
});
