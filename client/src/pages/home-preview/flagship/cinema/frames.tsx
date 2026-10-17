import { Lock, RotateCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./cinema.css";

/**
 * Device chrome for real footage, drawn in CSS. Both carry a layered shadow,
 * a hairline inner border, and a lime rim light on hover or keyboard focus.
 * Neither copies a real product's shape or logo.
 */

/**
 * A browser window showing pqp.gg: the product runs in the browser, and the
 * frame says so. `bodyClassName` or `bodyStyle` sizes the content area (for
 * example `aspect-[16/10]`); children usually fill it.
 */
export function BrowserFrame({
  children,
  url = "pqp.gg/app",
  className,
  bodyClassName,
  bodyStyle,
  style,
  rim = true,
}: {
  children: ReactNode;
  url?: string;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  style?: CSSProperties;
  /** The lime rim light on hover and focus. */
  rim?: boolean;
}) {
  return (
    <div
      className={cn("cin-device relative isolate rounded-[14px] bg-ink-2 sm:rounded-[18px]", className)}
      style={style}
    >
      <div className="relative overflow-hidden rounded-[inherit]">
        <div
          aria-hidden
          className="relative flex h-8 items-center gap-3 border-b border-white/[0.06] bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--color-text)_6%,transparent),transparent)] px-3 sm:h-10 sm:px-4"
        >
          <span className="flex shrink-0 gap-1.5">
            <span className="h-2 w-2 rounded-full bg-white/[0.16] sm:h-2.5 sm:w-2.5" />
            <span className="h-2 w-2 rounded-full bg-white/[0.12] sm:h-2.5 sm:w-2.5" />
            <span className="h-2 w-2 rounded-full bg-white/[0.08] sm:h-2.5 sm:w-2.5" />
          </span>
          <span className="absolute left-1/2 flex h-5 w-[min(44%,22rem)] -translate-x-1/2 items-center justify-center gap-1.5 rounded-md bg-white/[0.05] px-3 text-[10px] text-paper-muted ring-1 ring-inset ring-white/[0.05] sm:h-6 sm:text-[11px]">
            <Lock className="h-2.5 w-2.5 shrink-0 opacity-70 sm:h-3 sm:w-3" />
            <span className="truncate">{url}</span>
          </span>
          <RotateCw className="ml-auto hidden h-3.5 w-3.5 text-paper-muted/50 sm:block" />
        </div>
        <div className={cn("relative bg-ink", bodyClassName)} style={bodyStyle}>
          {children}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[2] rounded-[inherit] ring-1 ring-inset ring-white/[0.09]"
        />
      </div>
      {rim && (
        <>
          <span aria-hidden className="cin-rim" />
          <span aria-hidden className="cin-rim-glow" />
        </>
      )}
    </div>
  );
}

/**
 * A generic modern phone: even bezels, a small camera pill, quiet side keys.
 * Size it with a width class; the screen keeps `aspect` (default 9 / 19.5).
 */
export function PhoneFrame({
  children,
  className,
  screenClassName,
  aspect = "9 / 19.5",
  rim = true,
}: {
  children: ReactNode;
  className?: string;
  screenClassName?: string;
  aspect?: string;
  rim?: boolean;
}) {
  return (
    <div
      className={cn(
        "cin-device relative isolate rounded-[2.4rem] bg-rail p-[7px] ring-1 ring-inset ring-white/[0.12] sm:rounded-[2.8rem] sm:p-[9px]",
        className,
      )}
    >
      {/* Side keys: one on the right, two on the left. */}
      <span aria-hidden className="absolute -right-[2px] top-[24%] h-[11%] w-[3px] rounded-r-sm bg-white/[0.12]" />
      <span aria-hidden className="absolute -left-[2px] top-[18%] h-[6%] w-[3px] rounded-l-sm bg-white/[0.12]" />
      <span aria-hidden className="absolute -left-[2px] top-[27%] h-[9%] w-[3px] rounded-l-sm bg-white/[0.12]" />
      <div
        className={cn("relative overflow-hidden rounded-[1.95rem] bg-ink sm:rounded-[2.25rem]", screenClassName)}
        style={{ aspectRatio: aspect }}
      >
        {children}
        <span
          aria-hidden
          className="absolute left-1/2 top-[1.4%] z-[2] h-[1.9%] w-[15%] -translate-x-1/2 rounded-full bg-black ring-1 ring-white/[0.06]"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[2] rounded-[inherit] ring-1 ring-inset ring-white/[0.08]"
        />
      </div>
      {rim && (
        <>
          <span aria-hidden className="cin-rim" />
          <span aria-hidden className="cin-rim-glow" />
        </>
      )}
    </div>
  );
}
