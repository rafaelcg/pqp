import { useEffect, useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  OptionGroup,
  OptionRow,
} from "@/components/watch-party/watch-party-options";
import { suggestedWatchPartyName } from "@/lib/watch-party-name";
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
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    startsAt: string | null;
  }) => Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const [name, setName] = useState(() =>
    suggestedWatchPartyName(new Date(), locale),
  );
  const [scheduling, setScheduling] = useState(false);
  const [startsAt, setStartsAt] = useState(defaultSessionScheduleValue());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opened) {
      return;
    }
    setName(suggestedWatchPartyName(new Date(), locale));
    setScheduling(false);
    setStartsAt(defaultSessionScheduleValue());
    setBusy(false);
    setError(null);
  }, [open, locale]);

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
      <DialogBody className="flex flex-col gap-4">
        {/* THE NAME IS ALREADY THERE. A weekday ("Sessão de sábado"),
            selected, so Enter on an empty head works and anything typed
            replaces it. The old hint under the field ("this is the name at
            the top of the sidebar, not the channel's") is gone: the setup
            surface shows the name on the picture, which says it better. */}
        <label className="block">
          <span className="mb-1.5 block text-xs text-text-tertiary">
            {t("watchParty.create.nameLabel")}
          </span>
          <Input
            type="text"
            autoFocus
            maxLength={120}
            value={name}
            onFocus={(event) => event.currentTarget.select()}
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
        </label>
        {/* One switch, and the time only once it is on. Same grouped rows
            as the options dialog, so the two read as one product. */}
        <OptionGroup>
          <OptionRow
            label={t("watchParty.create.scheduleToggle")}
            description={t("watchParty.create.scheduleHint")}
          >
            <span data-create-watch-party-schedule>
              <Switch
                hideLabel
                label={t("watchParty.create.scheduleToggle")}
                checked={scheduling}
                onCheckedChange={setScheduling}
                className="px-0 py-0 hover:bg-transparent"
              />
            </span>
          </OptionRow>
          {scheduling && (
            <OptionRow
              label={t("watchParty.create.whenLabelShort")}
              description={browserTimezone()}
              htmlFor="create-watch-party-when"
            >
              <Input
                id="create-watch-party-when"
                type="datetime-local"
                className="h-[var(--control-sm)] w-auto bg-surface-2"
                value={startsAt}
                min={toLocalInputValue(new Date())}
                onChange={(event) => setStartsAt(event.target.value)}
                data-create-watch-party-when
              />
            </OptionRow>
          )}
        </OptionGroup>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
    </Dialog>
  );
}
