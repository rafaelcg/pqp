import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The hover/focus helper for a control whose whole visible content is an icon.
 *
 * WHY IT EXISTS. The chat shell has 28 `size="icon"` buttons; five carried a
 * native `title` and the other twenty-three gave a pointer nothing at all.
 * The system-audio toggle in the voice bar is what forced the issue: it
 * shipped with a correct `aria-label` and no hover affordance whatsoever, so
 * the person who commissioned it looked at his own control bar and could not
 * say what the button did. An icon is a mnemonic, not a name; it only works
 * once you have been told the name once.
 *
 * WHY NOT `title=`. The native tooltip waits about a second, cannot be styled,
 * truncates in some browsers, and never appears on keyboard focus — so it
 * helps exactly the users who need it least. It is also dead on any control
 * our `Button` has disabled, because `disabled:pointer-events-none` stops the
 * hover that would have summoned it. Every `title` this component replaced was
 * one of those two failures.
 *
 * TOUCH. A tooltip must never eat the first tap: a control that needs two taps
 * on a phone is worse than a control with no label. Radix's trigger bails out
 * of its own pointer-move handler when `pointerType === "touch"` and closes on
 * `pointerdown`, so on a touch device this component is inert and the tap goes
 * straight to the button. That is deliberate and it is the reason nothing here
 * adds a long-press or a tap-to-reveal: where a touch user genuinely needs the
 * explanation, the surface says it out loud instead (the voice bar's hint line
 * under the control row is the pattern), because a phone has no hover to hide
 * anything behind.
 *
 * SCREEN READERS. See `tooltipA11y` below — the short version is that the
 * tooltip is never announced twice.
 *
 * MOTION. The bubble reuses `animate-fade-in`, which `index.css` already
 * switches off under `prefers-reduced-motion: reduce`, so a reduced-motion
 * reader gets the same tooltip without the fade.
 */

/**
 * Wait before the first tooltip of a group opens.
 *
 * Short enough that hovering a button you are unsure about answers you, long
 * enough that dragging the pointer across the control bar on the way to
 * something else does not flash six bubbles. Radix's own default is 700ms,
 * which is the `title=` delay this exists to beat.
 */
const OPEN_DELAY_MS = 260;

/**
 * Once one tooltip in the tree has opened, its neighbours open with no delay
 * for this long. This is what makes a control bar readable: hover the mic,
 * wait once, then sweep the row and read every button.
 */
const SKIP_DELAY_MS = 500;

/** Keeps the bubble clear of the very edge of the window on every side. */
const COLLISION_PADDING = 8;

/**
 * Where the bubble is portalled. `null` is the ordinary case and means
 * `document.body`; anything else is the element the browser is currently
 * showing fullscreen.
 *
 * WHY THIS EXISTS. A fullscreen element is the ONLY thing the compositor
 * paints — a portal to `document.body` while a call stage is fullscreen puts
 * the tooltip somewhere nothing can see. That is exactly where the share and
 * fullscreen controls live, and it would be a regression against the native
 * `title` this component replaced, which the browser draws in its own chrome
 * and therefore survives fullscreen.
 *
 * One listener for the whole tree rather than one per tooltip: a channel with
 * fifty messages has several hundred `Tooltip`s mounted, and this is a global
 * fact about the document.
 */
const TooltipContainerContext = createContext<HTMLElement | null>(null);

function currentFullscreenHost(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  // Safari before 16.4 only has the prefixed name — the same pair
  // `screen-share-view.tsx` reads for the same reason.
  const element =
    document.fullscreenElement ??
    (document as Document & { webkitFullscreenElement?: Element | null })
      .webkitFullscreenElement ??
    null;
  // A `<video>` taken fullscreen (the iOS path) cannot host children, so fall
  // back to the body and accept that the tooltip is invisible there. Nothing
  // else can host a tooltip on iOS anyway.
  if (!(element instanceof HTMLElement) || element instanceof HTMLVideoElement) {
    return null;
  }
  return element;
}

/**
 * Required ancestor for every `Tooltip`. Mounted once, at the root, so the
 * whole app shares one open-delay group; a per-tooltip provider would make
 * every button in a row wait its own 260ms.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(currentFullscreenHost);

  useEffect(() => {
    const sync = () => setHost(currentFullscreenHost());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    // Entering fullscreen can resolve after the event in some engines; one
    // resync on mount covers a stage that was already fullscreen.
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  return (
    <TooltipPrimitive.Provider
      delayDuration={OPEN_DELAY_MS}
      skipDelayDuration={SKIP_DELAY_MS}
      // The bubble holds no links and no controls, so there is nothing in it
      // to move the pointer into. Leaving it hoverable would only let it
      // survive over whatever it is covering.
      disableHoverableContent
    >
      <TooltipContainerContext.Provider value={host}>
        {children}
      </TooltipContainerContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipA11yProps {
  /**
   * The tooltip's visible text, and by default the control's accessible name
   * too. A short noun or verb phrase, no full stop: "Mute microphone", not a
   * sentence. A tooltip is a label, not documentation.
   */
  label: string;
  /**
   * A second, quieter line for a control that is genuinely non-obvious — what
   * it will do, or what it will cost. Deliberately an opt-in rather than the
   * default: a paragraph on every button is a paragraph nobody reads. As of
   * writing, three controls in the whole app have earned one.
   */
  detail?: string;
  /**
   * Accessible name, when it has to differ from the visible text. Only for the
   * case where a screen reader needs a disambiguator the sighted user gets
   * from context: "Kick: rafa" on one row of a member list, where the tooltip
   * next to the pointer only needs to say "Kick".
   */
  name?: string;
}

