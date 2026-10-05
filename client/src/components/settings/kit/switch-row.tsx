import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { SETTINGS_INSET_FOCUS } from "@/components/settings/kit/classes";
import { useSettingsRow } from "@/components/settings/kit/use-settings-row";
import { cn } from "@/lib/utils";

export interface SettingsSwitchRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** A write is running: unavailable but still focused (see `Switch`). */
  busy?: boolean;
  /** Under the row, for example a notice or a `SettingsInlineStatus`. */
  status?: ReactNode;
  /** A secondary action beside the switch, for example an icon-only "Ouvir". */
  trailing?: ReactNode;
  /** `false` keeps the row out of the settings registry (see `SettingsRow`). */
  searchable?: boolean;
}

/**
 * An on/off setting. The whole row is the `Switch`, so the row is the hit
 * target and the role is `switch`. With `trailing` the row becomes a flex line
 * and the extra button sits beside the switch, never inside it: a button inside
 * a button is invalid HTML and two click targets in one.
 *
 * Disabled dims the whole row, label and description with the track, the way
 * a disabled `SettingsRow` dims its text. The status sits tight under the
 * description: the row gives up its bottom padding to it.
 */
export function SettingsSwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  busy,
  status,
  trailing,
  searchable,
}: SettingsSwitchRowProps) {
  useSettingsRow(id, label, searchable);
  return (
    <div data-settings-row={id}>
      <div className="flex items-center">
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          busy={busy}
          label={label}
          description={description}
          dimRowWhenDisabled
          className={cn(
            "flex-1 rounded-none px-4 py-3",
            status && "pb-0",
            description ? "min-h-12" : "min-h-11",
            SETTINGS_INSET_FOCUS,
          )}
        />
        {trailing ? (
          <div className="flex shrink-0 items-center pr-3">{trailing}</div>
        ) : null}
      </div>
      {status ? <div className="px-4 pb-3">{status}</div> : null}
    </div>
  );
}
