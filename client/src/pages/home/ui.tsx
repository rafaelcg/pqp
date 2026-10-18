import { createContext, type ReactNode, useContext } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import "./cinema/cinema.css";

export { CREATE_INTENT, IMPORT_INTENT } from "./shared/auth-buttons";

/**
 * The homepage's type and layout scale. Every section composes these so the
 * page reads as one piece. The rules below came out of a review of the whole
 * page against the common tells of a generated site (October 17, 2026). Keep
 * them when you add a section; do not re-add what they took out.
 *
 * - Lime (`signal`) is rare. It fills the primary button, it marks the
 *   closer's "Chama a galera." (the one `Hi` on the page), it draws focus
 *   rings, and it appears where the app itself uses it inside recordings and
 *   mock-ups. Every other headline is plain paper white. No lime eyebrows,
 *   no lime edge lines, no lime clock chips.
 * - No glows. No coloured shadows, no blurred blobs, no decorative
 *   gradients. `hp-grain` stays only on the hero and Fim backgrounds.
 * - Eyebrows: one survives only if it says something its H2 does not. A
 *   survivor is sentence case and muted, in the one `Eyebrow` style. Caps
 *   inside app mock-ups stay, because they copy the app.
 * - Motion: the hero's pin and its frame's rise, and the night's pin. Nothing
 *   reveals on scroll in a header, a grid or a list. No tilt, no magnetic
 *   pull, no overshoot. A hover moves transform or opacity for 200 to 300 ms,
 *   ease-out.
 * - Breu, the mascot (`breu/`), keeps its own motion, chosen by André: the
 *   hero peek, its blink, breath and waving hand, the closer's sleep, and the
 *   bot tile's phases. Every drawing is aria-hidden decoration, its loops run
 *   only on screen and stop under reduced motion, and the hand's wave is the
 *   character waving, not a tilted card. Its lime is the product's own bot
 *   face, not a lime headline. Keep it; it is not a tell to strip.
 * - Captions: a figure that shows invented people carries the short example
 *   tag (`Caption example`), and its words say what it shows and when
 *   ("21:40, o Lobby enchendo"), never a disclaimer. The full disclaimer is
 *   said once, under the hero footage.
 * - Status dots are static. No icons in tinted tiles as decoration; the app's
 *   own glyphs (# for a text channel, the speaker, the lock) are fine.
 * - Weight follows importance: the support sections (Limites, Código,
 *   Perguntas) use `Section weight="support"`, which tightens the padding and
 *   sets a smaller H2.
 */

export const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

/* ------------------------------------------------------------------ Copy */

/**
 * The page's CTA copy, in the reader's language. Call it at the top of a
 * component, then use the strings where the old constants were.
 *
 * - `create`: the create CTA. Always with `CREATE_INTENT`.
 * - `importDiscord`: the import CTA. Always with `IMPORT_INTENT`.
 * - `free` and `providers`: the two sentences of the line under a CTA pair
 *   (hero, Mudança, Fim). `FreeLine` draws them.
 */
export function useCta() {
  const { t } = useTranslation();
  return {
    create: t("home.cta.create"),
    importDiscord: t("home.cta.import"),
    free: t("home.cta.free"),
    providers: t("home.cta.providers"),
  };
}

/**
 * The line under a CTA pair: "no card" and the sign-up ways, as two
 * sentences. The last never breaks inside itself, so a phone never leaves the
 * last provider alone on its own line. `extra` is one more sentence between
 * the two (the hero's "open source, made by two brothers").
 */
export function FreeLine({ className, extra }: { className?: string; extra?: ReactNode }) {
  const { free, providers } = useCta();
  return (
    <p className={className}>
      {free} {extra ? <>{extra} </> : null}
      <span className="whitespace-nowrap">{providers}</span>
    </p>
  );
}

/* --------------------------------------------------------------- Buttons */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

/** The page's real calls to action: a lime pill with a small lift on hover. No glow, no coloured shadow. */
export const BTN_PRIMARY = `cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full bg-signal px-6 text-[15px] font-semibold text-ink transition-[background-color,transform] hover:bg-signal-dim motion-safe:active:scale-[0.96] ${FOCUS_RING}`;

export const BTN_SECONDARY =
  "cta-lift cin-press inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium text-paper ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/[0.06] motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/**
 * A button inside a mock-up or demo, drawn like the app's own: no lift, so
 * the page's real CTA stays the one that moves nearby. A busy step
 * (`aria-disabled`, `aria-busy`) dims a little and shows a wait cursor.
 */
