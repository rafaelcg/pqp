import { Download, X } from "lucide-react";
import { DownloadSimple, X as XBold } from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";
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
    // Under the redesign, the top line of the user panel's card.
    <div className="flex items-center gap-0.5 border-b border-ink-4/40 px-1.5 py-1 redesign:mb-0.5 redesign:border-b-0 redesign:p-1">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] font-medium text-paper outline-none hover:bg-ink-2 focus-visible:ring-2 focus-visible:ring-signal/60 redesign:rounded-full redesign:px-2 redesign:text-[13px] redesign:text-text redesign:hover:bg-[color:var(--card-row-hover)] redesign:focus-visible:ring-accent"
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-signal redesign:hidden" aria-hidden />
        <Icon icon={DownloadSimple} kind="symbol" size="sm" className="hidden shrink-0 text-accent-text redesign:block" />
        <span className="truncate">{t("downloadHint.label")}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("downloadHint.dismiss")}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-2 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60 redesign:rounded-full redesign:text-text-tertiary redesign:hover:bg-[color:var(--card-row-hover)] redesign:hover:text-text redesign:focus-visible:ring-accent"
      >
        <X className="h-3.5 w-3.5 redesign:hidden" aria-hidden />
        <Icon icon={XBold} kind="symbol" size="sm" className="hidden h-3.5 w-3.5 redesign:block" />
      </button>
    </div>
  );
}
