import type { ReactNode } from "react";
import { useSettingsRow } from "@/components/settings/kit/use-settings-row";
import { cn } from "@/lib/utils";

export interface SettingsRowProps {
  /** Kebab-case, stable, unique within the tab. Rendered as `data-settings-row`. */
  id: string;
  label: string;
  description?: ReactNode;
  /** The control's id, so the label is its accessible name. */
  htmlFor?: string;
  /** Right of the label on a wide pane, under it on a narrow one. */
  control?: ReactNode;
  /** Always under the label: a select, a slider, an input, a meter. */
  stacked?: boolean;
  /** Beside the label, for example the NOVO chip. */
  badge?: ReactNode;
  /** Under the description, for example a `SettingsInlineStatus`. */
  status?: ReactNode;
  disabled?: boolean;
  /** Extra content under the row. */
  children?: ReactNode;
}

/**
 * One setting: a label, an optional description and a control.
 *
 * The side-by-side layout is a container query on the pane (`@lg`, 32rem), not
 * a viewport breakpoint, so a narrow desktop window and a phone stack the same
 * way. Disabled dims the text only; the control carries its own disabled
 * style, and the description is where the reason goes.
 */
export function SettingsRow({
  id,
  label,
  description,
  htmlFor,
  control,
  stacked = false,
  badge,
  status,
  disabled = false,
  children,
}: SettingsRowProps) {
  useSettingsRow(id, label);
  const Label = htmlFor ? "label" : "span";
  return (
    <div
      data-settings-row={id}
      className={cn(
        "flex flex-col gap-3 px-4 py-3",
        description ? "min-h-12" : "min-h-11",
        !stacked &&
          "@lg:flex-row @lg:flex-wrap @lg:items-center @lg:justify-between @lg:gap-x-6",
      )}
    >
      <div className={cn("min-w-0 flex-1", disabled && "opacity-60")}>
        <div className="flex items-center gap-2">
          <Label htmlFor={htmlFor} className="text-sm text-text">
            {label}
          </Label>
          {badge}
        </div>
        {description ? (
          <p className="mt-0.5 text-xs text-pretty text-text-tertiary">
            {description}
          </p>
        ) : null}
        {status}
      </div>
      {control ? (
        <div className={cn("min-w-0 shrink-0", stacked ? "w-full" : "@lg:max-w-[55%]")}>
          {control}
        </div>
      ) : null}
      {children ? <div className="w-full">{children}</div> : null}
    </div>
  );
}
