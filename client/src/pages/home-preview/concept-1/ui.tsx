import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useInView } from "../shared/motion";

/**
 * Small kit for "Mudança de casa". Calm and editorial: hairline rules, plain
 * text, one lime accent. Lime marks what arrives on pqp; neutral grey marks
 * what stays where it was.
 */

export const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

export const BTN_PRIMARY =
  "cta-lift inline-flex h-12 items-center justify-center gap-2 rounded-full bg-signal px-6 text-[15px] font-semibold text-ink transition-[background-color,transform] hover:bg-signal-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

export const BTN_SECONDARY =
  "cta-lift inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium text-paper ring-1 ring-inset ring-white/20 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/** An inline text link: underlined, lime on hover. */
export const LINK =
  "rounded-sm text-paper underline decoration-white/30 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60";

/**
 * A numbered section: the label sits in a narrow column on the left (sticky on
 * wide screens) and the content in the wide column, like a margin note.
 */
export function Shell({
  id,
  index,
  label,
  children,
  className,
}: {
  id: string;
  index: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className={cn("scroll-mt-16 border-t border-white/10", className)}>
      <div className={cn(CONTAINER, "grid gap-x-12 gap-y-6 py-20 sm:py-28 lg:grid-cols-[168px_minmax(0,1fr)]")}>
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="font-display text-sm font-bold tabular-nums text-paper">{index}</p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-muted">{label}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

export function H2({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <h2
      id={id}
      className={cn(
        "max-w-3xl font-display text-[clamp(1.9rem,3.6vw,3rem)] font-bold leading-[1.05] tracking-[-0.02em] text-balance",
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("mt-5 max-w-2xl text-[17px] leading-relaxed text-paper-muted text-pretty", className)}>
      {children}
    </p>
  );
}

/** The one highlighted phrase in a headline. */
export function Hi({ children }: { children: ReactNode }) {
  return <span className="text-signal">{children}</span>;
}

/** Small outlined label, for "exemplo" and "acesso antecipado". */
export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "lime";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider",
        tone === "lime" ? "border-signal/40 text-signal" : "border-white/20 text-paper-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Fades and lifts its children in the first time they scroll into view. The
 * content is never hidden from a reader: without motion it only fades.
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
        inView ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        className,
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
