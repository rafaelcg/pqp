import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { VoiceState } from "@/hooks/use-voice";

/**
 * ONE PLAYER, TWO PLACES.
 *
 * A seatless viewer who clicks another channel used to lose the film: the
 * watch stage is mounted by the selected channel, so navigating away unmounts
 * it, hls.js is destroyed and coming back costs a fresh attach, a fresh ladder
 * negotiation and twenty seconds of buffering. That is a real cost — see the
 * note on `shouldAdoptHlsSource` in `hls-watch-player.tsx` about what
 * re-attaching does to a live stream — and it is the reason this file exists.
 *
 * So the surface is mounted ONCE, at the root of the app, and portalled into a
 * host element that is physically MOVED between two homes:
 *
 * - the stage outlet inside the channel pane, while the watch channel is open
 * - the dock anchor at the app root, while the viewer is anywhere else
 *
 * `appendChild` re-parents a node without destroying it, and because the move
 * happens inside one synchronous task the `<video>` is back in the document
 * before the HTML spec's "removed from a Document" step gets to run its pause.
 * Same element, same hls.js instance, same buffer: the picture does not even
 * blink. `WatchStageOutlet`'s cleanup is a layout effect ON PURPOSE — React
 * runs those before it detaches the node being unmounted, which is the only
 * window in which the host can be rescued.
 */
export type WatchPlacement = "stage" | "dock" | "gone";

/**
 * What the dock has to remember about the channel being watched.
 *
 * A snapshot rather than a lookup: the viewer may have walked off into another
 * server entirely, and then `channels` no longer holds the row this came from.
 */
export interface WatchDockSession {
  channelId: string;
  channelName: string;
  serverId: string | null;
  serverName: string | null;
  serverIconUrl: string | null;
  /** A party bar owns the join in those; a plain voice room has none. */
  isWatchParty: boolean;
}

export function sameWatchSession(
  a: WatchDockSession | null,
  b: WatchDockSession | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.channelId === b.channelId &&
    a.channelName === b.channelName &&
    a.serverId === b.serverId &&
    a.serverName === b.serverName &&
    a.serverIconUrl === b.serverIconUrl &&
    a.isWatchParty === b.isWatchParty
  );
}

/**
 * Where the surface belongs, given everything that can take it away.
 *
 * `watched` is the rule that keeps this from being a pop-up: a room the person
 * merely walked through does not earn a floating player the moment somebody
 * starts a party in it. Only a stream that was playing while they had the
 * channel open follows them out of it.
 */
export function resolveWatchPlacement({
  session,
  selectedChannelId,
  hasStream,
  watched,
  dismissed,
  inCall,
}: {
  session: WatchDockSession | null;
  selectedChannelId: string | null;
  /** The channel still has a playable stream. */
  hasStream: boolean;
  /** The viewer saw this stream play with the channel open. */
  watched: boolean;
  /** They pressed the mini player's X and have not re-opened the channel. */
  dismissed: boolean;
  /** They took a seat in that room: the call surface owns the picture now. */
  inCall: boolean;
}): WatchPlacement {
  if (!session) {
    return "gone";
  }
  // The channel is open: the ordinary stage, exactly as before. Said first so
  // re-opening a dismissed channel brings the picture straight back.
  if (selectedChannelId === session.channelId) {
    return "stage";
  }
  if (!hasStream || !watched || dismissed || inCall) {
    return "gone";
  }
  return "dock";
}

/**
 * Does taking a seat here cost the viewer the stream they are watching?
 *
 * Joining a voice room is joining THAT room: the docked stream belongs to
 * another one, and a person halfway through a film should be asked before a
 * click on a channel row ends it. Joining the very room being watched is not
 * that case (the stage takes over the picture), and neither is joining with
 * nothing docked.
 */
export function shouldConfirmVoiceJoin({
  dockedChannelId,
  channelId,
}: {
  dockedChannelId: string | null;
  channelId: string;
}): boolean {
  return dockedChannelId !== null && dockedChannelId !== channelId;
}

