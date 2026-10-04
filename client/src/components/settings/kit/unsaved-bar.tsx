import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface UnsavedChangesBarProps {
  visible: boolean;
  saving: boolean;
  /** The save just landed: "Salvo" for a moment, then the shell hides the bar. */
  saved?: boolean;
  /** A close was refused: the guard copy and a danger edge. */
  blocked?: boolean;
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
  error = null,
  onDiscard,
  onSave,
  onShowSource,
}: UnsavedChangesBarProps) {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }

  const message = saved
    ? t("settings.status.saved")
    : blocked
      ? t("settings.unsaved.blocked")
      : onShowSource
        ? t("settings.unsaved.messageProfile")
        : t("settings.unsaved.message");

  return (
    <div className="safe-pb pointer-events-none absolute inset-x-0 bottom-0 px-4 sm:px-8">
      <div
        className={cn(
          "pointer-events-auto mx-auto w-full max-w-[40rem] animate-pop-in rounded-[var(--radius-card)]",
          blocked && !saved && "border border-danger",
        )}
      >
        <div
          data-unsaved-bar=""
          className="elevation-2 flex w-full flex-wrap items-center gap-3 rounded-[var(--radius-card)] px-4 py-3"
        >
          {/* `min-w-40`: on a phone the buttons wrap under the message rather
              than squeezing it into a column of single words. */}
          <div className="min-w-40 flex-1">
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 text-sm text-text"
            >
              {saved ? (
                <Check aria-hidden className="h-4 w-4 shrink-0 text-success" />
              ) : null}
              {message}
            </p>
            {error && !saved ? (
              <p role="alert" className="mt-0.5 text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
          {saved ? null : (
            <div className="flex shrink-0 items-center gap-2">
              {onShowSource ? (
                <Button type="button" variant="ghost" size="sm" onClick={onShowSource}>
                  {t("settings.unsaved.showProfile")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={onDiscard}
              >
                {t("settings.unsaved.discard")}
              </Button>
              {/* The shell focuses this one when a close is refused. */}
              <Button
                data-unsaved-save=""
                type="button"
                size="sm"
                disabled={saving}
                onClick={onSave}
              >
                {saving ? t("settings.saving") : t("settings.unsaved.save")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
