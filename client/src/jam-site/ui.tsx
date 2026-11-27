import { XIcon as X } from "./icons";
import { useEffect, useRef, type ReactNode } from "react";
import { coverPage } from "./cover";
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
  md: "h-11 px-[18px] text-sm",
  lg: "h-[52px] px-7 text-base",
  icon: "h-11 w-11 text-text-secondary hover:bg-surface-2 hover:text-text",
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
 *
 * `open` is the owner's state and it has to follow the dialog's real one, however the
 * dialog closed: the X, the backdrop, Escape, the Android back gesture, `close()`. An owner
 * left believing the sheet is open can never open it again, because setting `open` to what
 * it already is does nothing. The `close` event is NOT enough on its own: Chrome closes a
 * dialog dismissed by Escape or back (its close watcher) after a `cancel` event and a
 * `toggle` event, and was measured not firing `close` at all (Chrome 158, a bare dialog).
 * So the owner hears about all three, and about a request to open that arrives while it
 * still thinks it is open (`nonce`, bumped on every ask), which is the same fault seen from
 * the other side.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  nonce,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Changes on every request to open, so a request made while `open` is stale still opens it. */
  nonce?: number;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  // An open sheet covers the page: whatever is playing under it pauses (`cover.ts`).
  useEffect(() => (open ? coverPage() : undefined), [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, nonce]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    let timer: number | undefined;
    // Tells the owner only when the dialog really is closed: a `cancel` somebody prevented leaves it open.
    const settle = () => {
      if (!dialog.open) onClose();
    };
    // `cancel` fires before the dialog closes, so look after it has.
    const cancelled = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, 0);
    };
    dialog.addEventListener("close", settle);
    dialog.addEventListener("cancel", cancelled);
    dialog.addEventListener("toggle", settle);
    return () => {
      window.clearTimeout(timer);
      dialog.removeEventListener("close", settle);
      dialog.removeEventListener("cancel", cancelled);
      dialog.removeEventListener("toggle", settle);
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
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
            className={cn(buttonClass.base, buttonClass.icon, "absolute right-2 top-2")}
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
