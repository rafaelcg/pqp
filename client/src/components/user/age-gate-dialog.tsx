import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { StepDots } from "@/components/onboarding/step-dots";
import {
  BirthDateFields,
  EMPTY_DATE_PARTS,
  toIsoDate,
  type DateParts,
} from "@/components/user/birth-date-fields";
import { formatBirthDateInWords } from "@/lib/age-readback";
import { ApiError, submitAgeCheck } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { track, trackOnboardingStart } from "@/lib/track";
import { cn } from "@/lib/utils";

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
 *
 * THE READ-BACK. A typed date is the one input here nobody can take back, and
 * the usual way it goes wrong is a slip (a swapped day and month, a year that
 * is not the one meant), not a lie. So, with `readback` on, Continue does not
 * send anything: it says the date back in words, in the person's own language
 * ("Tu nasceu em 3 de dezembro de 2008"), and only "Está certo" sends it.
 * Everybody gets the same screen, pass or block: it shows nothing the warning
 * above the button does not already say, and it adds no way to learn the
 * verdict before committing. It is a kill switch (`age_gate_readback`), and off
 * is exactly the direct submit this dialog always had.
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
  /**
   * Say the date back in words before sending it (`ageGateReadback` on
   * `GET /api/me`, the `age_gate_readback` flag). Off or absent: Continue
   * sends, as it always did.
   */
  readback?: boolean;
}

type Step = "fields" | "readback";

