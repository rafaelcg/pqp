import type { DmSummary } from "@pqp/shared";
import { MessageCircle, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { conversationTitle } from "@/lib/conversations";
import {
  freezeToastCards,
  markToastLeaving,
  nextToastDeadline,
  pauseToastCard,
  removeToastCard,
  resumeToastCard,
  thawToastCards,
  upsertToastCard,
  type ToastCard,
} from "@/lib/dm-toast-queue";
import { useTranslation } from "@/lib/i18n";
import { onActivityToast, type ActivityToast } from "@/lib/notifications";
import { subscribeEscapeUnlessOverlay } from "@/lib/escape-unless-overlay";
import { cn } from "@/lib/utils";

/**
 * "Somebody wrote to you", in the corner, while you are looking at something
 * else in the app. MSN-style: top right on desktop, above the composer on a
 * phone, a few seconds on screen, one click to open, gone on its own.
 *
 * WHY THIS EXISTS. The rail badge is a red dot 72px from the left edge; the
 * OS banner only fires when desktop notifications are on and granted, which
 * on a fresh install they are not. This card is the middle ground. A server
 * channel never gets one — its badge already says everything it needs to —
 * only conversations, which are addressed to you.
 *
 * Same corner and shell as the incoming-call card, below it in the stack so
 * a ringing call always wins. One card per conversation: a second message
 * from the same person bumps the count and restarts the clock rather than
 * stacking. Reduced motion drops the slide and keeps the fade.
 *
 * Pure stack/timer math (coalescing, the cap, pause/resume, the tab-hidden
 * freeze) lives in `lib/dm-toast-queue.ts`, unit-tested with no DOM. What is
 * left here is rendering, the pointer/keyboard wiring, and the one scheduler
 * that turns "a card's `expiresAt` passed" into "start its exit animation".
 */

/** How long the exit animation gets before the card actually unmounts. */
const LEAVE_MS = 200;

/** Past this a horizontal drag counts as "let go of it". */
const SWIPE_DISMISS_PX = 48;

/** Past this a drag is a page scroll, not a dismiss — the gesture cancels. */
const SWIPE_CANCEL_VERTICAL_PX = 12;

interface DisplayCard extends ToastCard {
  preview?: string;
  authorName?: string;
}

export function DmToasts({
  conversations,
  selectedChannelId,
  onOpen,
  onActiveChange,
}: {
  conversations: readonly DmSummary[];
  selectedChannelId: string | null;
  onOpen: (channelId: string) => void;
  /**
   * Whether any card is currently up, so `App` can yield the bottom-right
   * onboarding corner to this instead — the two would collide on a phone,
   * and a card that yielded records no impression (`docs/ONBOARDING.md`).
   */
  onActiveChange?: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<DisplayCard[]>([]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const expireTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keyed on `${channelId}:${token}`, not `channelId` alone: a dismiss and a
  // fresh arrival for the same conversation can race within the same
  // `LEAVE_MS` window, and two card instances sharing a channel id must not
  // share one timer slot either — the second would clobber the first's.
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const scheduleRemoval = useCallback((channelId: string, token: number) => {
    const key = `${channelId}:${token}`;
    const existing = removalTimers.current.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    removalTimers.current.set(
      key,
      setTimeout(() => {
        removalTimers.current.delete(key);
        setCards((previous) => removeToastCard(previous, channelId, token));
      }, LEAVE_MS),
    );
  }, []);

  const dismiss = useCallback(
    (channelId: string, token?: number) => {
      setCards((previous) => markToastLeaving(previous, channelId, token));
      // The token to schedule removal for is whichever instance is actually
      // current when this runs, not a possibly-stale one the caller closed
      // over — reading it off `cardsRef` keeps the two in step.
      const current = cardsRef.current.find(
        (card) => card.channelId === channelId && (token === undefined || card.token === token),
      );
      if (current) {
        scheduleRemoval(channelId, current.token);
      }
    },
    [scheduleRemoval],
  );

  // The one timer for the whole stack: fires at the soonest `expiresAt` among
  // active (not paused, not already leaving) cards, starts their exit, then
  // reschedules for whatever is soonest next. A card paused by a pointer or
  // by the tab going hidden is skipped until it resumes.
  useEffect(() => {
    if (expireTimer.current) {
      clearTimeout(expireTimer.current);
      expireTimer.current = null;
    }
    const deadline = nextToastDeadline(cards, Date.now());
    if (deadline === null) {
      return;
    }
    expireTimer.current = setTimeout(() => {
      const now = Date.now();
      const due: Array<{ channelId: string; token: number }> = [];
      setCards((previous) => {
        let next: DisplayCard[] = previous;
        for (const card of previous) {
          if (
            !card.leaving &&
            card.pausedRemainingMs === null &&
            card.expiresAt <= now
          ) {
            next = markToastLeaving(next, card.channelId, card.token) as DisplayCard[];
            due.push({ channelId: card.channelId, token: card.token });
          }
        }
        return next;
      });
      for (const { channelId, token } of due) {
        scheduleRemoval(channelId, token);
      }
    }, Math.max(0, deadline));
    return () => {
      if (expireTimer.current) {
        clearTimeout(expireTimer.current);
        expireTimer.current = null;
      }
    };
  }, [cards, scheduleRemoval]);

  // New arrivals: coalesce/position/cap is the pure module's job; the preview
  // text is attached here since it is not part of that stack math.
  useEffect(() => {
    return onActivityToast((toast: ActivityToast) => {
      const now = Date.now();
      // A frame that slips in while the tab is hidden (the toast normally
      // never fires then, but a visibilitychange and the frame's arrival can
      // race) must not start an unfrozen countdown nobody is watching — it
      // would burn its whole 6s before the tab is looked at again.
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      setCards((previous) => {
        let next = upsertToastCard(
          previous,
          { channelId: toast.channelId, count: toast.count, mentions: toast.mentions },
          now,
        );
        if (hidden) {
          next = freezeToastCards(next, now);
        }
        return (next as DisplayCard[]).map((card) =>
          card.channelId === toast.channelId
            ? { ...card, preview: toast.preview, authorName: toast.authorName }
            : card,
        );
      });
    });
  }, []);

  // Opening the conversation by any route retires its card.
  useEffect(() => {
    if (
      selectedChannelId &&
      cardsRef.current.some(
        (c) => c.channelId === selectedChannelId && !c.leaving,
      )
    ) {
      dismiss(selectedChannelId);
    }
  }, [selectedChannelId, dismiss]);

  useEffect(() => {
    const timerMap = removalTimers.current;
    return () => {
      for (const timer of timerMap.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  // Escape dismisses every card, deferring to a dialog/menu already open on
  // top — the toast's old raw `keydown` listener used to steal the key from
  // whatever the user actually meant to close.
  useEffect(() => {
    if (cards.length === 0) {
      return;
    }
    return subscribeEscapeUnlessOverlay(() => {
      for (const card of cardsRef.current) {
        if (!card.leaving) {
          dismiss(card.channelId, card.token);
        }
      }
    });
  }, [cards.length, dismiss]);

  // The tab going hidden freezes every timer; coming back re-arms each with
  // a short, equal window rather than resuming a stale one from an hour ago.
  useEffect(() => {
    function onVisibility() {
      const now = Date.now();
      setCards((previous) =>
        document.visibilityState === "hidden"
          ? (freezeToastCards(previous, now) as DisplayCard[])
          : (thawToastCards(previous, now) as DisplayCard[]),
      );
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  useEffect(() => {
    onActiveChangeRef.current?.(cards.length > 0);
  }, [cards.length]);

  const pause = useCallback((channelId: string) => {
    setCards((previous) => pauseToastCard(previous, channelId, Date.now()));
  }, []);
  const resume = useCallback((channelId: string) => {
    setCards((previous) => resumeToastCard(previous, channelId, Date.now()));
  }, []);

  if (cards.length === 0) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label={t("dmToast.region")}
      // Desktop: top right, directly under where the incoming-call overlay
      // sits (`sm:right-4 sm:top-4 z-50`) — a ringing call always outranks
      // this (`z-40`). Phone: full width minus 12px gutters, anchored above
      // the composer (56px plus safe area) rather than under the channel
      // header where a thumb cannot reach it. `flex-col-reverse` on the
      // phone keeps the newest card nearest the thumb even though the
      // container grows upward from the bottom; `sm:flex-col` restores plain
      // top-to-bottom order once the container is anchored at the top.
      className="pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex flex-col-reverse gap-2 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:flex-col sm:items-end"
      data-dm-toasts
    >
      {cards.map((card) => (
        <ToastCardView
          // Not `card.channelId` alone: a dismissed card mid-exit-animation
          // and a fresh arrival for the same conversation can be two entries
          // in this array at once (see `ToastCard.token`'s doc comment), and
          // React requires distinct keys for distinct siblings.
          key={`${card.channelId}:${card.token}`}
          card={card}
          conversation={conversations.find((c) => c.channelId === card.channelId)}
          onOpen={() => {
            dismiss(card.channelId, card.token);
            onOpen(card.channelId);
          }}
          onDismiss={() => dismiss(card.channelId, card.token)}
          onPause={() => pause(card.channelId)}
          onResume={() => resume(card.channelId)}
        />
      ))}
    </div>
  );
}

function ToastCardView({
  card,
  conversation,
  onOpen,
  onDismiss,
  onPause,
  onResume,
}: {
  card: DisplayCard;
  conversation: DmSummary | undefined;
  onOpen: () => void;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const participants = conversation?.participants ?? [];
  const isGroup = conversation?.kind === "group";
  const senderName = card.authorName || participants[0]?.displayName || t("notify.activity");
  const groupTitle = isGroup ? conversationTitle(participants) : null;
  const body =
    card.preview ||
    (card.mentions > 0
      ? t("notify.mentions", { count: card.mentions })
      : t("notify.messages", { count: card.count }));
  const more = card.count > 1;

  const swipe = useSwipeDismiss(onDismiss);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("dmToast.aria", { name: senderName }) + (card.preview ? `. ${card.preview}` : "")}
      data-dm-toast={card.channelId}
      onPointerEnter={onPause}
      onPointerLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      style={
        swipe.translateX !== 0
          ? {
              transform: `translateX(${swipe.translateX}px)`,
              opacity: Math.max(0, 1 - Math.abs(swipe.translateX) / 200),
              transition: swipe.springing ? "transform 150ms ease-out" : undefined,
            }
          : undefined
      }
      className={cn(
        "elevation-3 pointer-events-auto flex min-h-16 w-full gap-3 rounded-[var(--radius-card)] p-3 sm:w-80",
        card.leaving ? "animate-toast-out" : "animate-toast-in",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
        onClick={() => {
          // A touch's synthetic click still fires after a swipe that sprang
          // back — a drag past the small jitter threshold means this tap was
          // never a tap.
          if (swipe.consumeDidDrag()) {
            return;
          }
          onOpen();
        }}
      >
        {isGroup ? (
          <GroupAvatarStack participants={participants} />
        ) : participants[0] ? (
          <UserAvatar
            name={participants[0].displayName}
            avatarUrl={participants[0].avatarUrl}
            className="h-10 w-10 shrink-0"
            fallbackClassName="bg-accent text-sm text-on-accent"
            rounded="full"
          />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
            <MessageCircle className="h-5 w-5" aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">
            {senderName}
            {groupTitle && (
              <span className="font-normal text-text-tertiary"> · {groupTitle}</span>
            )}
          </span>
          <span className="line-clamp-2 text-xs text-text-secondary">{body}</span>
          {more && (
            <span className="block text-[11px] text-text-tertiary">
              {t("dmToast.more", { count: card.count - 1 })}
            </span>
          )}
          <span className="sr-only">{t("dmToast.open")}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={t("dmToast.dismiss")}
        title={t("dmToast.dismiss")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
        onClick={onDismiss}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** Up to three overlapped faces, same idea as the sidebar's own stack. */
function GroupAvatarStack({
  participants,
}: {
  participants: readonly DmSummary["participants"][number][];
}) {
  const shown = participants.slice(0, 3);
  return (
    <span className="flex h-10 shrink-0 -space-x-2" aria-hidden="true">
      {shown.map((person) => (
        <UserAvatar
          key={person.id}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          className="h-10 w-10 ring-2 ring-surface-1"
          fallbackClassName="bg-surface-2 text-xs text-text"
          rounded="full"
        />
      ))}
    </span>
  );
}

/** Past this a touch move counts as a drag, not the small jitter under a tap. */
const DRAG_CLICK_SUPPRESS_PX = 10;

/**
 * Horizontal drag to dismiss, touch only. Vertical movement past 12px cancels
 * the gesture so a page scroll started on a card is never eaten; a release
 * under 48px springs back rather than dismissing.
 */
function useSwipeDismiss(onDismiss: () => void): {
  translateX: number;
  springing: boolean;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  /**
   * Read (and clear) whether the gesture just ended moved far enough to be a
   * drag rather than a tap. A touch's synthetic `click` still fires after a
   * spring-back release, so the open button's own handler calls this first
   * and bails if it was a drag — otherwise brushing a card while scrolling
   * past it, or a swipe that springs back under the 48px threshold, would
   * also open the conversation.
   */
  consumeDidDrag: () => boolean;
} {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const cancelled = useRef(false);
  const didDrag = useRef(false);
  const [translateX, setTranslateX] = useState(0);
  const [springing, setSpringing] = useState(false);

  const consumeDidDrag = useCallback(() => {
    const value = didDrag.current;
    didDrag.current = false;
    return value;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    startX.current = event.clientX;
    startY.current = event.clientY;
    cancelled.current = false;
    setSpringing(false);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (startX.current === null || cancelled.current) {
      return;
    }
    const dx = event.clientX - startX.current;
    const dy = event.clientY - (startY.current ?? event.clientY);
    if (Math.abs(dy) > SWIPE_CANCEL_VERTICAL_PX) {
      cancelled.current = true;
      setTranslateX(0);
      return;
    }
    if (Math.abs(dx) > DRAG_CLICK_SUPPRESS_PX) {
      didDrag.current = true;
    }
    setTranslateX(dx);
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      if (!cancelled.current && startX.current !== null) {
        const dx = event.clientX - startX.current;
        if (Math.abs(dx) > SWIPE_DISMISS_PX) {
          onDismiss();
        } else {
          setSpringing(true);
          setTranslateX(0);
        }
      }
      startX.current = null;
      startY.current = null;
    },
    [onDismiss],
  );

  return {
    translateX,
    springing,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    consumeDidDrag,
  };
}
