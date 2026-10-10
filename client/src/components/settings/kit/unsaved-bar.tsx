import { Check } from "lucide-react";
import { SETTINGS_BUSY } from "@/components/settings/kit/classes";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface UnsavedChangesBarProps {
  /** Bumped on every press of Salvar, so a repeated refusal is said again. */
  attempt?: number;
  visible: boolean;
  saving: boolean;
  /** The save just landed: "Salvo" for a moment, then the shell hides the bar. */
  saved?: boolean;
  /**
   * A close was refused: the guard copy, a danger edge and a third way out,
   * "Continuar editando". The shell clears it as soon as the person edits
   * again, and the bar goes back to its ordinary copy.
   */
  blocked?: boolean;
  /** "Continuar editando": drops the guard and goes back to the fields. */
  onKeepEditing?: () => void;
  /**
   * Descartar just ran: "Alterações descartadas" with Desfazer for a few
   * seconds, instead of a confirm before it. The shell times it out.
   */
  discarded?: boolean;
  onUndoDiscard?: () => void;
  error?: string | null;
  onDiscard: () => void;
  onSave: () => void;
  /**
   * Shown from a tab that is not the edits' own: the message names Perfil and
   * this jumps there. Every other tab applies changes instantly, so a bare
   * "alterações não salvas" there reads as if the switch just touched were
   * the unsaved thing.
   */
  onShowSource?: () => void;
}

/**
 * The one place a Save button exists in Settings: staged profile edits only.
 * Everything else applies the moment it is touched.
 *
 * Shell only. It floats over the bottom of the pane rather than taking a row
 * under it, so the pane never changes height when it comes and goes; the shell
 * pads the scroller while it shows so the last group can scroll clear. The
 * wrapper lets clicks through to the pane, and only the bar itself takes them.
 *
 * The danger edge is a wrapper of its own because `elevation-2` writes the
 * border shorthand, which a `border-danger` on the same element loses to.
 */
export function UnsavedChangesBar({
  visible,
  saving,
  saved = false,
  blocked = false,
  onKeepEditing,
  discarded = false,
  onUndoDiscard,
  error = null,
  onDiscard,
  onSave,
  onShowSource,
  attempt = 0,
}: UnsavedChangesBarProps) {
  const { t } = useTranslation();
  // A moment after an action: a check, a line, and at most an undo.
  const settled = saved || discarded;
  const message = saved
    ? t("settings.status.saved")
    : discarded
      ? t("settings.unsaved.discarded")
    : blocked
      ? t("settings.unsaved.blocked")
      : onShowSource
        ? t("settings.unsaved.messageProfile")
        : t("settings.unsaved.message");

  // The live region is mounted before the bar and outlives it: a region
  // inserted already holding its text is often not announced, so the bar's
  // own line is plain text and this one speaks for it. It says the save
  // starting and a failure too, which the bar draws as plain text as well.
  const spoken = !visible
    ? ""
    : saving
      ? t("settings.saving")
      : error && !settled
        ? error
        : message;
  const announcer = (
    <p role="status" aria-live="polite" className="sr-only">
      {/* A new node per save attempt: the same refusal on a second press is
          still said. */}
      <span key={attempt}>{spoken}</span>
    </p>
  );
  if (!visible) {
    return announcer;
  }

  return (
    <>
      {announcer}
      <div
        data-unsaved-bar-frame=""
        className="safe-pb pointer-events-none absolute inset-x-0 bottom-0 px-4 sm:px-8"
      >
        <div
          className={cn(
            "pointer-events-auto mx-auto w-full max-w-[40rem] animate-pop-in rounded-[var(--radius-card)]",
            blocked && !settled && "border border-danger",
          )}
        >
          <div
            data-unsaved-bar=""
            className="elevation-2 flex w-full flex-wrap items-center gap-3 rounded-[var(--radius-card)] px-4 py-3"
          >
            {/* `min-w-40`: on a phone the buttons wrap under the message rather
                than squeezing it into a column of single words. */}
            <div className="min-w-40 flex-1">
              <p className="flex items-center gap-1.5 text-sm text-text">
                {settled ? (
                  <Check aria-hidden className="h-4 w-4 shrink-0 text-success" />
                ) : null}
                {message}
              </p>
              {error && !settled ? (
                <p data-unsaved-error="" className="mt-0.5 text-xs text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            {saved ? null : discarded ? (
              onUndoDiscard ? (
                <Button
                  data-unsaved-undo=""
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onUndoDiscard}
                >
                  {t("settings.unsaved.undo")}
                </Button>
              ) : null
            ) : (
              // Not `shrink-0`: on a phone the group takes the whole line and
              // its buttons wrap inside it instead of running off the bar.
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 max-sm:w-full max-sm:justify-end">
                {blocked && onKeepEditing ? (
                  // The shell focuses this one when a close is refused, so an
                  // Escape followed by a reflex Enter never saves by accident.
                  <Button
                    data-unsaved-continue=""
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onKeepEditing}
                  >
                    {t("settings.unsaved.keepEditing")}
                  </Button>
                ) : null}
                {onShowSource ? (
                  <Button type="button" variant="ghost" size="sm" onClick={onShowSource}>
                    {t("settings.unsaved.showProfile")}
                  </Button>
                ) : null}
                {/* Busy, not disabled, while the save runs: a disabled button
                    drops keyboard focus on the page. */}
                <Button
                  data-unsaved-discard=""
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-disabled={saving || undefined}
                  className={saving ? SETTINGS_BUSY : undefined}
                  onClick={() => {
                    if (!saving) onDiscard();
                  }}
                >
                  {t("settings.unsaved.discard")}
                </Button>
                <Button
                  data-unsaved-save=""
                  type="button"
                  size="sm"
                  aria-disabled={saving || undefined}
                  className={saving ? SETTINGS_BUSY : undefined}
                  onClick={() => {
                    if (!saving) onSave();
                  }}
                >
                  {saving ? t("settings.saving") : t("settings.unsaved.save")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
