import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import * as React from "react";
import { Icon, type IconKind } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * A banner: a strip that states something about the whole app or the
 * conversation (the connection dropped, an error, a call about to hang up,
 * a handle claimed, a timeout) and stays until it is no longer true or is
 * dismissed.
 *
 * With the toggle off it draws the full-width tinted bar every strip already
 * drew: a 10% tone fill, a 40% tone rule on its inner edge, tone text. A
 * strip whose bar was different (a 30% rule, smaller text, centred) passes
 * those classes and `cn` keeps them.
 *
 * Under the redesign every strip is the same thing: an inset rounded card on
 * the look's soft tone fill, with a faint tone edge, the message in the text
 * colour, the icon and the actions in the tone's ink, and pill actions. The
 * strings are written out per tone because Tailwind only generates classes
 * it can read in the source.
 */
export type BannerTone = "warning" | "danger" | "success" | "accent";

/** The tone's three colours under the redesign: fill, ink, edge. */
const TONE_VARS: Record<BannerTone, string> = {
  warning:
    "redesign:[--banner-fill:var(--color-warning-soft)] redesign:[--banner-ink:var(--color-on-warning-soft)] redesign:[--banner-tone:var(--color-warning)]",
  danger:
    "redesign:[--banner-fill:var(--color-danger-soft)] redesign:[--banner-ink:var(--color-on-danger-soft)] redesign:[--banner-tone:var(--color-danger)]",
  success:
    "redesign:[--banner-fill:var(--color-success-soft)] redesign:[--banner-ink:var(--color-on-success-soft)] redesign:[--banner-tone:var(--color-success)]",
  accent:
    "redesign:[--banner-fill:var(--color-accent-soft)] redesign:[--banner-ink:var(--color-on-accent-soft)] redesign:[--banner-tone:var(--color-accent)]",
};

const TONE: Record<BannerTone, string> = {
  warning: `border-warning/40 bg-warning/10 text-warning ${TONE_VARS.warning}`,
  danger: `border-danger/40 bg-danger/10 text-danger ${TONE_VARS.danger}`,
  success: `border-success/40 bg-success/10 text-success ${TONE_VARS.success}`,
  accent: `border-accent/40 bg-accent/10 text-accent ${TONE_VARS.accent}`,
};

/** The edge the strip sits against: under the header, or above the composer. */
const EDGE = {
  top: "border-b redesign:mt-2",
  bottom: "border-t redesign:mb-2",
} as const;

/** The card alone: inset, corner, the tone's fill and edge, the text colour. */
const BANNER_CARD_REDESIGN =
  "redesign:mx-2 redesign:sm:mx-4 redesign:rounded-[var(--banner-radius)] redesign:border redesign:border-[color:color-mix(in_oklab,var(--banner-tone)_var(--banner-edge),transparent)] redesign:bg-[color:var(--banner-fill)] redesign:px-3 redesign:py-2 redesign:text-start redesign:text-sm redesign:text-text";

export const BANNER_REDESIGN = `redesign:flex redesign:flex-wrap redesign:items-start redesign:justify-start redesign:gap-x-3 redesign:gap-y-1.5 ${BANNER_CARD_REDESIGN}`;

/**
 * The banner's card under the redesign, for a strip that keeps its own
 * markup (the arrival strip with its confetti, the watch-now strip with its
 * faces). Append it after the strip's own classes; with the toggle off it
 * adds nothing. The strip's text takes `text-text`, its tone glyphs
 * `var(--banner-ink)`.
 */
export function bannerSurfaceRedesign(
  tone: BannerTone,
  edge: keyof typeof EDGE = "top",
  { layout = true }: { layout?: boolean } = {},
): string {
  return cn(
    TONE_VARS[tone],
    // `layout: false` for a strip that stacks rows of its own inside the card.
    layout ? BANNER_REDESIGN : BANNER_CARD_REDESIGN,
    edge === "top" ? "redesign:mt-2" : "redesign:mb-2",
  );
}

/** A round dismiss in a strip's corner, in the tone's ink. */
export const BANNER_DISMISS_REDESIGN =
  "redesign:rounded-full redesign:text-[color:var(--banner-ink)] redesign:hover:bg-[color:color-mix(in_oklab,var(--banner-ink)_16%,transparent)] redesign:hover:text-[color:var(--banner-ink)] redesign:focus-visible:ring-[color:var(--color-focus-ring)]";

const BannerToneContext = React.createContext<BannerTone>("warning");

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: BannerTone;
  edge?: keyof typeof EDGE;
  /**
   * Drawn only under the redesign, in the tone's ink, so every strip leads
   * with one. A strip that drew its own icon with the toggle off hides that
   * one under the redesign (`redesign:hidden`).
   */
  icon?: PhosphorIcon;
  /** `symbol` for a glyph that fills into a blob (the wifi arcs). */
  iconKind?: IconKind;
}

