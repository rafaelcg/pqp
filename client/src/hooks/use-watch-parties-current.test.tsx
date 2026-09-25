// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WatchParty } from "@pqp/shared";
import type { WatchPartiesState } from "./use-watch-parties";

vi.mock("@/lib/watch-parties-api", () => ({
  fetchServerWatchParties: async () => ({ parties: [] }),
}));
vi.mock("@/lib/watch-party-channels", () => ({
  isWatchPartyChannelsEnabled: () => true,
}));

const { useWatchParties } = await import("./use-watch-parties");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SERVER = "33333333-3333-4333-8333-333333333333";
const DRAFT: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: SERVER,
  name: "Rehearsal C",
  description: null,
  state: "draft",
  startsAt: null,
  wentLiveAt: null,
  endedAt: null,
  hostUserId: "44444444-4444-4444-8444-444444444444",
  hostDisplayName: "Ensaio",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    voiceEnabled: false,
    guests: "off",
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
    lowLatency: true,
  },
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
  guests: { onAir: [], invited: [], requests: [], requestCount: 0, requested: false, position: null },
};

describe("useWatchParties().current", () => {
  /**
   * Production rehearsal C, 2026-09-25: every go-live logged "[watch-party]
   * go-live mic handoff skipped: party no longer live" with the party live.
   * The handler `put` the live party and then awaited the join and the share;
   * when it came back it read `byChannel` through the closure it started in,
   * which is the render from before its own `put`, and found the draft.
   */
  it("answers with the latest party to a closure captured before the change", async () => {
    let state: WatchPartiesState | null = null;
    function Probe() {
      state = useWatchParties(SERVER);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(<Probe />);
    });
    act(() => state!.put(DRAFT));

    // The go-live handler's view of the world, taken at the click.
    const atClick = state!;
    expect(atClick.byChannel[DRAFT.channelId]?.state).toBe("draft");

    act(() => atClick.put({ ...DRAFT, state: "live", wentLiveAt: "2026-09-25T05:55:14.000Z" }));

    // The snapshot the old code read is still the draft ...
    expect(atClick.byChannel[DRAFT.channelId]?.state).toBe("draft");
    // ... and the accessor, called through that same stale object, is not.
    expect(atClick.current(DRAFT.channelId)?.state).toBe("live");

    act(() => root.unmount());
  });
});
