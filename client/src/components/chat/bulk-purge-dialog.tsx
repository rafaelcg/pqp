import { useEffect, useState } from "react";
import { MESSAGE_BULK_DELETE_MAX } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * How many messages the presets offer. The last one is the server's cap, so
 * "everything this action can take" is always one click rather than a number
 * somebody has to know.
 */
const PRESETS = [10, 25, 50, MESSAGE_BULK_DELETE_MAX] as const;

const DEFAULT_COUNT = 25;

/**
 * "Clear recent messages" for one channel.
 *
 * The dialog *is* the confirmation. There is no second one, and there is no
 * path from the channel menu straight to a delete: picking a number and
 * pressing the danger button are two deliberate acts, and the body says the
 * count and that it cannot be undone before either of them happens.
 */
export function BulkPurgeDialog({
  open,
  channelName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  channelName: string;
  onConfirm: (count: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [count, setCount] = useState<number>(DEFAULT_COUNT);

  // Every visit starts from the same number. A dialog that remembered "100"
  // from last time is one Enter away from clearing a channel nobody meant to.
  useEffect(() => {
    if (open) {
      setCount(DEFAULT_COUNT);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("chat.purge.title")}
      description={t("chat.purge.body", { count, name: channelName })}
      size="sm"
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="grid w-full min-w-0 grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
            onClick={() => {
              onConfirm(count);
              onClose();
            }}
          >
            {t("chat.bulk.deleteAction", { count })}
          </Button>
        </div>
      }
    >
      <fieldset className="min-w-0">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-paper-muted">
          {t("chat.purge.howMany")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={count === preset}
              onClick={() => setCount(preset)}
              className={cn(
                "min-w-[3.5rem] rounded-md border px-3 py-1.5 text-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
                count === preset
                  ? "border-danger bg-danger/15 text-paper"
                  : "border-ink-4 text-paper-muted hover:text-paper",
              )}
            >
              {preset}
            </button>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