export function AgeGateDialog({
  status,
  onPassed,
  onStale,
  stepsTotal,
  handingOff = false,
  path,
  readback = false,
}: AgeGateDialogProps) {
  const { t, locale } = useTranslation();
  const [parts, setParts] = useState<DateParts>(EMPTY_DATE_PARTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(status === "blocked");
  const [step, setStep] = useState<Step>("fields");
  // The step slides in only once there has been a step to leave: the first
  // paint is the dialog's own entrance.
  const [moved, setMoved] = useState(false);
  // Back to the year when the server said the year looks wrong.
  const [focusYear, setFocusYear] = useState(false);
  const readbackRef = useRef<HTMLDivElement>(null);
  const busy = submitting || handingOff;

  const isoDate = toIsoDate(parts);
  const inWords = isoDate ? formatBirthDateInWords(isoDate, locale) : null;
  const readingBack = step === "readback" && inWords !== null;

  function goTo(next: Step) {
    setStep(next);
    setMoved(true);
  }

  function goBack() {
    setError(null);
    setFocusYear(false);
    goTo("fields");
    track("age_gate_readback_edit");
  }

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

  // The read-back takes focus itself, not its button: a person who reflexively
  // presses Enter as the screen changes would otherwise confirm a date they
  // have not yet read, which is the whole thing this step exists to prevent.
  // The group's label is the sentence, so a screen reader says it on arrival.
  useEffect(() => {
    if (readingBack) {
      readbackRef.current?.focus();
    }
  }, [readingBack]);

  // Escape steps back. It never closes the gate: the dialog is not dismissible,
  // and `Dialog` swallows Escape for that reason, so the step listens itself.
  useEffect(() => {
    if (!readingBack || busy) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        goBack();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // `goBack` only sets state and tracks; it holds nothing the listener needs
    // to be re-bound for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingBack, busy]);

  // With the read-back off the fields never unmount between a refusal and the
  // retry, so `autoFocus` has nothing to act on: put the cursor in the year
  // by hand when the server said the year looks wrong.
  useEffect(() => {
    if (focusYear && step === "fields" && error) {
      document
        .querySelector<HTMLInputElement>('input[autocomplete="bday-year"]')
        ?.focus();
    }
  }, [focusYear, step, error]);

  /** Continue: say the date back first when the switch is on, else send it. */
  function onContinue() {
    if (!isoDate || busy) {
      return;
    }
    if (!readback) {
      void submit();
      return;
    }
    if (!inWords) {
      // Not a real calendar date (31 February). Said back in words it would
      // become some other day, so it never gets that far; the server would
      // refuse it all the same, this just saves the round trip.
      setError(t("ageGate.error.badDate"));
      return;
    }
    setError(null);
    goTo("readback");
  }

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
      if (err instanceof ApiError && err.status === 400) {
        // The server did not take it as an answer and the attempt is not
        // spent: back to the fields with what was typed still in them. A
        // year that is too recent gets its own sentence and the cursor.
        const yearLooksWrong = errorCode(err) === "birth_date_implausible";
        setError(
          yearLooksWrong
            ? t("ageGate.error.checkYear")
            : t("ageGate.error.badDate"),
        );
        setFocusYear(yearLooksWrong);
        if (yearLooksWrong) {
          track("age_gate_year_check");
        }
        goTo("fields");
        return;
      }
      setError(t("ageGate.error.save"));
    } finally {
      setSubmitting(false);
    }
  }

  if (blocked) {
    return <AgeGateBlocked />;
  }

  // Rule 2: the consequence, stated before the button, once. Shown on the
  // read-back too, because that is the screen whose button actually sends.
  const warning = (
    <p className="text-pretty rounded-[var(--radius-card)] bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-on-warning-soft">
      {t("ageGate.warning", { age: MINIMUM_AGE_YEARS })}
    </p>
  );
  const errorLine = error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;

  return (
    <Dialog
      open
      eyebrow={t("ageGate.eyebrow")}
      title={readingBack ? t("ageGate.readback.title") : t("ageGate.title")}
      description={
        readingBack
          ? undefined
          : t("ageGate.description", { age: MINIMUM_AGE_YEARS })
      }
      headerKey={moved ? (readingBack ? "readback" : "fields") : undefined}
      size="sm"
      dismissible={false}
      onClose={() => {}}
      footer={
        <>
          {stepsTotal ? <StepDots index={0} total={stepsTotal} /> : null}
          {readingBack ? (
            <>
              <Button
                variant="secondary"
                data-age-gate-edit=""
                disabled={busy}
                onClick={goBack}
              >
                {t("ageGate.readback.edit")}
              </Button>
              <Button
                data-age-gate-confirm=""
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? t("ageGate.submitting") : t("ageGate.readback.confirm")}
              </Button>
            </>
          ) : (
            <Button
              data-age-gate-submit=""
              disabled={!isoDate || busy}
              onClick={onContinue}
            >
              {busy ? t("ageGate.submitting") : t("ageGate.submit")}
            </Button>
          )}
        </>
      }
    >
      {readingBack ? (
        // No <form> here on purpose: Enter does something only on a button that
        // has focus, never from the page.
        <div
          ref={readbackRef}
          role="group"
          tabIndex={-1}
          aria-label={`${t("ageGate.readback.born", { date: inWords })} ${t("ageGate.readback.check")}`}
          data-age-gate-readback=""
          className={cn(
            "space-y-4 px-5 py-4 outline-none",
            moved && "animate-step-in",
          )}
        >
          <div className="space-y-1.5">
            <p className="text-balance font-display text-xl font-semibold leading-snug text-text">
              {t("ageGate.readback.born", { date: inWords })}
            </p>
            <p className="text-sm text-text-secondary">
              {t("ageGate.readback.check")}
            </p>
          </div>
          {warning}
          {errorLine}
        </div>
      ) : (
        <form
          className={cn("space-y-4 px-5 py-4", moved && "animate-step-in")}
          onSubmit={(event) => {
            event.preventDefault();
            onContinue();
          }}
        >
          <BirthDateFields
            parts={parts}
            onChange={setParts}
            disabled={busy}
            autoFocus
            focusField={focusYear ? "year" : "day"}
          />

          {warning}

          {errorLine}
          {/* Enter in any field continues; the visible button is in the footer. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Dialog>
  );
}

/** The server's stable `code` on a 400, when it sent one. */
function errorCode(err: ApiError): string | null {
  const details = err.details;
  if (details && typeof details === "object" && "code" in details) {
    const code = (details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
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
        {/* The way back is on the screen itself, not one link away: somebody
            who typed the wrong date should not have to find it. The Terms say
            the same thing (write from the account's email). */}
        <p data-age-gate-contact="">
          {t("ageGate.blocked.contact.before")}{" "}
          <a href="mailto:contato@pqp.gg" className="text-signal underline">
            contato@pqp.gg
          </a>{" "}
          {t("ageGate.blocked.contact.after")}
        </p>
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
