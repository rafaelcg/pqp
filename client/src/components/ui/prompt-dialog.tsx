import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CHANNEL_NAME_MAX_LENGTH,
  sanitizeChannelName,
} from "@/lib/channel-name";
import { useTranslation } from "@/lib/i18n";

interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  initialValue?: string;
  checkboxLabel?: string;
  checkboxDefault?: boolean;
  /**
   * An optional second, free-text field under the name (a watch party's
   * short description). Rendered only when a placeholder is given; its
   * trimmed value comes back as the third argument of `onConfirm`, empty
   * when the person left it blank. Existing callers ignore the argument.
   */
  secondaryLabel?: string;
  secondaryPlaceholder?: string;
  secondaryMaxLength?: number;
  onClose: () => void;
  /**
   * A rejection is shown inside the dialog, under the field, and the dialog
   * stays open with what was typed. A page-level banner would sit behind the
   * modal overlay, where nobody reads it.
   */
  onConfirm: (
    value: string,
    checked: boolean,
    secondary: string,
  ) => void | Promise<void>;
}

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  confirmLabel,
  initialValue = "",
  checkboxLabel,
  checkboxDefault = false,
  secondaryLabel,
  secondaryPlaceholder,
  secondaryMaxLength = 200,
  onClose,
  onConfirm,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [secondary, setSecondary] = useState("");
  const [checked, setChecked] = useState(checkboxDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setSecondary("");
      setChecked(checkboxDefault);
      setBusy(false);
      setError(null);
    }
  }, [open, initialValue, checkboxDefault]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    // Enter fires as fast as you can press it, and creating a channel is a
    // round trip — without this guard a double tap creates two channels.
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed, checked, secondary.trim());
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t("chrome.channelActionFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("channelMeta.eyebrow")}
      title={title}
      description={description}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!value.trim() || busy}>
            {busy ? t("common.working") : (confirmLabel ?? t("common.save"))}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void handleSubmit(event)}
        className="space-y-3 px-5 py-4"
      >
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
            {label ?? t("channelSettings.name")}
          </span>
          <Input
            value={value}
            onChange={(e) => {
              setValue(sanitizeChannelName(e.target.value));
              setError(null);
            }}
            placeholder={placeholder}
            maxLength={CHANNEL_NAME_MAX_LENGTH}
            aria-invalid={error ? true : undefined}
            disabled={busy}
            autoFocus
          />
        </label>

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {secondaryPlaceholder !== undefined && (
          <label className="block">
            {secondaryLabel && (
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                {secondaryLabel}
              </span>
            )}
            <Input
              value={secondary}
              onChange={(e) =>
                setSecondary(e.target.value.slice(0, secondaryMaxLength))
              }
              placeholder={secondaryPlaceholder}
              maxLength={secondaryMaxLength}
              disabled={busy}
            />
          </label>
        )}

        {checkboxLabel && (
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <span className="text-sm">{checkboxLabel}</span>
          </label>
        )}
      </form>
    </Dialog>
  );
}
