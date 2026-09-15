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
 * tile's. `container` measures the row's own container (under 22rem, the
 * width the full set of tiles needs) rather than the window, for the slim bar
 * that lives in the composer and is narrower than the screen whenever a
 * sidebar is open.
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
        container ? "@min-[22rem]:block" : "sm:block",
        className,
      )}
    />
  );
}
