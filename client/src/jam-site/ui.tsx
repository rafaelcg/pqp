import { XIcon as X } from "./icons";
import { useEffect, useRef, type ReactNode } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { cn } from "./util";

/** The site's few primitives. Colours are role tokens only. */

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0";

export const buttonClass = {
  base: cn(
    "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-pill)] font-bold transition-[background-color,transform] duration-[var(--duration-fast)] active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
    FOCUS,
  ),
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface-2 text-text ring-1 ring-inset ring-border hover:bg-surface-3",
  ghost: "text-text-secondary hover:bg-surface-2 hover:text-text",
  md: "h-10 px-[18px] text-sm",
  lg: "h-[52px] px-7 text-base",
  icon: "h-10 w-10 text-text-secondary hover:bg-surface-2 hover:text-text",
} as const;

export function button(
  variant: "primary" | "secondary" | "ghost",
  size: "md" | "lg" = "md",
  extra?: string,
): string {
  return cn(buttonClass.base, buttonClass[variant], buttonClass[size], extra);
}

export const focusRing = FOCUS;

/**
 * A modal sheet on the platform's own `<dialog>`: it traps focus, closes on
 * Escape and returns focus to what opened it, all of which a hand-built one
 * gets wrong. A bottom sheet on a phone, a centred card from `sm` up.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
      data-jam-sheet=""
      className={cn(
        "m-0 w-full max-w-none bg-transparent p-0 text-text backdrop:bg-media-scrim/70 backdrop:backdrop-blur-[2px]",
        "fixed inset-x-0 bottom-0 top-auto sm:inset-0 sm:m-auto sm:h-fit sm:max-w-[28rem]",
      )}
    >
      {open && (
        <div className="relative rounded-t-[var(--radius-panel)] border border-border bg-surface-1 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-2)] sm:rounded-[var(--radius-panel)]">
          <button
            type="button"
            onClick={onClose}
            aria-label={jt("sheet.close")}
            className={cn(buttonClass.base, buttonClass.icon, "absolute right-3 top-3 h-9 w-9")}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse", className)}
    />
  );
}

/** Visible only to a screen reader. */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
