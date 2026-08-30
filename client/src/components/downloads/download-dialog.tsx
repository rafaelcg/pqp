import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Link } from "react-router-dom";
import { PlatformPicker } from "@/components/downloads/platform-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DOWNLOAD_PAGE_PATH, DOWNLOAD_PAGE_URL } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";

/**
 * In-app "there is a native app" sheet.
 *
 * Opened from the user menu, only in a browser. The desktop shell already *is*
 * the app, so offering a download there would be a loop. Three marks — this
 * computer, iPhone, Android — because a sentence that only named the detected
 * desktop file hid the phones. The copy-link control always copies the hosted
 * URL: that is the string you paste into a chat, not whatever origin this tab
 * happens to be on. "See every platform" opens `/download` in a new tab so
 * this one stays on the server they were looking at.
 */
export function DownloadDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  function copy() {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopied(false);
      return;
    }
    void clipboard.writeText(DOWNLOAD_PAGE_URL).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <Dialog
      open={open}
      title={t("downloadDialog.title")}
      description={t("downloadDialog.body")}
      size="md"
      onClose={() => {
        setCopied(false);
        onClose();
      }}
    >
      <div className="space-y-5 px-5 py-5">
        <PlatformPicker onNavigate={onClose} />

        <div className="rounded-xl border border-ink-4 bg-ink/40 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-paper-muted">
            {t("downloadDialog.share")}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-sm text-paper">
              pqp.gg/download
            </p>
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? (
                <Check aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <Link2 aria-hidden className="h-3.5 w-3.5" />
              )}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
        </div>

        <p className="text-sm text-paper-muted">
          <Link
            to={DOWNLOAD_PAGE_PATH}
            target="_blank"
            rel="noopener"
            className="underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
            onClick={onClose}
          >
            {t("downloadDialog.all")}
          </Link>
        </p>
      </div>
    </Dialog>
  );
}
