import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Same-size icon cluster. Gap stays even so tiles do not drift. */
export function CallControlGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1">{children}</div>;
}

export function CallControlDivider({
  className,
}: {
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("hidden w-px self-stretch bg-border sm:block", className)}
    />
  );
}
