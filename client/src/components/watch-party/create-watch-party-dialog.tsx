import { useEffect, useState } from "react";
import { Clapperboard } from "lucide-react";
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

/**
 * Step one of the journey: the party gets a name.
 *
 * DELIBERATELY SHORT. Everything else a host might want to decide (slow mode,
 * reactions, who talks, what is on screen) is decided on the setup surface
 * afterwards, with the preview in front of them, because that is where those
 * choices make sense. Asking for all of it in one modal before they have seen
 * anything is a form, and a form is what "start a watch party" must not feel
 * like.
 *
 * THE TIME IS OPTIONAL AND THAT IS THE FORK IN THE ROAD. No time creates a
 * `draft`: private, now, being set up. A time creates a `scheduled` party:
 * announced to the room, reminders on, and the same object that later goes
 * live. Both are the same row; see `docs/WATCH_PARTY.md`.
 */
export function CreateWatchPartyDialog({
  open,
  channelName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  channelName: string;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    startsAt: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [startsAt, setStartsAt] = useState(defaultSessionScheduleValue());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName("");
    setScheduling(false);
    setStartsAt(defaultSessionScheduleValue());
    setBusy(false);
    setError(null);
  }, [open]);

  const canSubmit = name.trim().length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        startsAt: scheduling ? new Date(startsAt).toISOString() : null,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("watchParty.create.error"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={t("watchParty.create.title")}
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
            data-create-watch-party-submit
          >
            <Clapperboard className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.create.submit")}
          </Button>
        </div>
      }
    >
      <DialogBody className="flex flex-col gap-3">
        <label className="block text-xs text-paper-muted">
          <span className="mb-1 block">{t("watchParty.create.nameLabel")}</span>
          <Input
            type="text"
            autoFocus
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSubmit) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("watchParty.create.namePlaceholder")}
            data-create-watch-party-name
          />
          <span className="mt-1 block text-[11px] text-paper-muted">
            {t("watchParty.create.nameHint")}
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-paper-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-signal"
            checked={scheduling}
            onChange={(event) => setScheduling(event.target.checked)}
            data-create-watch-party-schedule
          />
          {t("watchParty.create.scheduleToggle")}
        </label>
        {scheduling && (
          <label className="block text-xs text-paper-muted">
            <span className="mb-1 block">
              {t("watchParty.create.whenLabel", {
                timezone: browserTimezone(),
              })}
            </span>
            <Input
              type="datetime-local"
              value={startsAt}
              min={toLocalInputValue(new Date())}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
        )}
        <p className="text-[11px] text-paper-muted">
          {t("watchParty.setup.goLiveHint", { channel: `#${channelName}` })}
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
    </Dialog>
  );
}
