import { Slider } from "@/components/ui/slider";
import { SettingsRow } from "@/components/settings/kit/row";

export interface SettingsSliderRowProps {
  id: string;
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** The readout, for example `t("settings.voice.percent", { percent })`. */
  format: (value: number) => string;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  disabled?: boolean;
  /** `false` keeps the row out of the settings registry (see `SettingsRow`). */
  searchable?: boolean;
}

/**
 * A number on a `Slider` with its value read out beside it. Always stacked: a
 * slider squeezed into the right half of a row is too short to aim.
 */
export function SettingsSliderRow({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  format,
  onValueChange,
  onValueCommit,
  disabled,
  searchable,
}: SettingsSliderRowProps) {
  const readout = format(value);
  return (
    <SettingsRow
      id={id}
      label={label}
      description={description}
      disabled={disabled}
      searchable={searchable}
      stacked
      control={
        <div className="flex items-center gap-3">
          <Slider
            variant="volume"
            className="flex-1"
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={label}
            aria-valuetext={readout}
            onValueChange={onValueChange}
            onValueCommit={onValueCommit}
          />
          <span
            aria-hidden
            className="w-12 shrink-0 text-right text-xs tabular-nums text-text-secondary"
          >
            {readout}
          </span>
        </div>
      }
    />
  );
}
