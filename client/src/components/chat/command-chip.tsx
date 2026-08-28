import type { LucideIcon } from "lucide-react";

/**
 * The "this came from a slash command" mark shared by ChanceCard and PollCard.
 * Purely visual: a mono pill with the command name, so a result card never
 * reads as something a person typed.
 */
export function CommandChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-signal/30 bg-signal/10 px-2 py-0.5 font-mono text-[11px] leading-4 tracking-wide text-signal">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}
