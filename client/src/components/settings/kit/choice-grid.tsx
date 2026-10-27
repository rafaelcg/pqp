import { Check as CheckBold } from "@phosphor-icons/react";
import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useRovingRadio } from "@/components/ui/radio-group";
import {
  SETTINGS_FOCUS,
  SETTINGS_TRANSITION,
} from "@/components/settings/kit/classes";
import { IconSwap } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface SettingsChoice<T extends string> {
  value: T;
  label: string;
  /** A short qualifier ("Só escuro"), on its own line under the name. */
  badge?: string;
  /**
   * One line under the name saying what this choice does, so each card can be
   * read before choosing (Voz's input modes). The radio's description, not
   * part of its name.
   */
  description?: string;
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
  const baseId = useId();
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
      {options.map((option, index) => {
        const checked = option.value === value;
        const labelId = `${baseId}-${index}-label`;
        const badgeId = `${baseId}-${index}-badge`;
        const descriptionId = `${baseId}-${index}-description`;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            // Only with a description: then the name is the label (and badge)
            // and the line is the description. Without one, the name stays
            // what the content says, as before.
            aria-labelledby={
              option.description
                ? option.badge
                  ? `${labelId} ${badgeId}`
                  : labelId
                : undefined
            }
            aria-describedby={option.description ? descriptionId : undefined}
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
              // Under the redesign a choice is a card (ui/card.tsx); the
              // chosen one keeps the accent edge, two pixels so it reads
              // without the fill, and the accent ring for focus.
              "redesign:focus-visible:ring-accent",
              checked
                ? "redesign:bg-[color:var(--card-row-hover)] redesign:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                : "redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:hover:border-[color:color-mix(in_oklab,var(--color-text)_18%,transparent)]",
            )}
          >
            <span aria-hidden className="block">
              {option.preview}
            </span>
            <span className="flex min-w-0 flex-col items-start gap-1 px-1 pb-1">
              <span id={labelId} className="truncate text-sm text-text">
                {option.label}
              </span>
              {option.description ? (
                <span
                  id={descriptionId}
                  className="text-xs text-pretty text-text-tertiary"
                >
                  {option.description}
                </span>
              ) : null}
              {option.badge ? (
                <span
                  id={badgeId}
                  className="rounded-[var(--radius-control)] bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary redesign:rounded-[var(--badge-radius)] redesign:bg-surface-3 redesign:px-[var(--badge-px)] redesign:font-semibold redesign:text-text"
                >
                  {option.badge}
                </span>
              ) : null}
            </span>
            {checked ? (
              <span
                aria-hidden
                className="absolute top-3 right-3 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-on-accent"
              >
                <IconSwap
                  off={Check}
                  on={CheckBold}
                  kind="symbol"
                  offClassName="h-3 w-3 [stroke-width:3]"
                  className="h-3 w-3"
                />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
