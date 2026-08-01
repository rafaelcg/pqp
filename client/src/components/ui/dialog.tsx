import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  title: string;
  /** Small label above the title, e.g. "Members". */
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  onClose: () => void;
  /** Set false for destructive flows that should not close on a stray click. */
  closeOnBackdrop?: boolean;
}

/**
 * Every modal in the app used to be a bare `<div>` overlay: no dialog role, no
 * Escape handling, no focus trap, and no focus restoration. This is the one
 * place that behaviour lives now.
 */
export function Dialog({
  open,
  title,
  eyebrow,
  description,
  children,
  footer,
  size = "md",
  onClose,
  closeOnBackdrop = true,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Callers pass inline arrows, so `onClose` has a new identity on every parent
  // render. Keeping it out of the effect's deps stops the trap from tearing down
  // and re-running — which would yank focus back to the first field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const focusables = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) {
      return [] as HTMLElement[];
    }
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Move focus in without stealing it from an element that autofocused.
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) {
        return;
      }
      (focusables()[0] ?? panel).focus();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // The trigger may have unmounted while the dialog was open.
      if (previouslyFocused.current?.isConnected) {
        previouslyFocused.current.focus();
      }
    };
  }, [open, focusables]);

  if (!open) {
    return null;
  }

  const width =
    size === "sm" ? "sm:max-w-md" : size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg";

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/80 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "animate-rise flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-4 bg-ink-2 shadow-2xl outline-none sm:rounded-2xl",
          width,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-4 px-5 py-4">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-xs uppercase tracking-[0.18em] text-signal">
                {eyebrow}
              </p>
            )}
            <h2 id={titleId} className="truncate font-display text-2xl font-bold">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-paper-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            className="shrink-0 rounded-md p-1.5 text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div className="safe-pb flex justify-end gap-2 border-t border-ink-4 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
