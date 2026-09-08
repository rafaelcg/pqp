import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  browserTimezone,
  defaultSessionScheduleValue,
  toLocalInputValue,
} from "@/lib/channel-session-schedule";
import { useTranslation } from "@/lib/i18n";
import type { ChannelSession } from "@pqp/shared";

/**
 * "Agendar sessão": title, date/time (native `datetime-local`, same pattern
 * as the Baú schedule form in community-home-feed.tsx), optional
 * description. Reused for both creating a new session and editing the one
 * upcoming session a channel may have (the server enforces one active
 * session per channel).
 */
export function ScheduleSessionSheet({
  open,
  existing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** Present when editing the channel's existing scheduled session. */
  existing?: ChannelSession | null;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    startsAt: string;
    description: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState(defaultSessionScheduleValue());
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setBusy(false);
    if (existing) {
      setTitle(existing.title);
      setStartsAt(toLocalInputValue(new Date(existing.startsAt)));
      setDescription(existing.description ?? "");
    } else {
      setTitle("");
      setStartsAt(defaultSessionScheduleValue());
      setDescription("");
    }
  }, [open, existing]);

  const timezone = browserTimezone();
  const canSubmit = title.trim().length > 0 && startsAt.length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        startsAt: new Date(startsAt).toISOString(),
        description: description.trim().length > 0 ? description.trim() : null,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : t("watchPartySchedule.sheet.genericError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={
        existing
          ? t("watchPartySchedule.sheet.editTitle")
          : t("watchPartySchedule.sheet.title")
      }
      size="sm"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-schedule-session-submit
          >
            <CalendarClock className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {existing
              ? t("watchPartySchedule.sheet.save")
              : t("watchPartySchedule.sheet.submit")}
          </Button>
        </div>
      }
    >
      <DialogBody className="flex flex-col gap-3">
        <label className="block text-xs text-paper-muted">
          <span className="mb-1 block">{t("watchPartySchedule.sheet.titleLabel")}</span>
          <Input
            type="text"
            autoFocus
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("watchPartySchedule.sheet.titlePlaceholder")}
            data-schedule-session-title
          />
        </label>
        <label className="block text-xs text-paper-muted">
          <span className="mb-1 block">
            {t("watchPartySchedule.sheet.whenLabel", { timezone })}
          </span>
          <Input
            type="datetime-local"
            value={startsAt}
            min={toLocalInputValue(new Date())}
            onChange={(event) => setStartsAt(event.target.value)}
            data-schedule-session-starts-at
          />
        </label>
        <label className="block text-xs text-paper-muted">
          <span className="mb-1 block">
            {t("watchPartySchedule.sheet.descriptionLabel")}
          </span>
          <textarea
            rows={3}
            maxLength={2000}
            className="w-full resize-none rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-tertiary/70"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("watchPartySchedule.sheet.descriptionPlaceholder")}
          />
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
    </Dialog>
  );
}
