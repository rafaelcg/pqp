import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import type { WatchPartyHistoryEntry } from "@/lib/watch-party-history-api";

/**
 * "Apagar gravação": the confirmation in front of a delete that cannot be
 * taken back.
 *
 * NOT `ConfirmDialog`. That one closes itself the instant Confirm is pressed,
 * which is right for a send and wrong here: this delete is a request that can
 * fail, and the person has to see it run (busy) and see why it did not (error)
 * without the sheet vanishing under them. So the parent owns `busy` and
 * `error`, and closes this on success.
 *
 * The destructive confirm is the red one, and CANCEL IS THE DEFAULT FOCUS, so
 * an Enter pressed straight after opening it backs out instead of deleting.
 * Escape cancels (the `Dialog`'s own behaviour) except while the request is in
 * flight, when leaving would only hide the outcome.
 */
export function DeleteBroadcastDialog({
  entry,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** The broadcast being asked about; null keeps the dialog closed. */
  entry: WatchPartyHistoryEntry | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useTranslation();
  const when = entry
    ? new Date(entry.startedAt).toLocaleString(intlLocale(locale), {
        dateStyle: "long",
        timeStyle: "short",
      })
    : "";
  return (
    <Dialog
      open={entry !== null}
      title={t("watchParty.history.delete.title")}
      size="sm"
      closeOnBackdrop={false}
      dismissible={!busy}
      onClose={onCancel}
      footer={
        <div className="grid w-full min-w-0 grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            autoFocus
            disabled={busy}
            data-testid="watch-party-history-delete-cancel"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center max-sm:min-h-11"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            aria-busy={busy}
            data-testid="watch-party-history-delete-confirm"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center max-sm:min-h-11"
            onClick={onConfirm}
          >
            {busy
              ? t("watchParty.history.delete.busy")
              : t("watchParty.history.delete.confirm")}
          </Button>
        </div>
      }
    >
      <DialogBody>
        {entry && (
          <div className="flex flex-col gap-3 text-sm">
            <div
              data-testid="watch-party-history-delete-name"
              className="min-w-0 rounded-[var(--radius-control)] bg-surface-1 px-3 py-2"
            >
              <p className="truncate font-semibold text-text">{entry.title}</p>
              <p className="mt-0.5 text-xs text-text-tertiary">{when}</p>
            </div>
            <p className="text-text-secondary">
              {t("watchParty.history.delete.body")}
            </p>
            <p className="font-medium text-text">
              {t("watchParty.history.delete.final")}
            </p>
            {error && (
              <p
                role="alert"
                data-testid="watch-party-history-delete-error"
                className="text-danger"
              >
                {error}
              </p>
            )}
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}
