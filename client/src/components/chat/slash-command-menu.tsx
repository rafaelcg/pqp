import type { SlashCommandMeta } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

interface SlashCommandMenuProps {
  id?: string;
  commands: SlashCommandMeta[];
  selectedIndex: number;
  onSelect: (command: SlashCommandMeta) => void;
  onHover: (index: number) => void;
}

export function SlashCommandMenu({
  id,
  commands,
  selectedIndex,
  onSelect,
  onHover,
}: SlashCommandMenuProps) {
  if (commands.length === 0) {
    return (
      <div
        id={id}
        className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-lg border border-ink-4 bg-ink-2 p-3 shadow-[0_12px_40px_oklch(0.1_0.02_250/0.55)] animate-rise"
      >
        <p className="text-sm text-paper-muted">No matching commands</p>
      </div>
    );
  }

  return (
    <div
      id={id}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[0_12px_40px_oklch(0.1_0.02_250/0.55)] animate-rise"
      role="listbox"
      aria-label="Slash commands"
    >
      <p className="px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-paper-muted">
        Commands
      </p>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={selected}
            className={cn(
              "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left text-sm outline-none",
              selected ? "bg-ink-3 text-paper" : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
            )}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command);
            }}
          >
            <span className="shrink-0 font-mono text-signal">/{command.name}</span>
            <span className="min-w-0 flex-1 text-paper/80">{command.description}</span>
          </button>
        );
      })}
    </div>
  );
}
