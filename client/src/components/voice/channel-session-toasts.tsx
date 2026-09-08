import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  onChannelSessionReminderToast,
  type ChannelSessionReminderToast,
} from "@/lib/channel-session-schedule";
import { cn } from "@/lib/utils";

const TOAST_MS = 8000;

interface Card extends ChannelSessionReminderToast {
  leaving: boolean;
}

/**
 * "Cinemoon começa em 10 minutos" / "Cinemoon está ao vivo", floating in the
 * same corner and on the same shell as `DmToasts`, one card per session, one
 * click opens the channel. Same reduced-motion contract: `animate-toast-in`
 * / `animate-toast-out` already collapse to a fade under
 * `prefers-reduced-motion` (see dm-toasts.tsx).
 */
export function ChannelSessionToasts({
  onOpen,
}: {
  onOpen: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<Card[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((sessionId: string) => {
    const timer = timers.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(sessionId);
    }
    setCards((previous) =>
      previous.map((card) =>
        card.sessionId === sessionId ? { ...card, leaving: true } : card,
      ),
    );
    setTimeout(() => {
      setCards((previous) => previous.filter((c) => c.sessionId !== sessionId));
    }, 200);
  }, []);

  useEffect(() => {
    return onChannelSessionReminderToast((toast) => {
      setCards((previous) => [
        { ...toast, leaving: false },
        ...previous.filter((c) => c.sessionId !== toast.sessionId),
      ].slice(0, 3));
      const existing = timers.current.get(toast.sessionId);
      if (existing) {
        clearTimeout(existing);
      }
      timers.current.set(
        toast.sessionId,
        setTimeout(() => dismiss(toast.sessionId), TOAST_MS),
      );
    });
  }, [dismiss]);

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  if (cards.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-40 flex flex-col items-center gap-2 px-2 sm:top-[4.25rem]"
      data-channel-session-toasts
    >
      {cards.map((card) => (
        <div
          key={card.sessionId}
          role="status"
          data-channel-session-toast={card.sessionId}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border border-ink-4/70 bg-ink-2 p-3 shadow-[var(--shadow-popover)]",
            card.leaving ? "animate-toast-out" : "animate-toast-in",
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => {
              dismiss(card.sessionId);
              onOpen(card.channelId);
            }}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
              <CalendarClock className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-paper">
                {card.title}
              </span>
              <span className="block truncate text-xs text-paper-muted">
                {card.kind === "live"
                  ? t("watchPartySchedule.toast.live")
                  : t("watchPartySchedule.toast.startingSoon")}
              </span>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
