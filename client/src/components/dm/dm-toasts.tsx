import type { DmSummary } from "@pqp/shared";
import { MessageCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { conversationTitle } from "@/lib/conversations";
import { useTranslation } from "@/lib/i18n";
import { onActivityToast, type ActivityToast } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * "Somebody wrote to you", in the corner, while you are looking at something
 * else in the app.
 *
 * WHY THIS EXISTS. The rail badge is a red dot 72px from the left edge; the
 * OS banner only fires when desktop notifications are on and granted, which
 * on a fresh install they are not. Between the two, a DM that lands while
 * you are reading #geral was easy to miss for minutes. This card is the
 * middle ground: on screen for a few seconds, one click to open, gone on its
 * own. Server channels never get one (their badge is the signal); only
 * conversations, which are addressed to you.
 *
 * Same corner and shell as the incoming-call card, below it in the stack so
 * a ringing call always wins. One card per conversation: a second message
 * from the same person bumps the count and restarts the clock rather than
 * stacking. Reduced motion drops the slide and keeps the fade.
 */

const TOAST_MS = 6000;
const MAX_CARDS = 3;

interface Card {
  channelId: string;
  count: number;
  mentions: number;
  /** Bumped on every update so the timer restarts. */
  at: number;
  leaving: boolean;
}

export function DmToasts({
  conversations,
  selectedChannelId,
  onOpen,
}: {
  conversations: readonly DmSummary[];
  selectedChannelId: string | null;
  onOpen: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<Card[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((channelId: string) => {
    const timer = timers.current.get(channelId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(channelId);
    }
    setCards((previous) =>
      previous.map((card) =>
        card.channelId === channelId ? { ...card, leaving: true } : card,
      ),
    );
    setTimeout(() => {
      setCards((previous) =>
        previous.filter((card) => card.channelId !== channelId),
      );
    }, 200);
  }, []);

  useEffect(() => {
    const arm = (channelId: string) => {
      const existing = timers.current.get(channelId);
      if (existing) {
        clearTimeout(existing);
      }
      timers.current.set(
        channelId,
        setTimeout(() => dismiss(channelId), TOAST_MS),
      );
    };
    return onActivityToast((toast: ActivityToast) => {
      setCards((previous) => {
        const others = previous.filter((c) => c.channelId !== toast.channelId);
        const current = previous.find((c) => c.channelId === toast.channelId);
        const next: Card = {
          channelId: toast.channelId,
          count: (current && !current.leaving ? current.count : 0) + toast.count,
          mentions:
            (current && !current.leaving ? current.mentions : 0) + toast.mentions,
          at: Date.now(),
          leaving: false,
        };
        // Newest on top, oldest dropped.
        return [next, ...others].slice(0, MAX_CARDS);
      });
      arm(toast.channelId);
    });
  }, [dismiss]);

  // Opening the conversation by any route retires its card.
  useEffect(() => {
    if (selectedChannelId && cards.some((c) => c.channelId === selectedChannelId)) {
      dismiss(selectedChannelId);
    }
  }, [selectedChannelId, cards, dismiss]);

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (cards.length === 0) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        for (const card of cards) {
          dismiss(card.channelId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, dismiss]);

  if (cards.length === 0) {
    return null;
  }

  return (
    <div
      // Top-centre under the channel header on a desktop, so it floats over the
      // messages rather than on the members panel or the sidebar; full width
      // at the top on a phone, where there is only one column anyway.
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex flex-col items-center gap-2 px-2 sm:top-[4.25rem]"
      data-dm-toasts
    >
      {cards.map((card) => {
        const conversation = conversations.find(
          (c) => c.channelId === card.channelId,
        );
        const participants = conversation?.participants ?? [];
        const title = conversation
          ? conversationTitle(participants)
          : t("notify.activity");
        const first = participants[0];
        const body =
          card.mentions > 0
            ? t("notify.mentions", { count: card.mentions })
            : t("notify.messages", { count: card.count });
        return (
          <div
            key={card.channelId}
            role="status"
            aria-label={t("dmToast.aria", { name: title })}
            data-dm-toast={card.channelId}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border border-ink-4/70 bg-ink-2 p-3 shadow-[var(--shadow-popover,0_12px_32px_rgba(0,0,0,0.45))]",
              card.leaving ? "animate-toast-out" : "animate-toast-in",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => {
                dismiss(card.channelId);
                onOpen(card.channelId);
              }}
            >
              {first ? (
                <UserAvatar
                  name={first.displayName}
                  avatarUrl={first.avatarUrl}
                  className="h-10 w-10"
                  fallbackClassName="bg-signal text-sm text-ink"
                  rounded="full"
                />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
                  <MessageCircle className="h-5 w-5" aria-hidden />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-paper">
                  {title}
                </span>
                <span className="block truncate text-xs text-paper-muted">
                  {body}
                </span>
              </span>
              <span className="shrink-0 rounded-md bg-signal px-2.5 py-1 text-xs font-semibold text-ink">
                {t("dmToast.open")}
              </span>
            </button>
            <button
              type="button"
              aria-label={t("dmToast.dismiss")}
              title={t("dmToast.dismiss")}
              className="shrink-0 rounded-md p-1 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={() => dismiss(card.channelId)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
