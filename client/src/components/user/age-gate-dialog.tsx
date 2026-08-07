import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, submitAgeCheck } from "@/lib/api";

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
 * Every string is a plain sentence at the top level of its element, matching
 * `report-dialog.tsx`, so the day this app grows a string catalogue they lift
 * out cleanly. `client/src/lib/locale.ts` carries no app strings yet.
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

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
          ? "That is not a date we can read. Check the day, month and year."
          : "Could not save that. Check your connection and try again.",
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
      eyebrow="Before you start"
      title="Confirm your date of birth"
      description={`pqp is for people aged ${MINIMUM_AGE_YEARS} and over.`}
      size="sm"
      dismissible={false}
      onClose={() => {}}
      footer={
        <Button disabled={!isoDate || submitting} onClick={() => void submit()}>
          {submitting ? "Saving…" : "Continue"}
        </Button>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-paper-muted">
          We ask once, and we do not check it against any document — we are
          taking your word for it. Please make it accurate before you continue,
          because you cannot change this answer later.
        </p>

        <fieldset className="space-y-2">
          <legend className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            Date of birth
          </legend>
          <div className="flex gap-2">
            <label className="w-20 shrink-0 text-xs text-paper-muted">
              Day
              <Input
                className="mt-1"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                placeholder="DD"
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
              Month
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
                <option value="">Month</option>
                {MONTHS.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-24 shrink-0 text-xs text-paper-muted">
              Year
              <Input
                className="mt-1"
                type="number"
                inputMode="numeric"
                min={1900}
                placeholder="YYYY"
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
          You can only answer this once. If the date you enter is under{" "}
          {MINIMUM_AGE_YEARS}, this account will be closed and you will not be
          able to try a different date.
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
  return (
    <Dialog
      open
      eyebrow="Age check"
      title={`pqp is for ${MINIMUM_AGE_YEARS} and over`}
      size="sm"
      dismissible={false}
      onClose={() => {}}
      footer={
        <Button variant="secondary" asChild>
          <Link to="/">Back to pqp.gg</Link>
        </Button>
      }
    >
      <div className="space-y-3 px-5 py-4 text-sm text-paper-muted">
        <p>
          Thanks for answering honestly. The date of birth you gave is under{" "}
          {MINIMUM_AGE_YEARS}, so this account is closed. That is a rule about
          the service, not a judgement about you — pqp is built for adults and
          we are not able to make exceptions to it.
        </p>
        <p>
          If you entered the wrong date by mistake, you can ask us to look at it
          again. The appeals address is on our{" "}
          <Link to="/terms" className="text-signal underline">
            Terms
          </Link>{" "}
          page, along with the address for asking us to delete the account and
          the data attached to it.
        </p>
        <p>
          Please do not open another account in the meantime — we would rather
          settle this one.
        </p>
      </div>
    </Dialog>
  );
}
