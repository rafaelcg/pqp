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
  /** Under the row, for example a notice or a `SettingsInlineStatus`. */
  status?: ReactNode;
  /** A secondary action beside the switch, for example an icon-only "Ouvir". */
  trailing?: ReactNode;
}

/**
 * An on/off setting. The whole row is the `Switch`, so the row is the hit
 * target and the role is `switch`. With `trailing` the row becomes a flex line
 * and the extra button sits beside the switch, never inside it: a button inside
 * a button is invalid HTML and two click targets in one.
 */
export function SettingsSwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  status,
  trailing,
}: SettingsSwitchRowProps) {
  useSettingsRow(id, label);
  return (
    <div data-settings-row={id}>
      <div className="flex items-center">
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          label={label}
          description={description}
          className={cn(
            "flex-1 rounded-none px-4 py-3",
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
