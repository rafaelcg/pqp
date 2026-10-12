import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/**
 * The host's watch party is going out without the film's sound because the
 * computer's sound would not open (PQP-31, `VoiceState.watchPartyShareSilent`).
 *
 * An ordinary share says this once in the notice strip, which hides itself
 * after 12 s. Here the whole audience is watching a silent film and only the
 * host can fix it, so the warning stays over the stage, in the warning colour,
 * for as long as the share is silent. Only the host's own close button takes
 * it down.
 */
/**
 * Whether the warning shows: while `active`, until the host closes it. A share
 * that stops being silent forgets the close, so the next silent one shows again.
 */
export function useWatchPartySilentShareWarning(active: boolean) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!active) {
      setDismissed(false);
    }
  }, [active]);
  return { shown: active && !dismissed, dismiss: () => setDismissed(true) };
}

export function WatchPartySilentShareWarning({
  onDismiss,
  measureRef,
}: {
  onDismiss: () => void;
  /** Attached to the strip, so the stage can make room for it. */
  measureRef?: (node: HTMLDivElement | null) => void | (() => void);
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={measureRef}
      role="alert"
      data-watch-party-silent-share
      className="absolute inset-x-0 top-0 z-20 flex items-start justify-center gap-2 border-b border-warning/40 bg-warning-soft px-3 py-2 text-left text-xs text-on-warning-soft"
    >
      <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 max-w-2xl">
        <span className="font-semibold">{t("voice.notice.watchPartyShareSilentTitle")}</span>{" "}
        {t("voice.notice.watchPartyShareSilent")}
      </p>
      <button
        type="button"
        aria-label={t("common.close")}
        className="shrink-0 rounded p-0.5 hover:bg-ink/10 focus-visible:outline focus-visible:outline-1"
        onClick={onDismiss}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
