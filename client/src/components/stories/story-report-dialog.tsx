import { useEffect, useState } from "react";
import type { ReportReason } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, createReport } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * "Denunciar story" (design D2). The reasons are the story's own short list,
 * each mapped onto the shared report reasons. "Menor de idade em conteúdo
 * sexual" is `minor_sexual`, the one reason that routes to the instance queue
 * whatever the context, which is why its row says so out loud.
 *
 * `serverId` is the audience the story was seen through; null is the friends
 * audience, which goes to the instance queue like a conversation does.
 */

const OPTIONS: { value: ReportReason; label: MessageKey; hint?: MessageKey }[] = [
  { value: "minor_sexual", label: "stories.report.minor", hint: "stories.report.minorHint" },
  { value: "sexual_content", label: "stories.report.ncii" },
  { value: "harassment", label: "stories.report.harassment" },
  { value: "violence", label: "stories.report.violence" },
  { value: "spam", label: "stories.report.spam" },
  { value: "other", label: "stories.report.other" },
];

interface StoryReportDialogProps {
  target: { storyId: string; serverId: string | null } | null;
  onClose: () => void;
  onSent: () => void;
}

export function StoryReportDialog({ target, onClose, onSent }: StoryReportDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason("");
    setDetails("");
    setError(null);
    setSending(false);
  }, [target?.storyId]);

  if (!target) {
    return null;
  }

  async function submit() {
    if (!target || !reason) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await createReport({
        subjectType: "story",
        storyId: target.storyId,
        serverId: target.serverId,
        reason,
        details: details.trim() || null,
      });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError && err.status !== 0 ? err.message : t("stories.report.failed"));
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      title={t("stories.report.title")}
      description={t("stories.report.body")}
      size="sm"
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={sending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={!reason || sending}
            onClick={() => void submit()}
          >
            {sending ? t("stories.report.sending") : t("stories.report.send")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 px-5 py-4">
        <RadioGroup
          variant="list"
          label={t("stories.report.title")}
          value={reason}
          onValueChange={(value) => setReason(value as ReportReason)}
          options={OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            ...(option.hint ? { description: t(option.hint) } : {}),
          }))}
        />
        <Textarea
          value={details}
          maxLength={1000}
          rows={2}
          className="min-h-16"
          disabled={sending}
          aria-label={t("report.detailsLabel")}
          placeholder={t("report.placeholder")}
          onChange={(event) => setDetails(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
