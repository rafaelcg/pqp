import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Something is on its way: a send, a save, a search, a join.
 *
 * The caller's classes set the size, the colour and the motion, as they did
 * on the Lucide glyph they replace (`h-3.5 w-3.5 animate-spin`). With the
 * toggle off that glyph is what draws. Under the redesign a ring draws
 * instead: a faint full track and a turning arc in the icon stroke, which
 * stops turning for a person who asked for reduced motion (the track and
 * arc still say "loading").
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <>
      <Loader2 aria-hidden="true" data-spinner="" className={cn(className, "redesign:hidden")} />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        data-spinner=""
        className={cn(className, "hidden redesign:block redesign:motion-reduce:animate-none")}
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
