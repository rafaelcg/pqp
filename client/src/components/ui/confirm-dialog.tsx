import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Default true. Send confirms are a warning, not a delete. */
  destructive?: boolean;
}

/**
 * In-app replacement for `window.confirm`.
 *
 * Same Dialog as every other modal (focus trap, Escape, restore, scroll lock).
 * Footer is two equal-width tiles so Cancel and Confirm stay fully readable.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  destructive = true,
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      size="sm"
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="grid w-full grid-cols-2 gap-2">
          <Button type="button" variant="ghost" className="min-w-0" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "danger" : "default"}
            className="min-w-0"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {null}
    </Dialog>
  );
}
