import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one shell every corner card wears.
 *
 * QG, the mobile beta invite, What's new, the cargos tip and the update
 * prompt used to each draw their own frame: five radii, three shadows, two
 * z-indexes, one with no entrance at all. This is the frame, once: bottom
 * right on a desktop, full width above the safe area on a phone, a pop in
 * (rise + fade) on mount and a short fade out on close so the corner never
 * blinks. Escape closes. Reduced motion keeps the cards and drops the
 * movement.
 *
 * `open` false starts the exit; the card unmounts itself when the animation
 * ends, so a parent can flip the flag and forget. A `hero` (image, live
 * component preview) sits above the copy with the close button floating on
 * it; without one the close button sits in the title row.
 */

const EXIT_MS = 180;

export function CornerCard({
  open,
  onClose,
  label,
  hero,
  title,
  body,
  children,
  footer,
  dismissLabel,
  tone = "default",
  dataAttribute,
}: {
  open: boolean;
  onClose: () => void;
  /** aria-label of the landmark. */
  label: string;
  hero?: ReactNode;
  title?: ReactNode;
  body?: ReactNode;
  /** Anything between the copy and the footer: a preview, a slide. */
  children?: ReactNode;
  footer?: ReactNode;
  dismissLabel: string;
  /** `status` renders as a live region (the update prompt). */
  tone?: "default" | "status";
  /** A `data-*` hook for tests, e.g. `data-corner-card="qg"`. */
  dataAttribute?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) {
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!mounted) {
    return null;
  }

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label={dismissLabel}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        hero
          ? "absolute right-2 top-2 z-10 bg-ink/70 text-paper backdrop-blur-sm hover:bg-ink hover:text-paper"
          : "-mr-1 -mt-1 text-paper-muted hover:bg-ink-3 hover:text-paper",
      )}
    >
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  );

  return (
    <aside
      role={tone === "status" ? "status" : undefined}
      aria-label={label}
      data-corner-card={dataAttribute ?? ""}
      className={cn(
        "safe-pb fixed inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]",
        leaving ? "animate-pop-out" : "animate-pop-in",
      )}
    >
      <div className="relative overflow-hidden rounded-2xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)]">
        {hero && (
          <div
            aria-hidden
            // On a phone the card is the whole width of the screen, so a
            // 10rem hero is most of what the person sees; cap it there.
            className="relative max-h-28 overflow-hidden bg-ink-1 sm:max-h-none"
          >
            {hero}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ink-2 to-transparent" />
          </div>
        )}
        {hero && closeButton}
        <div className="p-4">
          {(title || !hero) && (
            <div className="flex items-start gap-2">
              {title && (
                <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-paper">
                  {title}
                </h2>
              )}
              {!hero && closeButton}
            </div>
          )}
          {body && (
            <p className="mt-1.5 text-pretty text-sm leading-relaxed text-paper-muted">
              {body}
            </p>
          )}
          {children}
          {footer && <div className="mt-3">{footer}</div>}
        </div>
      </div>
    </aside>
  );
}
