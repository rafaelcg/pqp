import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * What a typed channel name becomes, keystroke by keystroke.
 *
 * Accents FOLD instead of vanishing — a Brazilian keyboard produces `ç` and
 * `ã` by reflex, and stripping them turns "caça-bugs" into "caa-bugs", a
 * misspelling nobody typed. Same argument `normalizeHandle` makes for
 * handles. Spaces become hyphens for the same reason: "mesa de rpg" means
 * "mesa-de-rpg", not "mesaderpg".
 */
export function sanitizeChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

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
  onConfirm: (value: string, checked: boolean) => void | Promise<void>;
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
  const [busy, setBusy] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setChecked(checkboxDefault);
      setBusy(false);
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
    try {
      await onConfirm(trimmed, checked);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow="Channel"
      title={title}
      description={description}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!value.trim() || busy}>
            {busy ? "Working…" : confirmLabel}
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
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {label}
          </span>
          <Input
            value={value}
            onChange={(e) => setValue(sanitizeChannelName(e.target.value))}
            placeholder={placeholder}
            disabled={busy}
            autoFocus
          />
        </label>

        {checkboxLabel && (
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-signal)]"
            />
            <span className="text-sm">{checkboxLabel}</span>
          </label>
        )}
      </form>
    </Dialog>
  );
}
