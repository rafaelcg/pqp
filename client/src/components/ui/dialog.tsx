import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// A roving group (radios, tabs) parks its other members at `tabindex="-1"`:
// they are focusable by script but not Tab stops, so they are not the trap's
// first or last stop either.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]",
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(", ");

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
  title: ReactNode;
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
  /**
   * Rise into place on mount (the default). Set false when this panel takes
   * over from another one that already rose in the same spot, so a two-part
   * flow reads as one window: the first-run age gate hands over to the wizard
   * this way, and a second entrance there is what made the two look like two
   * dialogs.
   */
  entrance?: boolean;
  /**
   * For a multi-step dialog: changing this slides the eyebrow, title and
   * description in with the step's body, instead of swapping the words while
   * the body animates. Omitted, the header never animates.
   */
  headerKey?: string;
  /**
   * Classes for the title band, merged over its default padding. Settings uses
   * it for a 56px band; every other dialog leaves it alone.
   */
  headerClassName?: string;
  /**
   * One control in the title band, before the close button: the forum
   * composer's Publicar on a phone, where the band is the part of a bottom
   * sheet the keyboard never covers (the layer is sized to the visual
   * viewport, so the band stays on screen above the keyboard).
   */
  headerAction?: ReactNode;
  /**
   * On a phone, the whole screen instead of a bottom sheet, with the title
   * band of a native editor: close on the left, the title in the middle,
   * `headerAction` on the right. For a form someone writes in (the forum's
   * Novo post): a sheet left the list peeking above a keyboard-sized form.
   */
  phoneFullScreen?: boolean;
}

/** How long a chosen menu row may still name the opener of a dialog. */
const CHOSEN_MENU_ROW_MS = 1_000;

let chosenMenuTrigger: { element: HTMLElement; at: number } | null = null;

/**
 * A menu row was chosen. A dialog it opens may mount after the menu is gone,
 * with focus on <body>, and that dialog still has to return focus to this
 * trigger when it closes.
 */
export function noteMenuRowChosen(trigger: HTMLElement | null): void {
  chosenMenuTrigger = trigger ? { element: trigger, at: Date.now() } : null;
}

/**
 * Where focus goes back to when the dialog closes. A menu row that opened the
 * dialog unmounts with its menu, so the menu's trigger stands in for it (Radix
 * labels the menu with the trigger's id). When the menu has already unmounted,
 * the row chosen a moment ago names it.
 */