export function Banner({
  tone,
  edge = "top",
  icon,
  iconKind = "object",
  role = "status",
  className,
  children,
  ...rest
}: BannerProps) {
  return (
    <BannerToneContext.Provider value={tone}>
      <div
        role={role}
        data-banner={tone}
        className={cn(
          "flex items-start gap-3 px-4 py-2 text-sm",
          EDGE[edge],
          TONE[tone],
          className,
          BANNER_REDESIGN,
        )}
        {...rest}
      >
        {icon ? (
          <Icon
            icon={icon}
            kind={iconKind}
            size="sm"
            className="hidden shrink-0 redesign:mt-1.5 redesign:block redesign:text-[color:var(--banner-ink)]"
          />
        ) : null}
        {children}
      </div>
    </BannerToneContext.Provider>
  );
}

/**
 * The message. It takes the room the actions leave; under the redesign it
 * keeps at least 10rem (or the whole line), so on a phone two actions wrap
 * under it instead of squeezing it into a column.
 *
 * `grow={false}` for a strip whose message did not grow with the toggle off
 * (the connection strip is centred).
 */
export function BannerText({
  grow = true,
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { grow?: boolean }) {
  return (
    <span
      className={cn(
        grow && "flex-1",
        className,
        "redesign:min-w-[min(100%,10rem)] redesign:flex-1 redesign:py-1",
      )}
      {...rest}
    />
  );
}

/** Two actions side by side; under the redesign they sit at the end. */
export function BannerActions({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(className, "redesign:ml-auto")} {...rest} />;
}

/*
 * The old fill action was the tone at 20%, 30% on hover; written per tone.
 */
const FILL: Record<BannerTone, string> = {
  warning: "bg-warning/20 hover:bg-warning/30",
  danger: "bg-danger/20 hover:bg-danger/30",
  success: "bg-success/20 hover:bg-success/30",
  accent: "bg-accent/20 hover:bg-accent/30",
};

/** The main way out's redesign fill: the tone's ink, the label in its fill. */
const FILL_INK =
  "redesign:border-0 redesign:bg-[color:var(--banner-ink)] redesign:text-[color:var(--banner-fill)] redesign:hover:bg-[color:color-mix(in_oklab,var(--banner-ink)_88%,var(--color-text))]";

const ACTION_REDESIGN =
  "redesign:ml-auto redesign:inline-flex redesign:h-7 redesign:shrink-0 redesign:items-center redesign:rounded-[var(--radius-pill)] redesign:px-3 redesign:text-xs redesign:font-semibold redesign:no-underline redesign:transition-colors redesign:duration-[var(--duration-fast)] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--color-focus-ring)] redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-[color:var(--banner-fill)]";

const ACTION = {
  /** The main way out: "Tentar agora", "Entrar de novo". */
  fill: `rounded-[var(--radius-control)] px-2 py-0.5 font-semibold ${FILL_INK}`,
  /** A second action beside it: "Verificar". */
  quiet:
    "rounded-[var(--radius-control)] px-2 py-0.5 font-semibold underline-offset-2 hover:underline redesign:text-[color:var(--banner-ink)] redesign:hover:bg-[color:color-mix(in_oklab,var(--banner-ink)_16%,transparent)]",
  /** Dismiss, or the one plain action a strip offers ("Ainda tô aqui"). */
  link: "shrink-0 text-xs underline underline-offset-2 redesign:text-[color:var(--banner-ink)] redesign:hover:bg-[color:color-mix(in_oklab,var(--banner-ink)_16%,transparent)]",
} as const;

/**
 * The banner's main-action look under the redesign, for a button the banner
 * did not draw (the share button after a handle claim). With the toggle off
 * it adds nothing.
 */
export const BANNER_FILL_REDESIGN = `${ACTION_REDESIGN} ${FILL_INK}`;

export interface BannerActionProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  emphasis?: keyof typeof ACTION;
  /**
   * Draw as the main way out under the redesign only, for an action whose
   * toggle-off look is the plain link but which is the one thing that
   * matters in its strip ("Ainda tô aqui" stops a hangup).
   */
  prominent?: boolean;
}

export function BannerAction({
  emphasis = "link",
  prominent = false,
  type = "button",
  className,
  ...rest
}: BannerActionProps) {
  const tone = React.useContext(BannerToneContext);
  return (
    <button
      type={type}
      className={cn(
        ACTION[emphasis],
        emphasis === "fill" && FILL[tone],
        className,
        ACTION_REDESIGN,
        prominent && FILL_INK,
      )}
      {...rest}
    />
  );
}
