import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type TransitionEvent,
} from "react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * THE CALL LIVES WITH THE COMPOSER.
 *
 * A voice-only call used to draw a strip across the top of the channel: faces,
 * a name, the control bar. The top of a channel is where the picture goes when
 * there is one, and every call product people already know (Discord, Meet,
 * FaceTime) keeps its controls at the bottom, beside the thing you type into.
 * So the collapsed bar now docks INSIDE the composer, above the text field,
 * and the composer grows to hold it.
 *
 * WHY A SLOT AND NOT A SECOND MOUNT. `CallStage` is the one component that
 * knows a room well enough to build its control bar: it holds the peers, the
 * caps, the fullscreen state, the quality menu and a few dozen callbacks, and
 * it decides for itself whether the stage is expanded or collapsed. Moving the
 * collapsed branch into the composer by mounting a second `CallStage` there
 * would remount the call surface every time a camera went on or off. Instead
 * the stage keeps deciding and, when it lands on "collapsed", hands the bar it
 * built to this slot. The stage renders nothing in its own place; the composer
 * renders the bar in its. One decision, one bar, two possible homes.
 *
 * The handoff is a React element published through a store (a layout effect,
 * so the composer has it before the first paint). A DOM portal would have been
 * the other shape, and it cannot animate the exit: the moment the person
 * hangs up, `CallStage` unmounts and a portal's children go with it, leaving
 * nothing to fade. The outlet below keeps the last bar it was given for one
 * closing transition, which is what lets it fold away instead of vanishing.
 *
 * The content is keyed by channel so a composer only ever draws the call of
 * the channel it belongs to. The composer remounts per channel; without the
 * key its first render after a switch would briefly see the previous
 * channel's bar.
 *
 * Speaking ticks rebuild the bar. The store notifies only the outlet, and
 * the provider's React state holds just the channel key, so a roster update
 * does not walk the conversation tree a second time before paint.
 */
export interface CallDockContent {
  channelId: string;
  node: ReactElement;
}

type Publish = (content: CallDockContent | null) => void;
type ReportOccupied = (occupied: boolean) => void;

type DockStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CallDockContent | null;
  set: (next: CallDockContent | null) => void;
};

