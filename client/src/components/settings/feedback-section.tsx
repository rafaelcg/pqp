import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { FEEDBACK_BODY_MAX_LENGTH, FEEDBACK_KINDS, type FeedbackKind } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsGroup,
  SettingsInlineStatus,
  SettingsNotice,
  SettingsRow,
} from "@/components/settings/kit";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { sendFeedback } from "@/lib/api";
import { buildFeedbackContext, type FeedbackVoiceContext } from "@/lib/feedback-context";

/**
 * The feedback box: bugs, ideas, gripes. A confirmed bug earns the caça-bugs
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
  const messageId = useId();
  const counterId = useId();
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);
  // Enviar unmounts when the item lands, so focus would fall to the page.
  // Hand it to "Enviar outro", and back to the message after a reset.
  const focusAfter = useRef<"again" | "message" | null>(null);

  useEffect(() => {
    if (focusAfter.current === "again") {
      sentRef.current?.querySelector("button")?.focus();
    } else if (focusAfter.current === "message") {
      messageRef.current?.focus();
    }
    focusAfter.current = null;
  }, [sent]);

  if (sent) {
    return (
      <div className="space-y-6">
        <SettingsGroup>
          <div
            ref={sentRef}
            className="flex flex-col items-center gap-3 px-4 py-6 text-center"
          >
            <CircleCheck aria-hidden className="h-5 w-5 text-success" />
            <p role="status" className="text-sm text-pretty text-text">
              {t("settings.feedback.done")}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                focusAfter.current = "message";
                setSent(false);
                setBody("");
                setError(null);
              }}
            >
              {t("settings.feedback.again")}
            </Button>
          </div>
        </SettingsGroup>
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
      focusAfter.current = "again";
      setSent(true);
    } catch {
      setError(t("settings.feedback.error"));
    } finally {
      setSending(false);
    }
  };

  const kindOptions = FEEDBACK_KINDS.map((option) => ({
    value: option,
    label: t(FEEDBACK_KIND_LABELS[option]),
  }));

  return (
    <div className="space-y-6">
      <SettingsGroup>
        <SettingsRow
          id="kind"
          label={t("settings.feedback.kind.label")}
          control={
            <RadioGroup
              variant="chips"
              label={t("settings.feedback.kind.label")}
              value={kind}
              onValueChange={setKind}
              options={kindOptions}
            />
          }
        />
        <SettingsRow
          id="message"
          label={t("settings.feedback.message")}
          htmlFor={messageId}
          stacked
          control={
            <>
              <Textarea
                ref={messageRef}
                id={messageId}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={FEEDBACK_BODY_MAX_LENGTH}
                rows={5}
                placeholder={t("settings.feedback.placeholder")}
                aria-describedby={counterId}
              />
              <p
                id={counterId}
                className="mt-1.5 text-right text-xs tabular-nums text-text-secondary"
              >
                {t("settings.feedback.count", {
                  length: body.length,
                  max: FEEDBACK_BODY_MAX_LENGTH,
                })}
              </p>
            </>
          }
        />
        <SettingsRow
          id="send"
          label={t("settings.feedback.attachedLabel")}
          description={t("settings.feedback.attached")}
          status={
            error ? (
              <SettingsInlineStatus state={{ kind: "error", message: error }} />
            ) : null
          }
          control={
            <Button
              size="sm"
              disabled={sending || body.trim().length === 0}
              onClick={() => void submit()}
            >
              {sending ? t("settings.feedback.sending") : t("settings.feedback.send")}
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsNotice tone="info">{t("settings.feedback.intro")}</SettingsNotice>
    </div>
  );
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kind.bug",
  idea: "settings.feedback.kind.idea",
  other: "settings.feedback.kind.other",
};