export interface TooltipA11y {
  /** Goes on the control as `aria-label`. */
  name: string;
  /**
   * Goes on Radix's content as `aria-label`, which swaps what assistive tech
   * announces for the `aria-describedby` target. `undefined` means the tooltip
   * contributes no description at all.
   */
  description: string | undefined;
  /**
   * Whether the trigger keeps the `aria-describedby` link Radix puts on it.
   * False strips it.
   */
  describedBy: boolean;
}

/**
 * How one tooltip's text is split between the name and the description.
 *
 * THE PROBLEM. Radix wires the trigger to the bubble with `aria-describedby`
 * whenever the tooltip is open, and a tooltip opens on focus. If the bubble
 * says the same thing as the button's `aria-label` — which is the normal case,
 * because the label *is* the tooltip — a screen reader reads it as the name and
 * then again as the description: "Mute microphone, button, Mute microphone".
 *
 * THE FIX, in Radix's own documented terms. `Tooltip.Content` takes an
 * `aria-label` that replaces what assistive tech announces for the bubble.
 * So:
 *
 * - With a `detail`, the description is the detail *only*. The reader hears the
 *   name once, then the extra sentence the sighted user is reading below it.
 * - Without one, there is no description to give: the bubble is the name,
 *   repeated. The trigger's `aria-describedby` is dropped instead of pointed at
 *   a duplicate, which is also just true — this control has a name and nothing
 *   more to say about it.
 *
 * Either way the copy has one source: whatever is passed here. The old shape,
 * where a button carried an `aria-label` and a `title` that had to agree, is
 * exactly how the two drift apart.
 */
export function tooltipA11y({
  label,
  detail,
  name,
}: TooltipA11yProps): TooltipA11y {
  // Empty counts as absent, deliberately. Radix falls back to announcing the
  // bubble's own text when `aria-label` is falsy, so an empty detail would not
  // give the control a blank description — it would restore the duplicate this
  // function exists to remove.
  const description = detail ? detail : undefined;
  return {
    name: name ?? label,
    description,
    describedBy: description !== undefined,
  };
}

export interface TooltipProps extends TooltipA11yProps {
  /** Which side of the control the bubble sits on. Defaults to above it. */
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /**
   * `rail` is the server-list bubble: a bit larger, darker, and further from
   * the tile, the way Discord names a server on hover. Default is the compact
   * label on icon buttons in a bar.
   */
  tone?: "default" | "rail";
  /**
   * The control. Must be a single element that forwards props and a ref to a
   * real DOM node — our `Button`, or a plain `<button>`.
   */
  children: ReactElement;
}

export function Tooltip({
  label,
  detail,
  name,
  side = "top",
  align = "center",
  tone = "default",
  children,
}: TooltipProps) {
  const a11y = tooltipA11y({ label, detail, name });
  const container = useContext(TooltipContainerContext);
  const rail = tone === "rail";

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        asChild
        // The name lives here rather than on the child, so a button's label and
        // its tooltip cannot say different things. Call sites pass copy to this
        // component and to nothing else.
        aria-label={a11y.name}
        // Radix sets `aria-describedby` on the trigger before spreading the
        // props given to it, so this is the supported way to take it back off.
        {...(a11y.describedBy ? null : { "aria-describedby": undefined })}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container ?? undefined}>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={rail ? 12 : 6}
          collisionPadding={COLLISION_PADDING}
          aria-label={a11y.description}
          className={cn(
            // Above the emoji picker and the profile popover, which are the
            // tallest things a tooltipped button can sit next to, and matching
            // the reaction tip in `message-list.tsx` so the two read as one
            // object rather than two house styles.
            "z-[140] max-w-64 select-none text-paper shadow-[var(--shadow-popover)] animate-fade-in",
            rail
              ? "rounded-lg border border-ink-3 bg-ink px-2.5 py-1.5 text-[13px] font-semibold leading-snug"
              : "rounded-md border border-ink-4 bg-ink-2 px-2 py-1 text-xs leading-snug",
            // Never intercept a click aimed at what is underneath. The bubble
            // is placed over the stage, and a swallowed click on a call
            // control is a worse bug than a missing label.
            "pointer-events-none",
          )}
        >
          {label}
          {detail && (
            <span className="mt-1 block text-[11px] text-paper-muted">
              {detail}
            </span>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
