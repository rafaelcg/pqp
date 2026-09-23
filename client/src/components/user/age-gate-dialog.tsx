import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StepDots } from "@/components/onboarding/step-dots";
import { ApiError, submitAgeCheck } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { track, trackOnboardingStart } from "@/lib/track";

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
 *
 * FIRST SCREEN OF THE FIRST RUN, NOT A WINDOW OF ITS OWN. It draws the same
 * progress dots as the wizard (`StepDots`, screen one of `stepsTotal`) and,
 * once answered, stays on screen in its saving state until the app has loaded
 * and the wizard can take the same panel over without rising in again
 * (`handingOff`, then `Dialog entrance={false}` on the wizard). The copy is
 * one sentence and one warning: rule 2 above is the warning, and it still sits
 * above the button, before anything is submitted.
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
  /**
   * How many screens the whole first run has, this one included (2 for an
   * invite or an import link, 4 for a cold start). Omitted, no dots: an
   * account that is past onboarding but somehow still gated sees no counter.
   */
  stepsTotal?: number;
  /**
   * The answer was accepted and the app is loading behind this panel. The
   * fields lock and the button keeps saying "Saving…" until the wizard takes
   * over, so there is no loading screen flashed between the two.
   */
  handingOff?: boolean;
  /** For the funnel's `onboarding_start`: which path this run is on. */
  path?: "cold" | "invite" | "import";
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
  stepsTotal,
  handingOff = false,
  path,
}: AgeGateDialogProps) {
  const { t, locale } = useTranslation();
  const [parts, setParts] = useState<DateParts>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(status === "blocked");
  const monthRef = useRef<HTMLSelectElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  const busy = submitting || handingOff;

  const isoDate = toIsoDate(parts);

  useEffect(() => {
    if (status !== "pending" || !path) {
      return;
    }
    trackOnboardingStart({
      path,
      device: window.matchMedia?.("(max-width: 639px)").matches
        ? "phone"
        : "desktop",
      locale,
    });
    track("onboarding_step_view", { step: "age" });
    // Once per mount; the path cannot change under an open gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (!isoDate || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitAgeCheck(isoDate);
      if (result.ageGate === "passed") {
        track("age_gate_pass");
        onPassed();
        return;
      }
      track("age_gate_block");
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
        <>
          {stepsTotal ? <StepDots index={0} total={stepsTotal} /> : null}
          <Button
            data-age-gate-submit=""
            disabled={!isoDate || busy}
            onClick={() => void submit()}
          >
            {busy ? t("ageGate.submitting") : t("ageGate.submit")}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="min-w-0">
          {/* The fields carry their own labels; the legend is for a screen
              reader, which otherwise hears three boxes with no question. */}
          <legend className="sr-only">{t("ageGate.legend")}</legend>
          <div className="flex gap-2">
            <label className="w-20 shrink-0 text-xs font-medium text-text-secondary">
              {t("ageGate.day")}
              <Input
                className="mt-1.5 tabular-nums"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                placeholder={t("ageGate.day.placeholder")}
                autoComplete="bday-day"
                autoFocus
                disabled={busy}
                value={parts.day}
                onChange={(event) => {
                  const day = event.target.value.slice(0, 2);
                  setParts((current) => ({ ...current, day }));
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
                disabled={busy}
                value={parts.month}
                onChange={(event) => {
                  const month = event.target.value;
                  setParts((current) => ({ ...current, month }));
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
            <label className="w-24 shrink-0 text-xs font-medium text-text-secondary">
              {t("ageGate.year")}
              <Input
                ref={yearRef}
                className="mt-1.5 tabular-nums"
                type="number"
                inputMode="numeric"
                min={1900}
                placeholder={t("ageGate.year.placeholder")}
                autoComplete="bday-year"
                disabled={busy}
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

        {/* Rule 2: the consequence, stated before the button, once. */}
        <p className="text-pretty rounded-[var(--radius-card)] bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-on-warning-soft">
          {t("ageGate.warning", { age: MINIMUM_AGE_YEARS })}
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {/* Enter in any field submits; the visible button is in the footer. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
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