export function dialogOpener(active: HTMLElement | null): HTMLElement | null {
  // Read, not consumed: a render can run twice, and both must agree.
  const chosen = chosenMenuTrigger;
  const menu = active?.closest?.('[role="menu"][aria-labelledby]');
  if (menu) {
    return document.getElementById(menu.getAttribute("aria-labelledby") ?? "") ?? active;
  }
  if (
    (!active || active === document.body) &&
    chosen &&
    chosen.element.isConnected &&
    Date.now() - chosen.at < CHOSEN_MENU_ROW_MS
  ) {
    return chosen.element;
  }
  return active;
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
  entrance = true,
  headerKey,
  headerClassName,
  headerAction,
  phoneFullScreen = false,
}: DialogProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // The opener is read while rendering the open dialog, before any child
  // mounts: a child with `autoFocus` (ConfirmDialog's buttons) takes focus
  // during commit, and read in the effect the "opener" was that child, gone
  // on close, so focus fell to the page.
  const openedRef = useRef(false);
  if (open && !openedRef.current) {
    openedRef.current = true;
    previouslyFocused.current =
      typeof document === "undefined"
        ? null
        : dialogOpener(document.activeElement as HTMLElement | null);
  } else if (!open) {
    openedRef.current = false;
  }
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

    if (previouslyFocused.current && panelRef.current?.contains(previouslyFocused.current)) {
      previouslyFocused.current = null;
    }

    // Move focus in without stealing it from an element that autofocused.
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) {
        return;
      }
      const first = focusables()[0];
      // On a touch screen, focusing a text field opens the keyboard over the
      // dialog the person has not read yet. Focus the panel instead (the trap
      // still holds); a field that asked for it with `autoFocus` already has
      // focus and never reaches here.
      const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      const typesText =
        first instanceof HTMLTextAreaElement ||
        (first instanceof HTMLInputElement &&
          !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color"].includes(first.type));
      (coarse && typesText ? panel : (first ?? panel)).focus();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function isTopLayer(): boolean {
      const layer = panelRef.current?.closest("[data-dialog-layer]");
      const layers = document.querySelectorAll("[data-dialog-layer]");
      return !layer || layers[layers.length - 1] === layer;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopLayer()) {
        return;
      }
      if (event.key === "Escape") {
        if (
          event.target instanceof Element &&
          event.target.closest('[role="menu"]')
        ) {
          return;
        }
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
      } else if (
        !event.shiftKey &&
        (active === last || !panelRef.current?.contains(active))
      ) {
        // Also when focus fell out of the panel (a focused button that
        // unmounted leaves it on <body>): Tab must not walk into the app
        // behind the dialog.
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
        className="fixed inset-0 z-[60] bg-surface-0/80 backdrop-blur-[2px]"
      />
      <div
        data-dialog-layer=""
        className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
        style={layerStyle}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          // A press on the backdrop never moves focus to the page: after a
          // close that handed it back to the opener, and on a dialog the
          // backdrop does not close, where it would leave the dialog open with
          // focus outside it.
          event.preventDefault();
          if (dismissible && closeOnBackdrop) {
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
            entrance && "animate-rise",
            "elevation-3 flex max-h-[calc(100%-1.5rem)] w-full max-w-full flex-col overflow-hidden outline-none sm:max-h-full sm:rounded-[var(--radius-panel)]",
            // A sheet rounds its top corners; a full-screen phone dialog has
            // no corners to round.
            !phoneFullScreen && "rounded-t-[var(--radius-panel)]",
            fill && "h-[calc(100%-1.5rem)] sm:h-full",
            phoneFullScreen && "max-sm:h-full max-sm:max-h-full max-sm:border-0",
            width,
          )}
        >
          <div
            className={cn(
              "flex items-start justify-between gap-3 border-b border-border px-5 py-4",
              phoneFullScreen &&
                "max-sm:items-center max-sm:gap-2 max-sm:px-3 max-sm:pb-2 max-sm:pt-[max(0.5rem,env(safe-area-inset-top))]",
              headerClassName,
            )}
          >
            {phoneFullScreen && dismissible && (
              <button
                type="button"
                aria-label={t("a11y.closeDialog")}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text sm:hidden"
                onClick={onClose}
              >
                <X className="h-5 w-5" />
              </button>
            )}
            <div
              key={headerKey}
              className={cn(
                "min-w-0",
                phoneFullScreen && "max-sm:flex-1 max-sm:text-center",
                headerKey !== undefined && "animate-step-in",
              )}
            >
              {eyebrow && (
                <p
                  className={cn(
                    "text-xs uppercase tracking-[0.18em] text-accent",
                    phoneFullScreen && "max-sm:hidden",
                  )}
                >
                  {eyebrow}
                </p>
              )}
              <h2
                id={titleId}
                className={cn(
                  "min-w-0 font-display text-2xl font-bold",
                  phoneFullScreen && "max-sm:text-[17px] max-sm:leading-6",
                )}
              >
                {/* Two lines and then an ellipsis, never one. A phone used to
                    cut the age gate's own title mid-word, and a rule the
                    reader cannot read is not a rule they agreed to. */}
                {typeof title === "string" ? (
                  <span className="line-clamp-2 block text-balance [overflow-wrap:anywhere]">
                    {title}
                  </span>
                ) : (
                  title
                )}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-pretty text-sm text-text-tertiary">
                  {description}
                </p>
              )}
            </div>
            {headerAction && (
              <div
                className={cn(
                  "ml-auto flex shrink-0 items-center self-center",
                  phoneFullScreen && "max-sm:ml-0",
                )}
              >
                {headerAction}
              </div>
            )}
            {phoneFullScreen && !headerAction && (
              // Keeps the title centred against the close button.
              <span aria-hidden className="w-11 shrink-0 sm:hidden" />
            )}
            {dismissible && (
              <button
                type="button"
                aria-label={t("a11y.closeDialog")}
                // 28px drawn, 44px to a finger on a phone: the hit area grows,
                // the icon does not.
                className={cn(
                  "relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']",
                  // A full-screen phone dialog closes from the left.
                  phoneFullScreen && "max-sm:hidden",
                )}
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overscroll-contain",
              // `clip`, not `hidden`: a hidden box can still be scrolled from
              // code, and focusing a control mid-animation (the settings save
              // bar) scrolled the whole body away with no way back.
              fill ? "overflow-clip" : "overflow-y-auto",
            )}
          >
            {children}
          </div>

          {footer && (
            <div className="safe-pb flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * The standard padding for a dialog's body.
 *
 * `Dialog` deliberately does not pad its own children, because several
 * dialogs are full-bleed on purpose (the settings modals' section rail, the
 * attachment lightbox, the search chrome). The cost of that is that every
 * ordinary dialog has to remember `px-5 py-4`, and the ones that forget look
 * broken in a specific way: the copy and the fields run flush into the border,
 * which is what a 2026-09-08 review caught in four dialogs at once, two of
 * them added the same day.
 *
 * So the padding gets a name. A dialog with ordinary content wraps its
 * children in this and cannot forget; a full-bleed one keeps doing what it
 * does. `dialog-body.test.ts` scans for the ones that do neither.
 *
 * The values match the header and footer above (`px-5 py-4`), which is what
 * makes the three read as one panel rather than three.
 */
export function DialogBody({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "className" | "children">) {
  return (
    <div className={cn("px-5 py-4", className)} {...rest}>
      {children}
    </div>
  );
}
