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
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((channelId: string) => {
    setCards((previous) => markToastLeaving(previous, channelId));
    const existing = removalTimers.current.get(channelId);
    if (existing) {
      clearTimeout(existing);
    }
    removalTimers.current.set(
      channelId,
      setTimeout(() => {
        removalTimers.current.delete(channelId);
        setCards((previous) => removeToastCard(previous, channelId));
      }, LEAVE_MS),
    );
  }, []);

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
      setCards((previous) => {
        let next: DisplayCard[] = previous;
        for (const card of previous) {
          if (
            !card.leaving &&
            card.pausedRemainingMs === null &&
            card.expiresAt <= now
          ) {
            next = markToastLeaving(next, card.channelId) as DisplayCard[];
            const existing = removalTimers.current.get(card.channelId);
            if (existing) {
              clearTimeout(existing);
            }
            removalTimers.current.set(
              card.channelId,
              setTimeout(() => {
                removalTimers.current.delete(card.channelId);
                setCards((p) => removeToastCard(p, card.channelId));
              }, LEAVE_MS),
            );
          }
        }
        return next;
      });
    }, Math.max(0, deadline));
    return () => {
      if (expireTimer.current) {
        clearTimeout(expireTimer.current);
        expireTimer.current = null;
      }
    };
  }, [cards]);

  // New arrivals: coalesce/position/cap is the pure module's job; the preview
  // text is attached here since it is not part of that stack math.
  useEffect(() => {
    return onActivityToast((toast: ActivityToast) => {
      const now = Date.now();
      setCards((previous) => {
        const next = upsertToastCard(
          previous,
          { channelId: toast.channelId, count: toast.count, mentions: toast.mentions },
          now,
        ) as DisplayCard[];
        return next.map((card) =>
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
          dismiss(card.channelId);
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
          key={card.channelId}
          card={card}
          conversation={conversations.find((c) => c.channelId === card.channelId)}
          onOpen={() => {
            dismiss(card.channelId);
            onOpen(card.channelId);
          }}
          onDismiss={() => dismiss(card.channelId)}
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
        onClick={onOpen}
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
} {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const cancelled = useRef(false);
  const [translateX, setTranslateX] = useState(0);
  const [springing, setSpringing] = useState(false);

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
  };
}
