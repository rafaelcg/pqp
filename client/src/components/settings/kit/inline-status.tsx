import { Check, CircleX, Loader2 } from "lucide-react";
import type { InlineSaveState } from "@/components/settings/kit/use-inline-save";
import { useTranslation } from "@/lib/i18n";

/**
 * What happened to the write a row just made, said in that row: never a toast,
 * never a line at the bottom of the pane. Renders nothing when idle.
 *
 * The saving line reads "Salvando…" unless `savingLabel` (or the state's own
 * `label`, set by `useInlineSave({ savingLabel })`) says otherwise.
 */
export function SettingsInlineStatus({
  state,
  savingLabel,
}: {
  state: InlineSaveState;
  savingLabel?: string;
}) {
  const { t } = useTranslation();
  if (state.kind === "idle") {
    return null;
  }
  if (state.kind === "saving") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-1.5 flex items-center gap-1.5 text-xs text-text-tertiary"
      >
        <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
        {savingLabel ?? state.label ?? t("settings.saving")}
      </p>
    );
  }
  if (state.kind === "saved") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-1.5 flex animate-fade-in items-center gap-1.5 text-xs text-text-secondary"
      >
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
        {t("settings.status.saved")}
      </p>
    );
  }
  return (
    <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
      <CircleX aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 text-pretty">{state.message}</span>
    </p>
  );
}
