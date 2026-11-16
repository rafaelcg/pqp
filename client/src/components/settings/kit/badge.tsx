import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The small chip beside a row's label: "NOVO" on a setting somebody has not
 * seen yet. Goes in `SettingsRow`'s `badge`. One look across tabs, so Voz's
 * noise suppression and Baú's toggle say "new" the same way.
 *
 * `accent` (default) is for news; `neutral` is a quiet qualifier ("Beta").
 *
 * It is `ui/Badge`: `new` and `neutral` under the redesign (a sentence-case
 * pill). With the toggle off it keeps the chip Settings always drew (soft
 * accent, 10px uppercase, no fixed height), passed as classes `cn` lets win.
 */
export function SettingsBadge({
  children,
  tone = "accent",
  className,
}: {
  children: ReactNode;
  tone?: "accent" | "neutral";
  className?: string;
}) {
  return (
    <Badge
      variant={tone === "accent" ? "new" : "neutral"}
      className={cn(
        "h-auto gap-0 rounded-full px-1.5 py-0.5 font-semibold tracking-wide",
        tone === "accent"
          ? "bg-accent-soft text-on-accent-soft"
          : "bg-surface-2 text-text-secondary",
        className,
      )}
    >
      {children}
    </Badge>
  );
}
