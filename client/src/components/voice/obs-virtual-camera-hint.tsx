import { X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/**
 * One-line, dismissible tip shown under a camera picker when the selected
 * device looks like OBS's virtual camera (`lib/obs-virtual-camera.ts`).
 *
 * OBS Virtual Camera sends whatever the OBS scene shows, which is usually
 * the whole overlay (chat, alerts, the shared screen) rather than a face.
 * The fix lives entirely in OBS (Output type: Source), so this is advice,
 * not a control pqp can flip.
 */
export function ObsVirtualCameraHint({
  show,
  onDismiss,
}: {
  show: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  if (!show) {
    return null;
  }

  return (
    <div
      role="status"
      className="mt-2 flex items-start gap-2 rounded-md border border-ink-4 bg-ink-3/40 px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-xs text-paper-muted">
        {t("settings.voice.obsVirtualCameraHint")}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("settings.voice.obsVirtualCameraHint.dismiss")}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-2 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
