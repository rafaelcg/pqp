import { useRef, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SectionRailItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  dirty?: boolean;
}

/**
 * Settings section rail. Shared by community settings and channel settings so
 * the two dialogs walk the same way: a real tablist, arrow keys, icon + label,
 * horizontal strip on phones.
 */
export function SectionRail<Id extends string>({
  sections,
  active,
  onSelect,
  idFor,
  panelId,
  label,
}: {
  sections: readonly SectionRailItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  idFor: (id: Id) => string;
  panelId: string;
  label: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);

  function move(to: number) {
    const index = (to + sections.length) % sections.length;
    const next = sections[index]!;
    onSelect(next.id);
    const tabs =
      railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = sections.findIndex((section) => section.id === active);
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(sections.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto border-b border-ink-4 px-3 py-2",
        "sm:w-56 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-3 sm:py-4",
      )}
    >
      {sections.map((section) => {
        const selected = section.id === active;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            id={idFor(section.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(section.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 sm:w-full",
              selected
                ? "bg-signal/12 font-medium text-paper"
                : "text-paper-muted hover:bg-ink-3 hover:text-paper",
              section.danger && !selected && "text-danger/80",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{section.label}</span>
            {section.dirty ? (
              <span
                className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                aria-hidden
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
