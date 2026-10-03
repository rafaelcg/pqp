import { useState } from "react";
import { FEEDBACK_BODY_MAX_LENGTH, FEEDBACK_KINDS, type FeedbackKind } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { sendFeedback } from "@/lib/api";
import { buildFeedbackContext, type FeedbackVoiceContext } from "@/lib/feedback-context";
import { Field, chipClass } from "@/components/settings/ui";

/* ------------------------------------------------------------------- modal */

/**
 * The feedback box — bugs, ideas, gripes. A confirmed bug earns the caça-bugs
 * badge, which is the entire gamification budget of this feature: one fun
 * consequence, no points, no leaderboard.
 */
export function FeedbackSection({ voice }: { voice: FeedbackVoiceContext | null }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-paper" role="status">
          {t("settings.feedback.done")}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setSent(false);
            setBody("");
            setError(null);
          }}
        >
          {t("settings.feedback.again")}
        </Button>
      </div>
    );
  }

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      await sendFeedback({
        kind,
        body: body.trim(),
        context: buildFeedbackContext(voice),
      });
      setSent(true);
    } catch {
      setError(t("settings.feedback.error"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-paper-muted">{t("settings.feedback.intro")}</p>

      <Field label={t("settings.feedback.kind.label")}>
        <div
          role="radiogroup"
          aria-label={t("settings.feedback.kind.label")}
          className="flex flex-wrap gap-1.5"
        >
          {FEEDBACK_KINDS.map((option) => {
            const selected = option === kind;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setKind(option)}
                className={chipClass(selected)}
              >
                {t(FEEDBACK_KIND_LABELS[option])}
              </button>
            );
          })}
        </div>
      </Field>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={FEEDBACK_BODY_MAX_LENGTH}
        rows={5}
        placeholder={t("settings.feedback.placeholder")}
        aria-label={t("settings.section.feedback")}
        className="w-full resize-y rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      />

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={sending || body.trim().length === 0}
          onClick={() => void submit()}
        >
          {t("settings.feedback.send")}
        </Button>
        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="text-xs text-paper-muted">{t("settings.feedback.attached")}</p>
    </div>
  );
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kind.bug",
  idea: "settings.feedback.kind.idea",
  other: "settings.feedback.kind.other",
};