/**
 * Take the seat the viewer agreed to, and give the stream up ONLY once the
 * seat is real.
 *
 * Dismissing the mini player on the press was a lie the width of a failed
 * join: a refused room, a join that timed out, a leave that raced it, and the
 * person has answered "yes, end my film" and got neither the call nor the
 * film. `seated` is asked after the join settles, because `voice.join` is
 * deliberately forgiving (a microphone that will not open joins listen-only
 * rather than throwing) and an abandoned join returns quietly: the only honest
 * question is whether the controller is actually in the room that was asked
 * for.
 */
export async function runGuardedVoiceJoin({
  run,
  seated,
  onSeated,
}: {
  run: () => Promise<void> | void;
  /** Is the controller in the room this join asked for? */
  seated: () => boolean;
  /** Called once, and only when the seat happened. */
  onSeated: () => void;
}): Promise<boolean> {
  try {
    await run();
  } catch {
    // They keep the film they were already watching.
    return false;
  }
  if (!seated()) {
    return false;
  }
  onSeated();
  return true;
}

/**
 * The confirm in front of a join that would cost a docked stream.
 *
 * Holds the parked join, and answers the dialog's `open`. `confirm` clears
 * itself FIRST and runs the join after: the dialog is controlled by this
 * state, so leaving it set while a join is in flight leaves a modal over the
 * app with nothing behind it to close the modal.
 */
export function useVoiceJoinGuard({
  dockedChannelId,
  seated,
  onSeated,
}: {
  dockedChannelId: string | null;
  seated: (channelId: string) => boolean;
  onSeated: () => void;
}): {
  /** The room a confirm is open about, or null when there is none. */
  pendingChannelId: string | null;
  guard: (channelId: string, run: () => Promise<void> | void) => void;
  confirm: () => void;
  cancel: () => void;
} {
  const [pending, setPending] = useState<{
    channelId: string;
    run: () => Promise<void> | void;
  } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const seatedRef = useRef(seated);
  seatedRef.current = seated;
  const onSeatedRef = useRef(onSeated);
  onSeatedRef.current = onSeated;
  const dockedRef = useRef(dockedChannelId);
  dockedRef.current = dockedChannelId;

  const guard = useCallback(
    (channelId: string, run: () => Promise<void> | void) => {
      if (
        shouldConfirmVoiceJoin({
          dockedChannelId: dockedRef.current,
          channelId,
        })
      ) {
        setPending({ channelId, run });
        return;
      }
      void run();
    },
    [],
  );

  const confirm = useCallback(() => {
    const parked = pendingRef.current;
    if (!parked) {
      return;
    }
    setPending(null);
    void runGuardedVoiceJoin({
      run: parked.run,
      seated: () => seatedRef.current(parked.channelId),
      onSeated: () => onSeatedRef.current(),
    });
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  return { pendingChannelId: pending?.channelId ?? null, guard, confirm, cancel };
}

/** Bottom-right, clear of the composer, and never wider than a phone. */
export const WATCH_DOCK_BOX =
  "fixed bottom-20 right-3 z-40 w-[15rem] max-w-[calc(100vw-1.5rem)] sm:bottom-24 sm:right-4 sm:w-[20rem] " +
  "aspect-video overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-paper/20";

/**
 * The element the surface lives in, and the anchor it falls back to.
 *
 * The host is created once and never re-created: it is the thing whose
 * identity keeps the `<video>` alive across a move. The layout effect with no
 * dependency array is a cheap "is it homeless?" check that runs after every
 * render, which is what puts it back in the dock the first time and after any
 * outlet that was holding it goes away without saying so.
 */
export function useWatchDockHost(): {
  host: HTMLElement;
  dockRef: RefObject<HTMLDivElement | null>;
} {
  const [host] = useState<HTMLElement>(() => {
    const el = document.createElement("div");
    // Transparent to layout: whichever box it lands in owns the sizing.
    el.style.display = "contents";
    el.setAttribute("data-watch-dock-host", "");
    return el;
  });
  const dockRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!host.parentNode && dockRef.current) {
      dockRef.current.appendChild(host);
    }
  });
  useEffect(() => {
    return () => {
      host.remove();
    };
  }, [host]);
  return { host, dockRef };
}

/**
 * The place in the channel pane the surface is teleported into.
 *
 * `display: contents` so the pane sees exactly the box it saw before this
 * existed: no extra flex item, no extra height, nothing to measure.
 */