export const BTN_DEMO = `cin-press inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-signal px-3.5 text-sm font-semibold text-ink transition-[background-color,scale] hover:bg-signal-dim motion-safe:active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 aria-disabled:opacity-90 aria-busy:cursor-wait ${FOCUS_RING}`;

/* ----------------------------------------------------------------- Cards */

export const CARD = "rounded-3xl border border-white/[0.07] bg-ink-2/50 ring-1 ring-inset ring-white/[0.03]";

/** A card lifted off the page (a bench, a featured panel): denser fill and the bench shadow. */
export const CARD_RAISED =
  "rounded-3xl border border-white/[0.07] bg-ink-2/70 shadow-2xl shadow-black/40 ring-1 ring-inset ring-white/[0.03]";

/* --------------------------------------------------------------- Layout */

/**
 * How much a section weighs on the page.
 *
 * - `full` (default): the main sections. `py-24 sm:py-32` and the full H2.
 * - `support`: the sections that back the main ones up (Limites, Código,
 *   Perguntas). `py-16 sm:py-20` and a smaller H2.
 */
export type SectionWeight = "full" | "support";

const SectionWeightContext = createContext<SectionWeight>("full");

const SECTION_PADDING: Record<SectionWeight, string> = {
  full: "py-24 sm:py-32",
  support: "py-16 sm:py-20",
};

/** Space from a SectionHeader to the section's first content. */
export const HEADER_GAP = "mt-14 sm:mt-16";

/** The same space in a `weight="support"` section. */
export const HEADER_GAP_SUPPORT = "mt-10 sm:mt-12";

/**
 * A page section: the vertical rhythm of its `weight` and a hairline divider
 * on top. Name the landmark with `labelledBy` (the id of its H2,
 * `<id>-title` by convention) or, without a visible heading, `label`.
 * `divider={false}` only where the section follows the pinned night or is
 * painted (#noite, #mudanca, #fim).
 *
 * `weight` also reaches every `SectionHeader` inside, so a support section
 * sets it once, here.
 *
 * `aliases` are older ids that links still use (`/#features`, `/#hosting`).
 * Each one is an empty span at the section's top-left corner, so a jump to
 * it lands where a jump to the section lands. The span gets no scroll margin
 * of its own: the page's `scroll-padding-top` already clears the header, and
 * a margin on top of it would land the section that much lower.
 */
export function Section({
  id,
  aliases,
  children,
  className,
  label,
  labelledBy,
  divider = true,
  weight = "full",
}: {
  id: string;
  /** Extra ids that land on this section (old anchors). */
  aliases?: readonly string[];
  children: ReactNode;
  className?: string;
  /** Accessible name for the landmark, when no heading can name it. */
  label?: string;
  /** Id of the heading that names the landmark; wins over `label`. */
  labelledBy?: string;
  /** The hairline on top (default on). */
  divider?: boolean;
  /** `support` for Limites, Código and Perguntas: tighter padding, smaller H2. */
  weight?: SectionWeight;
}) {
  return (
    <SectionWeightContext.Provider value={weight}>
      <section
        id={id}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        className={cn(
          "relative scroll-mt-20",
          SECTION_PADDING[weight],
          divider && "border-t border-white/[0.06]",
          className,
        )}
      >
        {aliases?.map((alias) => (
          <span key={alias} id={alias} aria-hidden className="absolute left-0 top-0" />
        ))}
        {children}
      </section>
    </SectionWeightContext.Provider>
  );
}

/**
 * The head of a section: an optional Eyebrow, the H2 and an optional Lede.
 * It is there when the section arrives; nothing in it reveals on scroll.
 *
 * - `split` (default): a 12-column grid at lg; the words take 7 columns and
 *   the optional `aside` the other 5, aligned to the bottom. Stacked below lg.
 * - `center`: one centred stack (no aside).
 *
 * `weight` follows the enclosing `Section` unless you pass it; `support`
 * draws the smaller H2 and tighter gaps. Give `titleId` and pass the same id
 * to `Section labelledBy`. Follow it with `HEADER_GAP` (or
 * `HEADER_GAP_SUPPORT`) on the first content.
 */
