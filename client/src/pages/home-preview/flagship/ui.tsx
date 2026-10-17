import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useInView } from "../shared/motion";
import "./cinema/cinema.css";
import { Reveal as KitReveal } from "./cinema/reveal";

export { CREATE_INTENT, IMPORT_INTENT } from "../shared/auth-buttons";

/**
 * The flagship's type and layout scale. Every section composes these so the
 * page reads as one piece. Accent (signal) is for live states, CTAs and one
 * highlighted phrase per headline; nothing else.
 */

export const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

/* ------------------------------------------------------------------ Copy */

/** The create CTA. Always with `CREATE_INTENT`. */
export const CTA_CREATE = "Criar a sala da galera";
/** The import CTA. Always with `IMPORT_INTENT`. */
export const CTA_IMPORT = "Trazer do Discord";
/** The one line under a CTA pair (hero, Mudança, Fim). */
export const FREE_LINE = "De graça, sem cartão. Entra com Google, Apple ou Twitch.";

/**
 * `FREE_LINE` as a paragraph, broken between its two sentences when it has to
 * wrap, so a phone never leaves "ou Twitch." alone on the second line.
 */
export function FreeLine({ className }: { className?: string }) {
  const cut = FREE_LINE.indexOf(". ");
  return (
    <p className={className}>
      {cut < 0 ? (
        FREE_LINE
      ) : (
        <>
          {FREE_LINE.slice(0, cut + 1)} <span className="whitespace-nowrap">{FREE_LINE.slice(cut + 2)}</span>
        </>
      )}
    </p>
  );
}

/* --------------------------------------------------------------- Buttons */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

/** The page's real calls to action: a lime pill with a soft glow and a lift. */
export const BTN_PRIMARY = `cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full bg-signal px-6 text-[15px] font-semibold text-ink shadow-[0_10px_40px_-12px_var(--color-accent)] transition-[background-color,transform] hover:bg-signal-dim motion-safe:active:scale-[0.96] ${FOCUS_RING}`;

export const BTN_SECONDARY =
  "cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium text-paper ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/[0.06] motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/**
 * A button inside a mock-up or demo, drawn like the app's own: no glow, no
 * lift, so the page's real CTA stays the only glowing pill nearby. A busy
 * step (`aria-disabled`, `aria-busy`) dims a little and shows a wait cursor.
 */
export const BTN_DEMO = `cin-press inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-signal px-3.5 text-sm font-semibold text-ink transition-[background-color,scale] hover:bg-signal-dim motion-safe:active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 aria-disabled:opacity-90 aria-busy:cursor-wait ${FOCUS_RING}`;

/* ----------------------------------------------------------------- Cards */

export const CARD = "rounded-3xl border border-white/[0.07] bg-ink-2/50 ring-1 ring-inset ring-white/[0.03]";

/** A card lifted off the page (a bench, a featured panel): denser fill and the bench shadow. */
export const CARD_RAISED =
  "rounded-3xl border border-white/[0.07] bg-ink-2/70 shadow-2xl shadow-black/40 ring-1 ring-inset ring-white/[0.03]";

/* --------------------------------------------------------------- Layout */

/** Space from a SectionHeader to the section's first content. */
export const HEADER_GAP = "mt-14 sm:mt-16";

/**
 * A page section: the one vertical rhythm (`py-24 sm:py-32`) and a hairline
 * divider on top. Name the landmark with `labelledBy` (the id of its H2,
 * `<id>-title` by convention) or, without a visible heading, `label`.
 * `divider={false}` only where the section follows the pinned night or is
 * painted (#noite, #mudanca, #fim).
 */
export function Section({
  id,
  children,
  className,
  label,
  labelledBy,
  divider = true,
}: {
  id: string;
  children: ReactNode;
  className?: string;
  /** Accessible name for the landmark, when no heading can name it. */
  label?: string;
  /** Id of the heading that names the landmark; wins over `label`. */
  labelledBy?: string;
  /** The hairline on top (default on). */
  divider?: boolean;
}) {
  return (
    <section
      id={id}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn("relative scroll-mt-20 py-24 sm:py-32", divider && "border-t border-white/[0.06]", className)}
    >
      {children}
    </section>
  );
}

/**
 * The head of a section: Eyebrow, H2 and Lede, entering in turn.
 *
 * - `split` (default): a 12-column grid at lg; the words take 7 columns and
 *   the optional `aside` the other 5, aligned to the bottom. Stacked below lg.
 * - `center`: one centred stack (no aside).
 *
 * Give `titleId` and pass the same id to `Section labelledBy`. Follow it with
 * `HEADER_GAP` on the first content.
 */
