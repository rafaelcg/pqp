// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  WatchStageOutlet,
  resolveWatchPlacement,
  shouldConfirmVoiceJoin,
  useVoiceJoinGuard,
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

// An ordinary voice room, unrelated to the party in SESSION — what
// `App.tsx`'s `watchDockCandidate` builds for whichever voice channel is
// currently selected, party or not.
const OTHER_VOICE: WatchDockSession = {
  channelId: "chan-voice-other",
  channelName: "AFK",
  serverId: "server-1",
  serverName: "QG",
  serverIconUrl: null,
  isWatchParty: false,
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

  // 2026-09-13 (watch party seat handoff): the outlet itself stays put while
  // the party's own channel is open — `selectedChannelId === session.channelId`
  // wins first, deliberately, so re-opening a dismissed channel brings the
  // picture straight back rather than needing a second click. It is
  // `WatchChannelStage`'s OWN `inThisCall` gate (`watch-stage.tsx`) that
  // stops rendering a player into this outlet once seated, not a different
  // placement here. Pinned so nobody "fixes" the ordering above and makes a
  // seated viewer's dismissed-and-reopened channel show nothing at all.
  it("keeps the stage outlet even once seated in the room being watched", () => {
    expect(
      resolveWatchPlacement({
        ...base,
        selectedChannelId: SESSION.channelId,
        inCall: true,
      }),
    ).toBe("stage");
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

/**
 * C9, `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`: "if refresh screen
 * gets extra buggy". A reload is a cold mount: `useWatchDock`'s `session`
 * starts `null` (its `useState` has no initializer from storage), and the
 * candidate only exists once the channel list has loaded, which on a real
 * boot is a render or more after the app root mounts. This wires the same
 * three pieces `App.tsx` does — `useWatchDock`, the always-mounted dock
 * anchor, and `WatchStageOutlet` — and drives that exact sequence: nothing
 * loaded, then the candidate arriving, the way a real reload's channel fetch
 * resolves after the first paint. No jsdom Playwright browser needed for
 * this half; see `e2e/watch-party.spec.ts` ("a reload with a live share
 * lands with exactly one of everything") for the same invariant against a
 * real server and a real socket.
 */
describe("a cold reload never doubles the surface", () => {
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

  const liveChannel: VoiceState["channelLive"] = {
    [SESSION.channelId]: {
      stream: {
        hlsUrl: "https://api.test/api/voice/hls-playlist/c/1?t=tok",
        delaySeconds: 20,
      },
      watching: 3,
    } as VoiceState["channelLive"][string],
  };

  /** The exact wiring `App.tsx` uses: outlet in the pane, anchor at the
   *  root, and the player portalled into whichever one the dock currently
   *  holds `host` in. */
  function Harness({
    selectedChannelId,
    candidate,
  }: {
    selectedChannelId: string | null;
    candidate: WatchDockSession | null;
  }) {
    const dock = useWatchDock({
      selectedChannelId,
      candidate,
      channelLive: liveChannel,
      inCallChannelId: null,
    });
    return (
      <>
        <div data-testid="pane">
          {dock.placement === "stage" ? (
            <WatchStageOutlet host={dock.host} home={dock.dockRef} />
          ) : null}
        </div>
        <div ref={dock.dockRef} data-testid="dock" />
        {dock.session
          ? createPortal(<video data-testid="film" />, dock.host)
          : null}
      </>
    );
  }

  const films = () => container.querySelectorAll('[data-testid="film"]');
  const inside = (testid: string) =>
    Array.from(films()).filter((node) =>
      Boolean(node.closest(`[data-testid="${testid}"]`)),
    ).length;

  it("goes from nothing loaded to one stage, never through two", () => {
    // Before the channel list has answered: no candidate yet. Nothing to
    // show, and critically nothing DOUBLE to show.
    act(() =>
      root.render(<Harness selectedChannelId={null} candidate={null} />),
    );
    expect(films().length).toBe(0);

    // The channel list resolves and the URL names this room's channel, in
    // the same render a real `selectChannel`/route-restore would produce —
    // candidate and selection arrive together.
    act(() =>
      root.render(
        <Harness
          selectedChannelId={SESSION.channelId}
          candidate={SESSION}
        />,
      ),
    );
    expect(films().length).toBe(1);
    expect(inside("pane")).toBe(1);
    expect(inside("dock")).toBe(0);

    // A second render with the same props (a re-render the rest of the app
    // causes, not a new mount) must not spawn a second player.
    act(() =>
      root.render(
        <Harness
          selectedChannelId={SESSION.channelId}
          candidate={SESSION}
        />,
      ),
    );
    expect(films().length).toBe(1);
    expect(inside("pane")).toBe(1);
  });

  it("never shows the stage and the dock at once", () => {
    act(() =>
      root.render(
        <Harness selectedChannelId={SESSION.channelId} candidate={SESSION} />,
      ),
    );
    expect(inside("pane")).toBe(1);
    expect(inside("dock")).toBe(0);

    // Walk away to another channel: the same one player moves to the dock,
    // never duplicates into both.
    act(() =>
      root.render(<Harness selectedChannelId="chan-text" candidate={null} />),
    );
    expect(films().length).toBe(1);
    expect(inside("dock")).toBe(1);
    expect(inside("pane")).toBe(0);
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
  // Clicking a VOICE channel in the sidebar, without joining it: `App.tsx`
  // still builds a candidate (it does not special-case watch parties), so
  // unlike `walkAway` this passes a non-null one for the newly selected
  // room.
  const browseVoice = (
    candidate: WatchDockSession,
    live = true,
    inCallChannelId: string | null = null,
  ) =>
    act(() =>
      root.render(
        <Probe
          selectedChannelId={candidate.channelId}
          candidate={candidate}
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

  it("stays docked when the viewer selects a different voice channel without joining it", () => {
    open();
    walkAway();
    expect(latest?.placement).toBe("dock");
    expect(latest?.dockedChannelId).toBe(SESSION.channelId);

    // Selecting (not joining) another voice channel must not steal the
    // session away from the party stream that is actually on screen.
    browseVoice(OTHER_VOICE);
    expect(latest?.placement).toBe("dock");
    expect(latest?.dockedChannelId).toBe(SESSION.channelId);

    // The party's own room still takes it back, same as any other return.
    open();
    expect(latest?.placement).toBe("stage");
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

/**
 * The confirm in front of a seat, and the promise it makes.
 *
 * Answering "yes" is answering about a TRADE: the call for the film. So the
 * film is given up only once the seat is real, and the dialog gets out of the
 * way before the join runs rather than after it, because the state behind
 * `open` is the same state the join is waiting on.
 */
describe("useVoiceJoinGuard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let guard: ReturnType<typeof useVoiceJoinGuard> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    guard = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness({
    dockedChannelId,
    join,
    seated,
    onSeated,
  }: {
    dockedChannelId: string | null;
    join: () => Promise<void>;
    seated: boolean;
    onSeated: () => void;
  }) {
    const value = useVoiceJoinGuard({
      dockedChannelId,
      seated: () => seated,
      onSeated,
    });
    guard = value;
    return (
      <>
        <button
          type="button"
          data-testid="join"
          onClick={() => value.guard("chan-voice", join)}
        />
        <ConfirmDialog
          open={value.pendingChannelId !== null}
          title="Continuar?"
          confirmLabel="Entrar na voz"
          destructive={false}
          onConfirm={value.confirm}
          onClose={value.cancel}
        />
      </>
    );
  }

  const buttonSaying = (label: string) =>
    Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    ) ?? null;
  const confirmButton = () => buttonSaying("Entrar na voz");

  const press = (testid: string) =>
    act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)
        ?.click();
    });

  it("joins straight away with nothing docked", async () => {
    const joined: string[] = [];
    const onSeated = vi.fn();
    act(() =>
      root.render(
        <Harness
          dockedChannelId={null}
          join={async () => {
            joined.push("chan-voice");
          }}
          seated
          onSeated={onSeated}
        />,
      ),
    );
    await press("join");
    expect(confirmButton()).toBeNull();
    expect(joined).toEqual(["chan-voice"]);
    // Nothing was docked, so nothing is given up either.
    expect(onSeated).not.toHaveBeenCalled();
  });

  it("closes the dialog on Continue and drops the stream once seated", async () => {
    const onSeated = vi.fn();
    let started = false;
    act(() =>
      root.render(
        <Harness
          dockedChannelId="chan-watch"
          join={async () => {
            started = true;
          }}
          seated
          onSeated={onSeated}
        />,
      ),
    );
    await press("join");
    expect(confirmButton()).not.toBeNull();
    expect(started).toBe(false);

    await act(async () => {
      confirmButton()?.click();
    });
    // THE DIALOG IS GONE, not left over a joined app with nothing behind it
    // to close the modal.
    expect(confirmButton()).toBeNull();
    expect(guard?.pendingChannelId).toBeNull();
    expect(started).toBe(true);
    expect(onSeated).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream when the join throws", async () => {
    const onSeated = vi.fn();
    act(() =>
      root.render(
        <Harness
          dockedChannelId="chan-watch"
          join={async () => {
            throw new Error("mic on fire");
          }}
          seated
          onSeated={onSeated}
        />,
      ),
    );
    await press("join");
    await act(async () => {
      confirmButton()?.click();
    });
    expect(confirmButton()).toBeNull();
    expect(onSeated).not.toHaveBeenCalled();
  });

  it("keeps the stream when the join resolves without taking the seat", async () => {
    // `voice.join` swallows a refused microphone and returns quietly when the
    // join was abandoned, so resolving is not the same as being in the room.
    const onSeated = vi.fn();
    act(() =>
      root.render(
        <Harness
          dockedChannelId="chan-watch"
          join={async () => {}}
          seated={false}
          onSeated={onSeated}
        />,
      ),
    );
    await press("join");
    await act(async () => {
      confirmButton()?.click();
    });
    expect(onSeated).not.toHaveBeenCalled();
  });

  it("joins nothing and keeps the stream on Cancel", async () => {
    const onSeated = vi.fn();
    let started = false;
    act(() =>
      root.render(
        <Harness
          dockedChannelId="chan-watch"
          join={async () => {
            started = true;
          }}
          seated
          onSeated={onSeated}
        />,
      ),
    );
    await press("join");
    await act(async () => {
      buttonSaying("Cancel")?.click();
    });
    expect(confirmButton()).toBeNull();
    expect(guard?.pendingChannelId).toBeNull();
    expect(started).toBe(false);
    expect(onSeated).not.toHaveBeenCalled();
  });
});
