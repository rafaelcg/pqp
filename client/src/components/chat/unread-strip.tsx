import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * The strip at the top of the log under the redesign (the text channels
 * canvas, "Não lidas"): how many arrived since the reader left, and how many
 * of those mention them, with a way to the first one and a way to say
 * "read". Esc does the same as Marcar como lida, unless something on screen
 * (a menu, a dialog, the composer's reply) took the key first.
 */
export function UnreadStrip({
  count,
  mentions,
  since,
  onJump,
  onDismiss,
  escapeDisabled = false,
}: {
  count: number;
  mentions: number;
  since: string;
  onJump: () => void;
  onDismiss: () => void;
  /** Escape belongs to something else right now (select mode). */
  escapeDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || escapeDisabled) {
        return;
      }
      // Not on screen: the channel's log stays mounted and hidden while a
      // thread has taken its place, and Esc there is about the thread.
      if (stripRef.current?.checkVisibility?.() === false) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) {
        return;
      }
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, escapeDisabled]);

  // A size container, so what fits follows the log's own width and not the
  // window's: a thread's 416px column is narrow on a wide screen. The Esc
  // hint goes first, then (only on a phone, as before) the jump.
  return (
    <div
      ref={stripRef}
      data-unread-strip=""
      className="@container sticky -top-4 z-[4] mx-4 -mt-4 mb-2 rounded-b-lg bg-surface-2 text-xs font-semibold text-text ring-1 ring-inset ring-border"
    >
      <div className="flex h-8 min-w-0 items-center gap-2 pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate">
        {t("chat.unread.strip", { count, time: since })}
        {mentions > 0 && (
          <>
            {" · "}
            <span className="text-[color:var(--color-on-warning-soft)]">
              {t("chat.unread.stripMentions", { count: mentions })}
            </span>
          </>
        )}
      </span>
      <span
        data-unread-esc-hint=""
        className="shrink-0 font-medium text-text-tertiary max-md:hidden @max-[36rem]:hidden"
      >
        {t("chat.unread.escHint")}
      </span>
      <Button
        variant="ghost"
        size="sm"
        data-unread-jump=""
        className="h-6 shrink-0 max-sm:hidden @max-[20rem]:hidden"
        onClick={onJump}
      >
        {t("chat.unread.jumpFirst")}
      </Button>
      <Button variant="secondary" size="sm" className="h-6 shrink-0" onClick={onDismiss}>
        {t("chat.markRead")}
      </Button>
      </div>
    </div>
  );
}