export function SectionHeader({
  eyebrow,
  time,
  title,
  titleId,
  lede,
  aside,
  layout = "split",
  weight,
  className,
  titleClassName,
  ledeClassName,
}: {
  /**
   * A muted, sentence-case label above the headline. Only when it says
   * something the H2 does not; most sections need none.
   */
  eyebrow?: ReactNode;
  /** A clock in front of the eyebrow (as `Eyebrow time`): Fim's "02:14". */
  time?: string;
  title: ReactNode;
  titleId?: string;
  lede?: ReactNode;
  /** Split only: what sits in the right 5 columns (a link, a note, a stat). */
  aside?: ReactNode;
  layout?: "split" | "center";
  /** Defaults to the enclosing `Section`'s weight. */
  weight?: SectionWeight;
  className?: string;
  titleClassName?: string;
  ledeClassName?: string;
}) {
  const inherited = useContext(SectionWeightContext);
  const support = (weight ?? inherited) === "support";
  const centered = layout === "center";
  const words = (
    <>
      {eyebrow ? (
        <Eyebrow time={time} className={cn(centered && "justify-center")}>
          {eyebrow}
        </Eyebrow>
      ) : null}
      <H2
        id={titleId}
        size={support ? "support" : "full"}
        className={cn(eyebrow && (support ? "mt-3" : "mt-4"), centered && "mx-auto", titleClassName)}
      >
        {title}
      </H2>
      {lede ? (
        <Lede className={cn(support ? "mt-4" : "mt-6", centered && "mx-auto", ledeClassName)}>{lede}</Lede>
      ) : null}
    </>
  );
  if (centered) {
    return <header className={cn("mx-auto max-w-3xl text-center", className)}>{words}</header>;
  }
  return (
    <header className={cn("grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-12", className)}>
      <div className="lg:col-span-7">{words}</div>
      {aside && <div className="lg:col-span-5">{aside}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ Type */

/**
 * The page's one label style: sentence case, muted, one size, no tracking.
 * Above an H2 (only when it adds something the H2 does not say), and as a
 * column or tile label. `time` draws a clock in front, in mono on a faint
 * fill (Fim's "02:14"), never in lime. `as="h3"` makes it a real level-3
 * heading (a column label).
 *
 * Write the value in sentence case in the catalogue: nothing upper-cases it.
 * Caps inside an app mock-up are not an Eyebrow; they copy the app.
 */
export function Eyebrow({
  children,
  time,
  as: Tag = "p",
  className,
}: {
  children: ReactNode;
  time?: string;
  as?: "p" | "h3";
  className?: string;
}) {
  return (
    <Tag className={cn("flex items-center gap-2 text-sm font-medium text-paper-muted", className)}>
      {time && (
        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-paper tabular-nums">
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

const H2_SIZE = {
  full: {
    size: "font-display text-[clamp(2.1rem,4.4vw,3.6rem)] font-bold leading-[1.02] tracking-[-0.02em]",
    leading: "leading-[1.02]",
  },
  support: {
    size: "font-display text-[clamp(1.75rem,3vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.015em]",
    leading: "leading-[1.08]",
  },
} as const;

/** `full` (default) for a main section, `support` for Limites, Código and Perguntas. */
export function H2({
  children,
  id,
  size = "full",
  className,
}: {
  children: ReactNode;
  id?: string;
  size?: SectionWeight;
  className?: string;
}) {
  const s = H2_SIZE[size];
  return (
    <h2 id={id} className={keepLeading(cn(s.size, "text-balance", className), s.leading)}>
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

/**
 * Lime on a headline phrase. The page has exactly one: the closer's "Chama a
 * galera.", where the brand face earns it. Every other headline renders its
 * `titleAccent` as plain text (`rich(t(title), { accent: t(titleAccent) })`)
 * and gets its emphasis from the sentence and the line break.
 */
export function Hi({ children }: { children: ReactNode }) {
  return <span className="text-signal">{children}</span>;
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("max-w-xl text-lg leading-relaxed text-paper-muted text-pretty", className)}>{children}</p>;
}

/**
 * The line under a figure.
 *
 * - A figure that shows invented people passes `example`: the short example
 *   tag comes first (`true` for the default "exemplo", or the tag's own
 *   words), then the words. The words say what the figure shows and when
 *   ("21:40, o Lobby enchendo"), never that the people are samples: the tag
 *   says that.
 * - The hero's caption is the one exception. It is the page's full
 *   disclaimer, so it carries no tag (a tag beside a sentence that already
 *   says "de exemplo" is said twice).
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

/* ----------------------------------------------------------------- Chips */

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

/**
 * The short tag every invented person or sample piece of content carries
 * ("exemplo" by default, or its own words). Keep it on the @ depoimentos
 * always. `Caption example` puts one in front of a figure's caption.
 */
export function ExampleTag({ children, className }: { children?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-white/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-paper-muted",
        className,
      )}
    >
      {children ?? t("home.common.example")}
    </span>
  );
}
