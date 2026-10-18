import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Concept 4 kit. The page is a tool: hairline panels, mono micro labels,
 * numbered sections. Lime is kept for the primary action and for live states
 * (a call, a switch that turns a voice channel on), nothing else.
 */

export const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

export const BTN_PRIMARY = cn(
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-signal px-5 text-[15px] font-semibold text-ink transition-[background-color,transform] duration-200 hover:bg-signal-dim active:translate-y-px",
  FOCUS,
);

export const BTN_SECONDARY = cn(
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/15 px-5 text-[15px] font-medium text-paper transition-colors hover:border-white/30 hover:bg-white/[0.05]",
  FOCUS,
);

export const PANEL = "rounded-2xl border border-white/10 bg-ink-2/70";

export const MONO = "font-mono text-[11px] uppercase tracking-[0.16em] text-paper-muted";

/** The title bar of a panel: "01  Servidor" on the left, a readout on the right. */
export function PanelHead({
  n,
  label,
  right,
  className,
}: {
  n?: string;
  label: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-11 items-center justify-between gap-3 border-b border-white/[0.08] px-4",
        className,
      )}
    >
      <p className={MONO}>
        {n && <span className="mr-2 text-paper">{n}</span>}
        {label}
      </p>
      {right}
    </div>
  );
}

/** The label every scripted or sample piece of content carries. */
export function ExampleTag({
  children = "exemplo",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-white/15 px-1.5 py-px font-mono text-[10px] leading-4 text-paper-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A numbered section: a hairline, a mono label, then headline and lede on one grid. */
export function SectionHead({
  n,
  label,
  title,
  lede,
}: {
  n: string;
  label: string;
  title: ReactNode;
  lede?: ReactNode;
}) {
  return (
    <header>
      <div className="flex items-center gap-3 border-t border-white/10 pt-4">
        <span className={cn(MONO, "text-paper")}>{n}</span>
        <span className={MONO}>{label}</span>
      </div>
      <div className="mt-8 grid gap-4 lg:grid-cols-12 lg:items-end lg:gap-8">
        <h2 className="font-display text-[clamp(1.95rem,3.8vw,3rem)] font-bold leading-[1.04] tracking-[-0.02em] text-balance lg:col-span-7">
          {title}
        </h2>
        {lede && (
          <p className="text-base leading-relaxed text-paper-muted text-pretty sm:text-lg lg:col-span-5">
            {lede}
          </p>
        )}
      </div>
    </header>
  );
}
