import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ViewportBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function readViewport(): ViewportBox | null {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) {
    return null;
  }
  return {
    left: viewport.offsetLeft,
    top: viewport.offsetTop,
    width: viewport.width,
    height: viewport.height,
  };
}

function sameBox(a: ViewportBox | null, b: ViewportBox | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * The *visible* rectangle, which is not `100vw`/`100vh` and not `inset-0`.
 *
 * A `position: fixed` box is laid out against the layout viewport, and on a
 * phone that is routinely bigger than what the user can actually see:
 *
 * - iOS Safari magnifies the page when a focused field's text is under 16px.
 *   The layout viewport keeps its 390px, the visual viewport shrinks to ~341px
 *   and scrolls sideways to follow the caret — so a centred `inset-0` overlay
 *   hangs off *both* edges and the first characters of the title are simply not
 *   on the screen. (The stylesheet keeps fields at 16px inside a dialog so this
 *   should not fire at all now; tracking the viewport is what makes a deliberate
 *   pinch-zoom survivable too.)
 * - The on-screen keyboard covers the bottom third without changing `vh`, `dvh`
 *   or `innerHeight`, so a dialog sized in viewport units puts its footer — the
 *   buttons the flow exists for — underneath it.
 *
 * `visualViewport` is the only thing that reports either. Absent it (very old
 * browsers), the Tailwind `inset-0` underneath stays in force.
 */
function useVisualViewport(open: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(() =>
    open ? readViewport() : null,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    // Bail out of the state update when nothing moved: `scroll` fires on every
    // frame of a pinch and re-rendering the whole dialog under the user's
    // finger is what makes that feel broken.
    const sync = () => {
      const next = readViewport();
      setBox((current) => (sameBox(current, next) ? current : next));
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [open]);

  return box;
}

interface DialogProps {
  open: boolean;
  title: string;
  /** Small label above the title, e.g. "Members". */
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /**
   * Give the panel the whole layer's height and stop the body scrolling itself.
   *
   * For a dialog whose content is its own layout — settings has a fixed section
   * rail beside a scrolling pane — a body that scrolls as one column would carry
   * the rail off the top of the screen. With this set the children own their
   * scrollers, and the panel stops resizing as sections of different lengths
   * swap in, which is what makes the rail feel like furniture rather than part
   * of the page.
   */
  fill?: boolean;
  onClose: () => void;
  /** Set false for destructive flows that should not close on a stray click. */
  closeOnBackdrop?: boolean;
  /**
   * Set false for a dialog the user genuinely cannot leave — a blocking step,
   * not a form they might abandon. It removes the close affordance entirely
   * (button, Escape and backdrop) rather than leaving an X that does nothing,
   * which is worse than no X at all: it reads as a bug and invites the user to
   * keep clicking it.
   */
  dismissible?: boolean;
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
  fill = false,
  onClose,
  closeOnBackdrop = true,
  dismissible = true,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Callers pass inline arrows, so `onClose` has a new identity on every parent
  // render. Keeping it out of the effect's deps stops the trap from tearing down
  // and re-running — which would yank focus back to the first field mid-typing.
  const viewport = useVisualViewport(open);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Same reason as `onCloseRef`: read through a ref so flipping it cannot tear
  // down the focus trap mid-interaction.
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

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
        if (dismissibleRef.current) {
          onCloseRef.current();
        }
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

  // The keyboard opening is a resize, and the field the user just tapped is
  // usually the thing it covered. Scrolling it back into the dialog's own
  // scroller costs nothing when it is already visible.
  const visibleHeight = viewport?.height;
  useEffect(() => {
    if (!open || visibleHeight === undefined) {
      return;
    }
    const panel = panelRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== panel && panel?.contains(active)) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [open, visibleHeight]);

  if (!open) {
    return null;
  }

  const width =
    size === "sm"
      ? "sm:max-w-md"
      : size === "lg"
        ? "sm:max-w-2xl"
        : size === "xl"
          ? "sm:max-w-4xl"
          : "sm:max-w-lg";

  // `right`/`bottom` are cleared because Tailwind's `inset-0` — the fallback
  // when there is no `visualViewport` — would otherwise over-constrain the box.
  const layerStyle: CSSProperties | undefined = viewport
    ? {
        left: viewport.left,
        top: viewport.top,
        right: "auto",
        bottom: "auto",
        width: viewport.width,
        height: viewport.height,
      }
    : undefined;

  return createPortal(
    <>
      {/* Painted over the whole layout viewport rather than the visible slice:
          when the keyboard or a zoom shrinks the latter, a backdrop that
          tracked it would leave the app showing in the gap. It is inert — the
          layer below owns the dismiss gesture. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-[60] bg-ink/80 backdrop-blur-[2px]"
      />
      <div
        data-dialog-layer=""
        className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
        style={layerStyle}
        onMouseDown={(event) => {
          if (dismissible && closeOnBackdrop && event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div
          ref={panelRef}
          data-dialog-panel=""
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            // Heights are a percentage of the layer, which is the visible
            // rectangle — never `vh`, which no browser shrinks for a keyboard.
            "animate-rise flex max-h-[calc(100%-1.5rem)] w-full max-w-full flex-col overflow-hidden rounded-t-2xl border border-ink-4 bg-ink-2 shadow-2xl outline-none sm:max-h-full sm:rounded-2xl",
            fill && "h-[calc(100%-1.5rem)] sm:h-full",
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
            {dismissible && (
              <button
                type="button"
                aria-label="Close dialog"
                className="shrink-0 rounded-md p-1.5 text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overscroll-contain",
              fill ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            {children}
          </div>

          {footer && (
            <div className="safe-pb flex shrink-0 flex-wrap justify-end gap-2 border-t border-ink-4 px-5 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
