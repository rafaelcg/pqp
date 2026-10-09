import { useRef } from "react";
import { Input } from "@/components/ui/input";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The three date-of-birth fields, shared by the account's age gate
 * (`age-gate-dialog.tsx`) and the signed-out live preview's age step
 * (`components/live-preview/live-preview-panel.tsx`), so both ask the same
 * question the same way.
 *
 * Three fields rather than one `<input type="date">`. A single date input
 * renders in the browser's locale, so the same box means DD/MM/YYYY to one
 * person and MM/DD/YYYY to another; on an answer that decides something, an
 * ambiguous field is the wrong kind of clever. A named month cannot be
 * misread. The native picker also opens on today's date, which nudges toward
 * an answer nobody's birthday is.
 */

/**
 * Month labels by number. The value submitted is the index, never the label, so
 * translating these cannot change what the form means.
 */
const MONTH_KEYS: MessageKey[] = [
  "ageGate.month.1",
  "ageGate.month.2",
  "ageGate.month.3",
  "ageGate.month.4",
  "ageGate.month.5",
  "ageGate.month.6",
  "ageGate.month.7",
  "ageGate.month.8",
  "ageGate.month.9",
  "ageGate.month.10",
  "ageGate.month.11",
  "ageGate.month.12",
];

export interface DateParts {
  day: string;
  month: string;
  year: string;
}

export const EMPTY_DATE_PARTS: DateParts = { day: "", month: "", year: "" };

/** `YYYY-MM-DD`, or null while the three fields are not yet a whole date. */
export function toIsoDate(parts: DateParts): string | null {
  const day = Number(parts.day);
  const month = Number(parts.month);
  const year = Number(parts.year);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  // Four digits, and not the year somebody is halfway through typing.
  if (!Number.isInteger(year) || parts.year.length !== 4 || year < 1900) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function BirthDateFields({
  parts,
  onChange,
  disabled = false,
  autoFocus = false,
  compact = false,
}: {
  parts: DateParts;
  onChange: (update: (current: DateParts) => DateParts) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Narrower day and year boxes, for a card inside a phone-width column. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const monthRef = useRef<HTMLSelectElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  return (
    <fieldset className="min-w-0">
      {/* The fields carry their own labels; the legend is for a screen
          reader, which otherwise hears three boxes with no question. */}
      <legend className="sr-only">{t("ageGate.legend")}</legend>
      <div className="flex gap-2">
        <label
          className={cn(
            "shrink-0 text-xs font-medium text-text-secondary",
            compact ? "w-16" : "w-20",
          )}
        >
          {t("ageGate.day")}
          <Input
            className="mt-1.5 tabular-nums"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            placeholder={t("ageGate.day.placeholder")}
            autoComplete="bday-day"
            autoFocus={autoFocus}
            disabled={disabled}
            value={parts.day}
            onChange={(event) => {
              const day = event.target.value.slice(0, 2);
              onChange((current) => ({ ...current, day }));
              // Two digits is a whole day (or "0" plus a digit): move on,
              // so a phone keyboard never has to be dismissed to reach
              // the month. One digit waits, because "3" could be "31".
              if (day.length === 2) {
                monthRef.current?.focus();
              }
            }}
          />
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-text-secondary">
          {t("ageGate.month")}
          <select
            ref={monthRef}
            className="mt-1.5 flex h-10 w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            autoComplete="bday-month"
            disabled={disabled}
            value={parts.month}
            onChange={(event) => {
              const month = event.target.value;
              onChange((current) => ({ ...current, month }));
              if (month) {
                yearRef.current?.focus();
              }
            }}
          >
            <option value="">{t("ageGate.month")}</option>
            {MONTH_KEYS.map((key, index) => (
              <option key={key} value={index + 1}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label
          className={cn(
            "shrink-0 text-xs font-medium text-text-secondary",
            compact ? "w-20" : "w-24",
          )}
        >
          {t("ageGate.year")}
          <Input
            ref={yearRef}
            className="mt-1.5 tabular-nums"
            type="number"
            inputMode="numeric"
            min={1900}
            placeholder={t("ageGate.year.placeholder")}
            autoComplete="bday-year"
            disabled={disabled}
            value={parts.year}
            onChange={(event) => {
              const year = event.target.value.slice(0, 4);
              onChange((current) => ({ ...current, year }));
            }}
          />
        </label>
      </div>
    </fieldset>
  );
}
