import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  registerServiceWorker,
  type ServiceWorkerControls,
} from "@/lib/register-sw";

/**
 * "A new version is ready" — the visible half of `registerType: "prompt"`.
 *
 * The reload is never taken automatically. This client holds a live WebSocket,
 * unsent composer drafts, and possibly an active call; swapping the bundle out
 * from under any of those is a worse outcome than running yesterday's build for
 * another minute. So it asks, and it can be dismissed.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const controlsRef = useRef<ServiceWorkerControls | null>(null);

  useEffect(() => {
    const controls = registerServiceWorker(() => setNeedsRefresh(true));
    controlsRef.current = controls;
    return () => controls.dispose();
  }, []);

  if (!needsRefresh || dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-2 rounded-lg border border-ink-4 bg-ink-2 px-4 py-3 shadow-lg sm:inset-x-auto sm:right-4"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-paper">
        {t("update.ready")}
      </p>
      <Button
        size="sm"
        disabled={updating}
        onClick={() => {
          setUpdating(true);
          // The worker takes over and reloads the page itself.
          void controlsRef.current?.update();
        }}
      >
        {updating ? t("update.updating") : t("update.reload")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("update.dismiss")}
        onClick={() => setDismissed(true)}
      >
        {t("update.later")}
      </Button>
    </div>
  );
}
