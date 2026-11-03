import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import { useRedesign } from "@/lib/redesign";

/** Lines past which a message folds, and the lines it folds to. */
export const FOLD_AFTER_LINES = 12;
export const FOLDED_LINES = 8;

/**
 * Under the redesign, someone else's message taller than twelve lines folds
 * to eight with "Mostrar tudo" (the text channels canvas, "Mensagem bem
 * longa"). Your own messages are never folded. With the toggle off this
 * renders its children and nothing else.
 */
export function MessageFold({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const redesign = useRedesign();
  if (!redesign || !enabled) {
    return <>{children}</>;
  }
  return <Fold>{children}</Fold>;
}

function Fold({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) {
      return;
    }
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight) || 22;
      setTall(node.scrollHeight > lineHeight * FOLD_AFTER_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, children]);

  const folded = tall && !open;
  return (
    <>
      <div
        ref={ref}
        data-message-fold={folded ? "folded" : undefined}
        className={folded ? "pqp-message-folded" : undefined}
      >
        {children}
      </div>
      {folded && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-0.5 rounded text-[length:var(--chat-font-size)] font-medium text-[color:var(--color-accent-text)] underline decoration-[color:var(--content-link-line)] underline-offset-2 hover:decoration-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("chat.showAll")}
        </button>
      )}
    </>
  );
}