function createDockStore(): DockStore {
  let snapshot: CallDockContent | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    set(next) {
      if (snapshot === next) {
        return;
      }
      if (
        snapshot !== null &&
        next !== null &&
        snapshot.channelId === next.channelId &&
        snapshot.node === next.node
      ) {
        return;
      }
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const PublishContext = createContext<Publish | null>(null);
const StoreContext = createContext<DockStore | null>(null);
const OccupiedContext = createContext<ReportOccupied | null>(null);

const subscribeNone = () => () => {};
const snapshotNone = () => null;

export function CallDockProvider({
  children,
  viewingChannelId,
  onOccupiedChange,
}: {
  children: ReactNode;
  /**
   * The channel whose composer is on screen. Occupancy is this id matching
   * the published bar AND an outlet actually drawing that bar. Staying in a
   * call and opening a text channel leaves the sidebar's camera and share
   * buttons in place, because that composer has no dock.
   */
  viewingChannelId?: string;
  /**
   * Whether a bar is DRAWN right now: reported by the outlet that draws it,
   * not by the stage that publishes it, so a bar published for a channel
   * whose composer is not on screen counts as absent. `App` reads it to
   * fold the sidebar's duplicate camera and share buttons while the same
   * controls are on screen in the composer, and gets `false` again when
   * the outlet or this provider goes away.
   */
  onOccupiedChange?: (occupied: boolean) => void;
}) {
  const store = useMemo(() => createDockStore(), []);
  const [publishedChannelId, setPublishedChannelId] = useState<string | null>(
    null,
  );
  const publish = useCallback<Publish>(
    (next) => {
      store.set(next);
      setPublishedChannelId((previous) => {
        const id = next?.channelId ?? null;
        return previous === id ? previous : id;
      });
    },
    [store],
  );
  const [barVisible, setBarVisible] = useState(false);
  const occupied =
    barVisible &&
    publishedChannelId !== null &&
    publishedChannelId === viewingChannelId;
  useEffect(() => {
    onOccupiedChange?.(occupied);
  }, [occupied, onOccupiedChange]);
  // Separate from the occupancy effect so a last-true report cannot stick
  // when this provider unmounts (the conversation shell going away mid-call).
  const onOccupiedChangeRef = useRef(onOccupiedChange);
  onOccupiedChangeRef.current = onOccupiedChange;
  useEffect(
    () => () => {
      onOccupiedChangeRef.current?.(false);
    },
    [],
  );
  return (
    <PublishContext.Provider value={publish}>
      <OccupiedContext.Provider value={setBarVisible}>
        <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
      </OccupiedContext.Provider>
    </PublishContext.Provider>
  );
}

/**
 * The stage's end of the handoff. Null outside a provider, which is how a
 * `CallStage` mounted on its own (a test, a surface with no composer) knows to
 * keep drawing the bar where it stands.
 */
export function useCallDockPublisher(): Publish | null {
  return useContext(PublishContext);
}

/**
 * Renders nothing here and puts `children` in the dock instead.
 *
 * Publishes in a layout effect so the outlet has the bar before the first
 * paint. The store identity stays put; only the outlet subscribes, so a
 * speaking tick does not rebuild the conversation tree. Cleanup publishes
 * null so the dock closes when the stage goes away or stops being collapsed.
 */
export function CallDockPortal({
  channelId,
  publish,
  children,
}: {
  channelId: string;
  publish: Publish;
  children: ReactElement;
}) {
  useLayoutEffect(() => {
    publish({ channelId, node: children });
  }, [channelId, children, publish]);
  useLayoutEffect(() => () => publish(null), [publish]);
  return null;
}

/**
 * Only reached when no `transitionend` arrives: a pane hidden with the
 * `hidden` attribute runs no transitions, and the last bar would otherwise
 * stay mounted at zero height. Three times `--duration-base`.
 */
const EXIT_BACKSTOP_MS = 600;

/**
 * The composer's end: the slot the bar is drawn in, and the animation that
 * opens and closes it.
 *
 * Height is a grid row going from `0fr` to `1fr`, which needs no measuring
 * and follows the bar if it wraps to two rows on a narrow pane. A fresh bar
 * mounts closed and opens on the next frame, so the first appearance is a
 * transition rather than a jump. On the way out the last bar is kept until
 * the row has finished closing, so it fades and folds together; the message
 * list above scroll-anchors to the bottom throughout (`MessageList` watches
 * its own height with a ResizeObserver).
 *
 * While a bar is live it is drawn from the store the stage publishes into:
 * the stage rebuilds the element every speaking tick, and copying it into
 * outlet state would cost a second render pass each time. State only enters
 * on the way out, to hold the last bar for its closing transition.
 *
 * Under reduced motion the row snaps both ways.
 */
export function CallDockOutlet({ channelId }: { channelId: string }) {
  const store = useContext(StoreContext);
  const published = useSyncExternalStore(
    store ? store.subscribe : subscribeNone,
    store ? store.getSnapshot : snapshotNone,
    snapshotNone,
  );
  const content =
    published !== null && published.channelId === channelId
      ? published.node
      : null;
  const active = content !== null;
  const reducedMotion = usePrefersReducedMotion();

  // This outlet is the one drawing the bar, so it is the one that says so:
  // a bar published for another channel's composer is not on screen. Cleared
  // when the outlet unmounts (the composer of another channel takes over).
  const reportOccupied = useContext(OccupiedContext);
  useLayoutEffect(() => {
    reportOccupied?.(active);
  }, [active, reportOccupied]);
  useLayoutEffect(
    () => () => {
      reportOccupied?.(false);
    },
    [reportOccupied],
  );

  // The last live bar, for the exit. The render that loses the content must
  // still draw that bar in the SAME element, or the row remounts at 0fr and
  // there is nothing to transition from; so that one render reads the ref
  // (the value a layout effect wrote on the previous, live render, and which
  // nothing else changes until the effect below moves it into `held`).
  const lastContent = useRef<ReactElement | null>(null);
  useLayoutEffect(() => {
    if (content !== null) {
      lastContent.current = content;
    }
  }, [content]);

  // The bar kept on screen while the row closes; null while live or gone.
  const [held, setHeld] = useState<ReactElement | null>(null);
  const [open, setOpen] = useState(false);

  // Leaving: start closing now, and drop the bar at once when nothing will
  // animate. Arriving again mid-exit lets the held copy go.
  useLayoutEffect(() => {
    if (active) {
      setHeld(null);
      return;
    }
    setOpen(false);
    setHeld(reducedMotion ? null : lastContent.current);
    lastContent.current = null;
  }, [active, reducedMotion]);

  // Arriving: one painted frame closed, then open, so the row transitions.
  useEffect(() => {
    if (!active || open) {
      return;
    }
    if (reducedMotion) {
      setOpen(true);
      return;
    }
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [active, open, reducedMotion]);

  useEffect(() => {
    if (active || held === null) {
      return;
    }
    const timer = setTimeout(() => setHeld(null), EXIT_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [active, held]);

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "grid-template-rows" ||
      active
    ) {
      return;
    }
    setHeld(null);
  };

  // Under reduced motion there is no exit to draw, so the leaving render
  // drops the bar itself rather than waiting on the effect above to commit
  // a state change (which it would not, if the row never got to open).
  const shown = active
    ? content
    : (held ?? (reducedMotion ? null : lastContent.current));
  if (shown === null) {
    return null;
  }

  return (
    <div
      data-call-dock=""
      data-state={open ? "open" : "closed"}
      aria-hidden={active ? undefined : true}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-[var(--duration-base)] motion-reduce:transition-none",
        open
          ? "grid-rows-[1fr] opacity-100 ease-[var(--ease-emphasized)]"
          : "pointer-events-none grid-rows-[0fr] opacity-0 ease-in",
      )}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="min-h-0 overflow-hidden">
        {/* Same 12px sides as the text field, so the first face, the pill
            and the field's text share a left edge. On a 360 phone that
            leaves 238px, and the six tiles a phone gets (mute, hand, music,
            camera, share, hang up) take 236 of it. */}
        <div className="border-b border-border/60 px-3 pb-2 pt-2.5">{shown}</div>
      </div>
    </div>
  );
}
