import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  onClose: () => void;
  onConfirm: (value: string, checked: boolean) => void;
}

export function PromptDialog({
  open,
  title,
  description,
  label = "Name",
  placeholder,
  confirmLabel = "Confirm",
  initialValue = "",
  checkboxLabel,
  checkboxDefault = false,
  onClose,
  onConfirm,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [checked, setChecked] = useState(checkboxDefault);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setChecked(checkboxDefault);
    }
  }, [open, initialValue, checkboxDefault]);

  if (!open) {
    return null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onConfirm(trimmed, checked);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/80 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={handleSubmit}
        className="animate-rise w-full rounded-t-2xl border border-ink-4 bg-ink-2 p-5 shadow-2xl sm:max-w-md sm:rounded-2xl"
      >
        <p className="text-xs uppercase tracking-[0.18em] text-signal">Channel</p>
        <h2 className="mb-1 font-display text-2xl font-bold">{title}</h2>
        {description && (
          <p className="mb-4 text-sm text-paper-muted">{description}</p>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {label}
          </span>
          <Input
            value={value}
            onChange={(e) =>
              setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/gi, ""))
            }
            placeholder={placeholder}
            autoFocus
          />
        </label>

        {checkboxLabel && (
          <label className="mb-4 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-signal)]"
            />
            <span className="text-sm">{checkboxLabel}</span>
          </label>
        )}

        <div className="flex justify-end gap-2 safe-pb">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
