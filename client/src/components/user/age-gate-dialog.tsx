import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, submitAgeCheck } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * The 18+ gate, as the user meets it.
 *
 * Three decisions here are deliberate and should survive a redesign:
 *
 *  1. A date, not a "yes I am 18" button. A neutral date field is what makes
 *     the declaration mean something — a yes/no button is answered by reflex
 *     and by everyone, which is why it enforces nothing.
 *
 *  2. The one-attempt rule is stated BEFORE the field, not after the refusal.
 *     A permanent consequence the user only learns about once it has happened
 *     is a trap; saying it up front is the difference between a rule and one.
 *
 *  3. There is no way out of this dialog. It is not dismissible, and there is
 *     no "later" — the app behind it is closed on the server, so a skip button
 *     would only produce a screen full of failed requests.
 *
 * The strings now come from `lib/i18n`. That matters more here than on a
 * marketing page: this dialog asks for a declaration with an irreversible
 * consequence, and a rule the reader cannot read is not a rule they agreed to.
 */

interface AgeGateDialogProps {
  /** The status `/api/me` reported. `passed` never reaches this component. */
  status: Exclude<AgeGateStatus, "passed">;
  /** Called once the account has cleared the gate — re-run the bootstrap. */
  onPassed: () => void;
  /**
   * Called when the server says this account has already answered and the
   * client's copy of the status is therefore stale (a second tab answered).
   * Re-reading `/api/me` is the whole recovery.
   */
  onStale: () => void;
}

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

/**
 * Three fields rather than one `<input type="date">`.
 *
 * A single date input renders in the browser's locale, so the same box means
 * DD/MM/YYYY to one person and MM/DD/YYYY to another — on an irreversible
 * answer, an ambiguous field is the wrong kind of clever. A named month cannot
 * be misread. The native picker also opens on today's date, which nudges toward
 * an answer nobody's birthday is.
 */
interface DateParts {
  day: string;
  month: string;
  year: string;
}

const EMPTY: DateParts = { day: "", month: "", year: "" };

/** `YYYY-MM-DD`, or null while the three fields are not yet a whole date. */
function toIsoDate(parts: DateParts): string | null {
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

export function AgeGateDialog({
  status,
  onPassed,
  onStale,
}: AgeGateDialogProps) {
  const { t } = useTranslation();
  const [parts, setParts] = useState<DateParts>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(status === "blocked");

  const isoDate = toIsoDate(parts);

  async function submit() {
    if (!isoDate || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitAgeCheck(isoDate);
      if (result.ageGate === "passed") {
        onPassed();
        return;
      }
      setBlocked(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onStale();
        return;
      }
      setError(
        err instanceof ApiError && err.status === 400
          ? t("ageGate.error.badDate")
          : t("ageGate.error.save"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (blocked) {
    return <AgeGateBlocked />;
  }

  return (
    <Dialog
      open
      eyebrow={t("ageGate.eyebrow")}
      title={t("ageGate.title")}
      description={t("ageGate.description", { age: MINIMUM_AGE_YEARS })}
      size="sm"
      dismissible={false}
      onClose={() => {}}
      footer={
        <Button disabled={!isoDate || submitting} onClick={() => void submit()}>
          {submitting ? t("ageGate.submitting") : t("ageGate.submit")}
        </Button>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-paper-muted">{t("ageGate.intro")}</p>

        <fieldset className="space-y-2">
          <legend className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            {t("ageGate.legend")}
          </legend>
          <div className="flex gap-2">
            <label className="w-20 shrink-0 text-xs text-paper-muted">
              {t("ageGate.day")}
              <Input
                className="mt-1"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                placeholder={t("ageGate.day.placeholder")}
                autoComplete="bday-day"
                disabled={submitting}
                value={parts.day}
                onChange={(event) =>
                  setParts((current) => ({
                    ...current,
                    day: event.target.value,
                  }))
                }
              />
            </label>
            <label className="min-w-0 flex-1 text-xs text-paper-muted">
              {t("ageGate.month")}
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:cursor-not-allowed disabled:opacity-50"
                autoComplete="bday-month"
                disabled={submitting}
                value={parts.month}
                onChange={(event) =>
                  setParts((current) => ({
                    ...current,
                    month: event.target.value,
                  }))
                }
              >
                <option value="">{t("ageGate.month")}</option>
                {MONTH_KEYS.map((key, index) => (
                  <option key={key} value={index + 1}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-24 shrink-0 text-xs text-paper-muted">
              {t("ageGate.year")}
              <Input
                className="mt-1"
                type="number"
                inputMode="numeric"
                min={1900}
                placeholder={t("ageGate.year.placeholder")}
                autoComplete="bday-year"
                disabled={submitting}
                value={parts.year}
                onChange={(event) =>
                  setParts((current) => ({
                    ...current,
                    year: event.target.value.slice(0, 4),
                  }))
                }
              />
            </label>
          </div>
        </fieldset>

        <p className="rounded-md border border-ink-4 bg-ink-3/40 px-3 py-2 text-xs text-paper-muted">
          {t("ageGate.warning", { age: MINIMUM_AGE_YEARS })}
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The final screen for an account that answered under 18.
 *
 * The reader may well be a child. The copy is written for that: it says what
 * happened and what can be done about it, it does not accuse anybody of lying,
 * and it does not dress a rule up as a punishment. It also does not suggest
 * signing up again, which is the one thing this screen must not do.
 */
function AgeGateBlocked() {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      eyebrow={t("ageGate.blocked.eyebrow")}
      title={t("ageGate.blocked.title", { age: MINIMUM_AGE_YEARS })}
      size="sm"
      dismissible={false}
      onClose={() => {}}
      footer={
        <Button variant="secondary" asChild>
          <Link to="/">{t("ageGate.blocked.back")}</Link>
        </Button>
      }
    >
      <div className="space-y-3 px-5 py-4 text-sm text-paper-muted">
        <p>{t("ageGate.blocked.body", { age: MINIMUM_AGE_YEARS })}</p>
        <p>
          {t("ageGate.blocked.appeal.before")}{" "}
          <Link to="/terms" className="text-signal underline">
            {t("ageGate.blocked.appeal.link")}
          </Link>
          {t("ageGate.blocked.appeal.after")}
        </p>
        <p>{t("ageGate.blocked.wait")}</p>
      </div>
    </Dialog>
  );
}
