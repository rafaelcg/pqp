import { useEffect, useId, useRef, useState } from "react";
import { Bug } from "lucide-react";
import { FEEDBACK_BODY_MAX_LENGTH, FEEDBACK_KINDS, type FeedbackKind } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsNotice,
  SettingsResult,
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
  const noteId = useId();
  const paneRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  // Enviar is disabled while the item is in flight, so focus would fall to the
  // page. After a send, hand it to the thanks line (the result is not a live
  // region, so focus is what reads it); after a failure, back to Enviar once
  // it is enabled again; after "Enviar outro", to the message.
  const focusAfter = useRef<"result" | "send" | "message" | null>(null);

  useEffect(() => {
    if (sending) return;
    if (focusAfter.current === "result") {
      paneRef.current
        ?.querySelector<HTMLElement>("[data-settings-result-title]")
        ?.focus();
    } else if (focusAfter.current === "send") {
      sendRef.current?.focus();
    } else if (focusAfter.current === "message") {
      messageRef.current?.focus();
    }
    focusAfter.current = null;
  }, [sent, sending]);

  if (sent) {
    return (
      <div ref={paneRef} className="space-y-6">
        <SettingsGroup>
          <SettingsResult
            tone="success"
            title={t("settings.feedback.done")}
            action={
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
            }
          />
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
      focusAfter.current = "result";
      setSent(true);
    } catch {
      focusAfter.current = "send";
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
    <div ref={paneRef} className="space-y-6">
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
        {/* The action row has no status slot, so a failed send is the row
            right above Enviar: a danger notice (role="alert", CircleX). */}
        {error ? (
          <SettingsNotice tone="danger" inGroup>
            {error}
          </SettingsNotice>
        ) : null}
        <SettingsActionRow id="send" note={t("settings.feedback.attached")} noteId={noteId}>
          <Button
            ref={sendRef}
            size="sm"
            aria-describedby={noteId}
            disabled={sending || body.trim().length === 0}
            onClick={() => void submit()}
          >
            {sending ? t("settings.feedback.sending") : t("settings.feedback.send")}
          </Button>
        </SettingsActionRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsNotice tone="info" icon={Bug} role="note" inGroup>
          {t("settings.feedback.intro")}
        </SettingsNotice>
      </SettingsGroup>
    </div>
  );
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kind.bug",
  idea: "settings.feedback.kind.idea",
  other: "settings.feedback.kind.other",
};
