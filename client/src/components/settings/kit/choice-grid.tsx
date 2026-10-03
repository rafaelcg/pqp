import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { useRovingRadio } from "@/components/ui/radio-group";
import {
  SETTINGS_FOCUS,
  SETTINGS_TRANSITION,
} from "@/components/settings/kit/classes";
import { cn } from "@/lib/utils";

export interface SettingsChoice<T extends string> {
  value: T;
  label: string;
  /** A short qualifier ("Só escuro"), on its own line under the name. */
  badge?: string;
  /** The miniature. Decorative: the label is the radio's name. */
  preview: ReactNode;
  disabled?: boolean;
}

interface SettingsChoiceGridProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (next: T) => void;
  options: readonly SettingsChoice<T>[];
  /** Columns from `@lg` up; always two below. */
  columns?: 2 | 3 | 4;
}

const COLUMNS = {
  2: "@lg:grid-cols-2",
  3: "@lg:grid-cols-3",
  4: "@lg:grid-cols-4",
} as const;

/**
 * A visual one-of-many: cards with a live miniature, the selected one ringed in
 * the accent with a tick. Same keyboard model as `RadioGroup`. Sits inside a
 * `SettingsGroup surface="plain"`, because each card is already a box.
 */
export function SettingsChoiceGrid<T extends string>({
  label,
  value,
  onValueChange,
  options,
  columns = 3,
}: SettingsChoiceGridProps<T>) {
  const { onKeyDown, tabIndexFor } = useRovingRadio(
    options.map((option) => option.value),
    value,
    onValueChange,
    (v) => Boolean(options.find((option) => option.value === v)?.disabled),
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("grid grid-cols-2 gap-3", COLUMNS[columns])}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={tabIndexFor(option.value)}
            onClick={() => {
              if (!checked) onValueChange(option.value);
            }}
            className={cn(
              "relative flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border p-2 text-left",
              SETTINGS_TRANSITION,
              SETTINGS_FOCUS,
              checked
                ? "border-accent bg-surface-2"
                : "border-border hover:border-border-strong",
              option.disabled && "cursor-not-allowed opacity-40",
            )}
          >
            <span aria-hidden className="block">
              {option.preview}
            </span>
            <span className="flex min-w-0 flex-col items-start gap-1 px-1 pb-1">
              <span className="truncate text-sm text-text">{option.label}</span>
              {option.badge ? (
                <span className="rounded-[var(--radius-control)] bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary">
                  {option.badge}
                </span>
              ) : null}
            </span>
            {checked ? (
              <span
                aria-hidden
                className="absolute top-3 right-3 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-on-accent"
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
