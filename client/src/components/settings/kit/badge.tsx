import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small chip beside a row's label: "NOVO" on a setting somebody has not
 * seen yet. Goes in `SettingsRow`'s `badge`. One look across tabs, so Voz's
 * noise suppression and Baú's toggle say "new" the same way.
 *
 * `accent` (default) is for news; `neutral` is a quiet qualifier ("Beta").
 * The text is uppercased by CSS, so the copy stays "Novo" in the locale file.
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
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-wide uppercase",
        tone === "accent"
          ? "bg-accent-soft text-on-accent-soft"
          : "bg-surface-2 text-text-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}
