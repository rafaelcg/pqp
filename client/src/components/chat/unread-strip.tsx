import { useEffect } from "react";
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
}: {
  count: number;
  mentions: number;
  since: string;
  onJump: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) {
        return;
      }
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      data-unread-strip=""
      className="sticky -top-4 z-[4] mx-4 -mt-4 mb-2 flex h-8 items-center gap-2 rounded-b-lg bg-surface-2 pl-3 pr-1.5 text-[13px] font-semibold text-text ring-1 ring-inset ring-border"
    >
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
      <span className="shrink-0 font-medium text-text-tertiary max-md:hidden">
        {t("chat.unread.escHint")}
      </span>
      <Button variant="ghost" size="sm" className="h-6 shrink-0 max-sm:hidden" onClick={onJump}>
        {t("chat.unread.jumpFirst")}
      </Button>
      <Button variant="secondary" size="sm" className="h-6 shrink-0" onClick={onDismiss}>
        {t("chat.markRead")}
      </Button>
    </div>
  );
}
