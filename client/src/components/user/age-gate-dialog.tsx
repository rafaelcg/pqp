import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { useEffect, useState } from "react";
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
import { ApiError, submitAgeCheck } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
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

export function AgeGateDialog({
  status,
  onPassed,
  onStale,
  stepsTotal,
  handingOff = false,
  path,
}: AgeGateDialogProps) {
  const { t, locale } = useTranslation();
  const [parts, setParts] = useState<DateParts>(EMPTY_DATE_PARTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(status === "blocked");
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
        <BirthDateFields
          parts={parts}
          onChange={setParts}
          disabled={busy}
          autoFocus
        />

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
