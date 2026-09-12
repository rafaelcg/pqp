// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import {
  WatchStageOutlet,
  resolveWatchPlacement,
  shouldConfirmVoiceJoin,
  useWatchDock,
  useWatchDockHost,
  type WatchDockSession,
  type WatchPlacement,
} from "./watch-dock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SESSION: WatchDockSession = {
  channelId: "chan-watch",
  channelName: "cinema",
  serverId: "server-1",
  serverName: "QG",
  serverIconUrl: null,
  isWatchParty: true,
};

describe("resolveWatchPlacement", () => {
  const base = {
    session: SESSION,
    selectedChannelId: "chan-text",
    hasStream: true,
    watched: true,
    dismissed: false,
    inCall: false,
  };

  it("has nothing to draw without a session", () => {
    expect(resolveWatchPlacement({ ...base, session: null })).toBe("gone");
  });

  it("draws the ordinary stage while the channel is the open one", () => {
    expect(
      resolveWatchPlacement({ ...base, selectedChannelId: SESSION.channelId }),
    ).toBe("stage");
  });

  it("docks a watched stream once the viewer opens another channel", () => {
    expect(resolveWatchPlacement(base)).toBe("dock");
  });

  it("does not dock a room the viewer merely passed through", () => {
    // The stream started after they left: a floating player nobody asked for.
    expect(resolveWatchPlacement({ ...base, watched: false })).toBe("gone");
  });

  it("does not dock a channel with nothing playing", () => {
    expect(resolveWatchPlacement({ ...base, hasStream: false })).toBe("gone");
  });

  it("stays dismissed until the channel is opened again", () => {
    expect(resolveWatchPlacement({ ...base, dismissed: true })).toBe("gone");
    // Opening it wins over the dismissal: the stage is not the mini player.
    expect(
      resolveWatchPlacement({
        ...base,
        dismissed: true,
        selectedChannelId: SESSION.channelId,
      }),
    ).toBe("stage");
  });

  it("leaves the picture to the call once a seat is taken", () => {
    expect(resolveWatchPlacement({ ...base, inCall: true })).toBe("gone");
  });
});

describe("shouldConfirmVoiceJoin", () => {
  it("asks only when a stream is docked", () => {
    expect(
      shouldConfirmVoiceJoin({ dockedChannelId: null, channelId: "chan-a" }),
    ).toBe(false);
    expect(
      shouldConfirmVoiceJoin({
        dockedChannelId: SESSION.channelId,
        channelId: "chan-a",
      }),
    ).toBe(true);
  });

  it("never asks about the room being watched", () => {
    // Joining that one hands the picture back to the stage; nothing is lost.
    expect(
      shouldConfirmVoiceJoin({
        dockedChannelId: SESSION.channelId,
        channelId: SESSION.channelId,
      }),
    ).toBe(false);
  });
});

/**
 * The whole point of the dock: the SAME `<video>` in both places.
 *
 * A player that is remounted is a player that re-attaches hls.js, refetches
 * the playlist and rebuffers, which is exactly what clicking a channel used
 * to cost. This asserts node identity across the move, in both directions.
 */
