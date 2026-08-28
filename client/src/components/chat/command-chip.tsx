import type { LucideIcon } from "lucide-react";

/**
 * Quiet "/roll" mark so a result is not mistaken for typed prose.
 * Intentionally not a glowing pill: the object (dice, coin, poll) is the card.
 */
export function CommandChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] leading-none text-paper-muted">
      <Icon className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      {label}
    </span>
  );
}
