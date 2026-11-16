import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Something is on its way: a send, a save, a search, a join.
 *
 * The caller's classes set the size, the colour and the motion, as they did
 * on the Lucide glyph they replace (`h-3.5 w-3.5 animate-spin`). With the
 * toggle off that glyph is what draws. Under the redesign a ring draws
 * instead: a faint full track and a turning arc in the icon stroke. It owns
 * its motion under the redesign: for a person who asked for reduced motion
 * it stops turning and fades in and out instead, because a still quarter
 * arc reads as 25% done, not as "loading".
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  // The ring takes the caller's size and colour but never its motion: a bare
  // `animate-spin` would otherwise fight the reduced-motion pulse, and only
  // CSS order would decide it.
  const ringClassName = className
    ?.split(/\s+/)
    .filter((name) => !/(^|:)animate-/.test(name))
    .join(" ");
  return (
    <>
      <Loader2 aria-hidden="true" data-spinner="" className={cn(className, "redesign:hidden")} />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        data-spinner=""
        className={cn(
          ringClassName,
          // 14px at the smallest: below it the stroke is about a pixel and
          // the faint track disappears.
          "hidden redesign:block redesign:min-h-3.5 redesign:min-w-3.5 redesign:motion-safe:animate-spin redesign:motion-reduce:animate-pulse",
        )}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          style={{ strokeOpacity: "var(--spinner-track-opacity)", strokeWidth: "var(--icon-stroke)" }}
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeLinecap="round"
          style={{ strokeWidth: "var(--icon-stroke)" }}
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}
