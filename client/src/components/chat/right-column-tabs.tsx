import { cn } from "@/lib/utils";

/**
 * The right column holds either the member list or an open thread, never both
 * — they are one slot and always have been (see the roster toggle in App.tsx,
 * which closes a thread before showing the people). That rule is right; what
 * was missing is any sign of it, so the roster appeared to vanish when a
 * thread opened and the thread appeared to be thrown away when the roster
 * came back.
 *
 * Two items, so a segmented switch rather than tabs over a panel: whichever is
 * not showing is one tap away, and the thread you were reading is still there.
 */
export function RightColumnTabs({
  active,
  membersLabel,
  threadLabel,
  onSelectMembers,
  onSelectThread,
}: {
  active: "members" | "thread";
  membersLabel: string;
  threadLabel: string;
  onSelectMembers: () => void;
  onSelectThread: () => void;
}) {
  const item =
    "min-w-0 flex-1 truncate rounded-[var(--radius-pill)] px-3 py-1 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  return (
    <div className="flex w-full items-center gap-1 rounded-[var(--radius-pill)] bg-surface-2 p-1">
      <button
        type="button"
        aria-pressed={active === "members"}
        onClick={onSelectMembers}
        className={cn(
          item,
          active === "members"
            ? "bg-surface-0 text-text"
            : "text-text-tertiary hover:text-text",
        )}
      >
        {membersLabel}
      </button>
      <button
        type="button"
        aria-pressed={active === "thread"}
        onClick={onSelectThread}
        className={cn(
          item,
          active === "thread"
            ? "bg-surface-0 text-text"
            : "text-text-tertiary hover:text-text",
        )}
      >
        {threadLabel}
      </button>
    </div>
  );
}