describe("the docked surface is moved, not remounted", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness({ placement }: { placement: WatchPlacement }) {
    const { host, dockRef } = useWatchDockHost();
    return (
      <>
        <div data-testid="pane">
          {placement === "stage" ? (
            <WatchStageOutlet host={host} home={dockRef} />
          ) : null}
        </div>
        <div ref={dockRef} data-testid="dock" />
        {placement === "gone"
          ? null
          : createPortal(<video data-testid="film" />, host)}
      </>
    );
  }

  const film = () =>
    container.querySelector<HTMLVideoElement>('[data-testid="film"]');
  const inside = (testid: string) =>
    Boolean(film()?.closest(`[data-testid="${testid}"]`));

  it("carries one video element from the stage to the corner and back", () => {
    act(() => root.render(<Harness placement="stage" />));
    const onStage = film();
    expect(onStage).not.toBeNull();
    expect(inside("pane")).toBe(true);

    act(() => root.render(<Harness placement="dock" />));
    expect(film()).toBe(onStage);
    expect(inside("dock")).toBe(true);
    expect(inside("pane")).toBe(false);
    // And never out of the document in between: a media element that is
    // removed from one pauses itself, which is the bug this file prevents.
    expect(document.body.contains(onStage)).toBe(true);

    act(() => root.render(<Harness placement="stage" />));
    expect(film()).toBe(onStage);
    expect(inside("pane")).toBe(true);
  });

  it("takes the player away when the session is over", () => {
    act(() => root.render(<Harness placement="dock" />));
    expect(film()).not.toBeNull();
    act(() => root.render(<Harness placement="gone" />));
    expect(film()).toBeNull();
  });
});

describe("useWatchDock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useWatchDock> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function voiceState(live: boolean): VoiceState["channelLive"] {
    return live
      ? {
          [SESSION.channelId]: {
            stream: {
              hlsUrl: "https://api.test/api/voice/hls-playlist/c/1?t=tok",
              delaySeconds: 20,
            },
            watching: 3,
          } as VoiceState["channelLive"][string],
        }
      : {};
  }

  function Probe({
    selectedChannelId,
    candidate,
    live,
    inCallChannelId = null,
  }: {
    selectedChannelId: string | null;
    candidate: WatchDockSession | null;
    live: boolean;
    inCallChannelId?: string | null;
  }) {
    const dock = useWatchDock({
      selectedChannelId,
      candidate,
      channelLive: voiceState(live),
      inCallChannelId,
    });
    latest = dock;
    return <div ref={dock.dockRef} />;
  }

  const open = (live = true) =>
    act(() =>
      root.render(
        <Probe
          selectedChannelId={SESSION.channelId}
          candidate={SESSION}
          live={live}
        />,
      ),
    );
  const walkAway = (live = true, inCallChannelId: string | null = null) =>
    act(() =>
      root.render(
        <Probe
          selectedChannelId="chan-text"
          candidate={null}
          live={live}
          inCallChannelId={inCallChannelId}
        />,
      ),
    );

  it("docks a stream the viewer was watching and gives it back on return", () => {
    open();
    expect(latest?.placement).toBe("stage");
    expect(latest?.dockedChannelId).toBeNull();

    walkAway();
    expect(latest?.placement).toBe("dock");
    expect(latest?.dockedChannelId).toBe(SESSION.channelId);

    open();
    expect(latest?.placement).toBe("stage");
  });

  it("keeps X dismissed until the channel is opened again", () => {
    open();
    walkAway();
    expect(latest?.placement).toBe("dock");

    act(() => latest?.dismiss());
    expect(latest?.placement).toBe("gone");

    // Still dismissed while they read something else.
    walkAway();
    expect(latest?.placement).toBe("gone");

    // Re-opening the channel is the reset, and walking away docks again.
    open();
    expect(latest?.placement).toBe("stage");
    walkAway();
    expect(latest?.placement).toBe("dock");
  });

  it("never docks a room whose stream started after the visit", () => {
    open(false);
    expect(latest?.placement).toBe("stage");
    walkAway(true);
    expect(latest?.placement).toBe("gone");
  });

  it("does not follow somebody who took a seat in that very room", () => {
    open();
    walkAway(true, SESSION.channelId);
    expect(latest?.placement).toBe("gone");
  });

  it("does not come back on its own once the stream ends", () => {
    open();
    walkAway(true);
    expect(latest?.placement).toBe("dock");
    walkAway(false);
    expect(latest?.placement).toBe("gone");
    // The egress restarts ten minutes later; nobody asked for a player.
    walkAway(true);
    expect(latest?.placement).toBe("gone");
  });
});