export function WatchStageOutlet({
  host,
  home,
}: {
  host: HTMLElement;
  /** Where the host goes when this outlet is unmounted. */
  home: RefObject<HTMLElement | null>;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) {
      return;
    }
    slot.appendChild(host);
    return () => {
      // Before React detaches this slot, not after: a media element that is
      // out of the document at the next stable state pauses itself, and the
      // whole point of the dock is that it does not.
      //
      // Reading `home.current` AT CLEANUP is the point, not an oversight: the
      // dock anchor this rescues into is whichever one is mounted now, and a
      // copy taken when the effect ran could be a node that has since gone.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      home.current?.appendChild(host);
    };
  }, [host, home]);
  return (
    <div
      ref={slotRef}
      data-testid="watch-stage-outlet"
      style={{ display: "contents" }}
    />
  );
}

/**
 * The watch session that survives navigation, and where to draw it.
 *
 * Latches on any voice room the viewer opens (a stream is not required for
 * that: the stage itself is what asks the API whether one is running). What
 * requires a stream is the dock.
 */
export function useWatchDock({
  selectedChannelId,
  candidate,
  channelLive,
  inCallChannelId,
}: {
  selectedChannelId: string | null;
  /** The open channel, when it is a voice room worth watching. */
  candidate: WatchDockSession | null;
  channelLive: VoiceState["channelLive"];
  /** The room this person holds a seat in, if any. */
  inCallChannelId: string | null;
}): {
  session: WatchDockSession | null;
  placement: WatchPlacement;
  /** Non-null only while a mini player is actually on screen. */
  dockedChannelId: string | null;
  dismiss: () => void;
  host: HTMLElement;
  dockRef: RefObject<HTMLDivElement | null>;
} {
  const { host, dockRef } = useWatchDockHost();
  const [session, setSession] = useState<WatchDockSession | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [watchedId, setWatchedId] = useState<string | null>(null);

  const hasStream =
    session !== null && channelLive[session.channelId]?.stream != null;
  const onStage = session !== null && selectedChannelId === session.channelId;
  const watched = session !== null && watchedId === session.channelId;
  const dismissed = session !== null && dismissedId === session.channelId;
  const inCall = session !== null && inCallChannelId === session.channelId;

  // Computed from the CURRENT session (the one this render started with),
  // before the effect below decides whether a new candidate gets to replace
  // it. That is the point: it answers "is the session already on screen?"
  // using the session as it stood when the viewer picked a channel, not
  // whatever this effect is about to do to it.
  const placement = resolveWatchPlacement({
    session,
    selectedChannelId,
    hasStream,
    watched,
    dismissed,
    inCall,
  });

  useEffect(() => {
    if (!candidate) {
      return;
    }
    setSession((previous) => {
      if (sameWatchSession(previous, candidate)) {
        return previous;
      }
      // Opening a DIFFERENT voice channel is not the same as opening the
      // one being watched: a stream that is actually docked on screen is
      // not bumped just because the viewer looked at some other room.
      // Only a session with nothing left to show (dismissed, ended, no
      // stream ever started) makes room for the new one — otherwise every
      // voice channel in the sidebar would double as an "close the mini
      // player" button.
      if (previous && placement === "dock") {
        return previous;
      }
      return candidate;
    });
  }, [candidate, placement]);

  // X is "not now", not "never": opening the channel again brings it back.
  useEffect(() => {
    if (dismissedId !== null && dismissedId === selectedChannelId) {
      setDismissedId(null);
    }
  }, [dismissedId, selectedChannelId]);

  useEffect(() => {
    if (onStage && hasStream && session) {
      setWatchedId(session.channelId);
    }
  }, [onStage, hasStream, session]);

  // A stream that ends while docked does not come back on its own. Watching is
  // something a person chose by opening the channel, and an egress that
  // restarts ten minutes later is not that choice.
  useEffect(() => {
    if (placement === "gone" && !onStage && watchedId !== null) {
      setWatchedId(null);
    }
  }, [placement, onStage, watchedId]);

  const sessionRef = useRef<WatchDockSession | null>(session);
  sessionRef.current = session;
  const dismiss = useCallback(() => {
    const current = sessionRef.current;
    if (current) {
      setDismissedId(current.channelId);
    }
  }, []);

  return {
    session,
    placement,
    dockedChannelId:
      placement === "dock" && session ? session.channelId : null,
    dismiss,
    host,
    dockRef,
  };
}