export function SectionHeader({
  eyebrow,
  time,
  title,
  titleId,
  lede,
  aside,
  layout = "split",
  className,
  titleClassName,
  ledeClassName,
}: {
  /** The lime caps above the headline (H2 level is the one place they are lime). */
  eyebrow?: ReactNode;
  /** The night's clock in front of the eyebrow (as `Eyebrow time`). */
  time?: string;
  title: ReactNode;
  titleId?: string;
  lede?: ReactNode;
  /** Split only: what sits in the right 5 columns (a link, a note, a stat). */
  aside?: ReactNode;
  layout?: "split" | "center";
  className?: string;
  titleClassName?: string;
  ledeClassName?: string;
}) {
  const centered = layout === "center";
  const words = [
    eyebrow ? (
      <Eyebrow key="eyebrow" time={time} className={cn(centered && "justify-center")}>
        {eyebrow}
      </Eyebrow>
    ) : null,
    <H2 key="title" id={titleId} className={cn(eyebrow && "mt-5", centered && "mx-auto", titleClassName)}>
      {title}
    </H2>,
    lede ? (
      <Lede key="lede" className={cn("mt-6", centered && "mx-auto", ledeClassName)}>
        {lede}
      </Lede>
    ) : null,
  ];
  if (centered) {
    return (
      <KitReveal as="header" stagger={90} className={cn("mx-auto max-w-3xl text-center", className)}>
        {words}
      </KitReveal>
    );
  }
  return (
    <header className={cn("grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-12", className)}>
      <KitReveal stagger={90} className="lg:col-span-7">
        {words}
      </KitReveal>
      {aside && (
        <KitReveal delay={270} className="lg:col-span-5">
          {aside}
        </KitReveal>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ Type */

/**
 * Small caps above a headline. `signal` (lime, default) is for H2 level only;
 * `muted` for every lower label. `time` draws the night's clock in front, in
 * lime either way. `as="h3"` makes it a real level-3 heading (a column label).
 */
export function Eyebrow({
  children,
  time,
  tone = "signal",
  as: Tag = "p",
  className,
}: {
  children: ReactNode;
  time?: string;
  tone?: "signal" | "muted";
  as?: "p" | "h3";
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em]",
        tone === "muted" ? "text-paper-muted" : "text-signal",
        className,
      )}
    >
      {time && (
        <span className="rounded-md bg-signal/10 px-1.5 py-0.5 font-mono tracking-normal text-signal tabular-nums">
          {time}
        </span>
      )}
      {children}
    </Tag>
  );
}

/**
 * A size override in `className` (`text-...`) makes tailwind-merge drop the
 * heading's `leading-*`; this puts it back unless the override brings its own.
 */
function keepLeading(merged: string, leading: string): string {
  return /(^|\s)leading-/.test(merged) ? merged : cn(merged, leading);
}

export function H2({ children, id, className }: { children: ReactNode; id?: string; className?: string }) {
  return (
    <h2
      id={id}
      className={keepLeading(
        cn(
          "font-display text-[clamp(2.1rem,4.4vw,3.6rem)] font-bold leading-[1.02] tracking-[-0.02em] text-balance",
          className,
        ),
        "leading-[1.02]",
      )}
    >
      {children}
    </h2>
  );
}

const H3_SIZE = {
  lg: {
    size: "font-display text-[clamp(1.6rem,2.4vw,2.1rem)] font-bold leading-[1.08] tracking-[-0.015em]",
    leading: "leading-[1.08]",
  },
  md: { size: "font-display text-xl font-bold leading-tight sm:text-2xl", leading: "leading-tight" },
} as const;

/** `lg` for a beat or a feature's head, `md` (default) for a tile or a card. */
export function H3({
  children,
  size = "md",
  id,
  className,
}: {
  children: ReactNode;
  size?: "lg" | "md";
  id?: string;
  className?: string;
}) {
  const s = H3_SIZE[size];
  return (
    <h3 id={id} className={keepLeading(cn(s.size, "text-balance", className), s.leading)}>
      {children}
    </h3>
  );
}

/** The one highlighted phrase in a headline: one to three words. */
export function Hi({ children }: { children: ReactNode }) {
  return <span className="text-signal">{children}</span>;
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("max-w-xl text-lg leading-relaxed text-paper-muted text-pretty", className)}>{children}</p>;
}

/**
 * The line under recorded footage. `example` puts the ExampleTag first
 * (`true` for "exemplo", or the tag's own words).
 */
export function Caption({
  children,
  example,
  as = "p",
  className,
}: {
  children: ReactNode;
  example?: boolean | ReactNode;
  as?: "p" | "figcaption";
  className?: string;
}) {
  const Tag = as;
  return (
    <Tag
      className={cn(
        "mt-4 text-xs text-paper-muted sm:text-[13px]",
        example ? "flex flex-wrap items-center gap-x-2 gap-y-1" : undefined,
        className,
      )}
    >
      {example === true ? <ExampleTag /> : example ? <ExampleTag>{example}</ExampleTag> : null}
      {example ? <span>{children}</span> : children}
    </Tag>
  );
}

/* --------------------------------------------------------------- Effects */

/**
 * Fades and lifts its children in the first time they scroll into view.
 * Without motion, or before the observer fires, the content is fully visible
 * after a short opacity step, never hidden from a reader. (The kit's
 * `Reveal` in `./cinema` is the richer one; this stays for existing callers.)
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cn(
        "transition-[opacity,transform] duration-700 ease-out motion-reduce:transform-none motion-reduce:transition-opacity",
        inView ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
        className,
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

const GLOW_MIX = {
  soft: "bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-accent)_12%,transparent),transparent)]",
  strong: "bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-accent)_30%,transparent),transparent)]",
  /* Callers that predate `intensity`: the original 22%. */
  legacy: "bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-accent)_22%,transparent),transparent)]",
} as const;

/**
 * A soft lime light behind a block. Decorative. Position and size it with
 * `className` (it is absolute). `soft` is 12% accent, `strong` 30%; one per
 * section, and never a hand-written radial gradient instead. A Glow behind
 * its content (`-z-10`) needs an `isolate` parent, or it paints under the
 * page's own background and cannot be seen.
 */
export function Glow({ className, intensity }: { className?: string; intensity?: "soft" | "strong" }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute rounded-full blur-2xl", GLOW_MIX[intensity ?? "legacy"], className)}
    />
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium text-paper-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The label every scripted or sample piece of content carries. */
export function ExampleTag({ children = "exemplo", className }: { children?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-white/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-paper-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}
