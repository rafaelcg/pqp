import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Same-size icon cluster. Gap stays even so tiles do not drift. */
export function CallControlGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex items-center gap-1", className)}>{children}</div>;
}

/**
 * Hairline between clusters. Dropped on a narrow row, where every pixel is a
 * tile's. Both rules measure the row's own container rather than the window.
 * `container` is the slim bar that lives in the composer and is narrower than
 * the screen whenever a sidebar is open: under 22rem, the width the full set
 * of tiles needs. Without it this is the stage's call bar, where under 40rem
 * the clusters dissolve into one wrapping row (see `CallControls`) and a
 * hairline would stand in the middle of a line.
 */
export function CallControlDivider({
  className,
  container = false,
}: {
  className?: string;
  container?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "hidden w-px self-stretch bg-border",
        container ? "@min-[22rem]:block" : "@min-[40rem]:block",
        className,
      )}
    />
  );
}
