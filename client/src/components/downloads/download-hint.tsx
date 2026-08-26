import { Download, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/**
 * One-line invite above the user row. The sidebar is 16rem: keep this a
 * single truncated sentence plus a dismiss control, not a second panel.
 */
export function DownloadHint({
  onOpen,
  onDismiss,
}: {
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-0.5 border-b border-ink-4/40 px-1.5 py-1">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] font-medium text-paper outline-none hover:bg-ink-2 focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-signal" aria-hidden />
        <span className="truncate">{t("downloadHint.label")}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("downloadHint.dismiss")}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-2 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
