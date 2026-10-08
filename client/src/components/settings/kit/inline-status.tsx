import { useEffect } from "react";
import { Check, CircleX, Loader2 } from "lucide-react";
import { useSettingsAnnounce } from "@/components/settings/kit/announcer";
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
  quiet = false,
}: {
  state: InlineSaveState;
  savingLabel?: string;
  /**
   * Plain text, never announced: for a line whose sentence something else
   * already says (the unsaved bar says a refused link). The field still points
   * at it with `aria-describedby`, so it is read when the field takes focus.
   */
  quiet?: boolean;
}) {
  const { t } = useTranslation();
  const dialogAnnounce = useSettingsAnnounce();
  const announce = quiet ? null : dialogAnnounce;
  const spoken =
    state.kind === "saving"
      ? (savingLabel ?? state.label ?? t("settings.saving"))
      : state.kind === "saved"
        ? t("settings.status.saved")
        : state.kind === "error"
          ? state.message
          : null;
  useEffect(() => {
    if (announce && spoken) announce(spoken);
  }, [announce, spoken]);
  // Inside Settings the dialog's announcer speaks, errors included: a line
  // created already holding its text is often not read, even as an alert.
  // Elsewhere the line is its own region, as before.
  const live =
    announce || quiet ? {} : ({ role: "status", "aria-live": "polite" } as const);
  const alert = announce || quiet ? {} : ({ role: "alert" } as const);

  if (state.kind === "idle") {
    return null;
  }
  if (state.kind === "saving") {
    return (
      <p {...live} className="mt-1.5 flex items-center gap-1.5 text-xs text-text-tertiary">
        <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
        {spoken}
      </p>
    );
  }
  if (state.kind === "saved") {
    return (
      <p
        {...live}
        className="mt-1.5 flex animate-fade-in items-center gap-1.5 text-xs text-text-secondary"
      >
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
        {spoken}
      </p>
    );
  }
  return (
    <p {...alert} className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
      <CircleX aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 text-pretty">{state.message}</span>
    </p>
  );
}
