import type { ReactNode } from "react";
import { useSettingsRow } from "@/components/settings/kit/use-settings-row";
import { cn } from "@/lib/utils";

/** `data-*` attributes a row passes through to its root element. */
export type SettingsDataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export interface SettingsRowProps extends SettingsDataAttributes {
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
  /** Beside the label, for example the NOVO chip (`SettingsBadge`). */
  badge?: ReactNode;
  /** Under the description, for example a `SettingsInlineStatus`. */
  status?: ReactNode;
  disabled?: boolean;
  /** Extra content under the row. */
  children?: ReactNode;
  /**
   * Drawn before the label column, centred on it: an avatar, a provider
   * tile, an icon. It stays beside the label at every width, and the row
   * flash from `openSection` covers it because it is inside the row.
   */
  leading?: ReactNode;
  /**
   * `false` keeps the row out of the settings registry. For rows built from
   * data (a blocked person, a linked account), which are not settings and
   * must never show up in search. Default `true`.
   */
  searchable?: boolean;
  /**
   * Keeps the control beside the label at every width, phone included. For a
   * small control in a list row (an `sm` "Desbloquear" button), where
   * stacking would make every row twice as tall. Ignored with `stacked`.
   */
  keepInline?: boolean;
  /**
   * Lets the control take more than the usual 55% of a wide row, for a
   * select plus a button. The label keeps at least 10rem; when the two do
   * not fit side by side the control wraps under the label.
   */
  wideControl?: boolean;
}

/**
 * One setting: a label, an optional description and a control.
 *
 * The side-by-side layout is a container query on the pane (`@lg`, 32rem), not
 * a viewport breakpoint, so a narrow desktop window and a phone stack the same
 * way. Disabled dims the text (and the leading slot) only; the control carries
 * its own disabled style, and the description is where the reason goes.
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
  leading,
  searchable = true,
  keepInline = false,
  wideControl = false,
  ...data
}: SettingsRowProps) {
  useSettingsRow(id, label, searchable);
  const Label = htmlFor ? "label" : "span";
  const inline = keepInline && !stacked;
  const text = (
    <>
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
    </>
  );
  const labelColumn = cn(
    "min-w-0 flex-1",
    disabled && "opacity-60",
    wideControl && !stacked && "@lg:min-w-40",
  );
  return (
    <div
      {...data}
      data-settings-row={id}
      className={cn(
        "flex flex-col gap-3 px-4 py-3",
        description ? "min-h-12" : "min-h-11",
        inline
          ? "flex-row flex-wrap items-center justify-between gap-x-4 @lg:gap-x-6"
          : !stacked &&
              "@lg:flex-row @lg:flex-wrap @lg:items-center @lg:justify-between @lg:gap-x-6",
      )}
    >
      {leading ? (
        <div className={cn(labelColumn, "flex items-center gap-3")}>
          <div className="flex shrink-0 items-center">{leading}</div>
          <div className="min-w-0 flex-1">{text}</div>
        </div>
      ) : (
        <div className={labelColumn}>{text}</div>
      )}
      {control ? (
        <div
          className={cn(
            "min-w-0 shrink-0",
            stacked ? "w-full" : wideControl ? "@lg:max-w-full" : "@lg:max-w-[55%]",
          )}
        >
          {control}
        </div>
      ) : null}
      {children ? <div className="w-full">{children}</div> : null}
    </div>
  );
}
