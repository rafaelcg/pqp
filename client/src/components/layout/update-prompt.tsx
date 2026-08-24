import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  registerServiceWorker,
  type ServiceWorkerControls,
} from "@/lib/register-sw";
import { snoozeRemainingMs } from "@/lib/update-snooze";

/**
 * "A new version is ready" — the visible half of `registerType: "prompt"`.
 *
 * The reload is never taken automatically. This client holds a live WebSocket,
 * unsent composer drafts, and possibly an active call; swapping the bundle out
 * from under any of those is a worse outcome than running yesterday's build for
 * another minute. So it asks.
 *
 * "Later" SNOOZES, it does not dismiss. Under `registerType: "prompt"` the
 * waiting build never takes over on its own, not even on a hard reload, so a
 * permanent dismissal was the difference between "running yesterday's build for
 * another minute" and running it until every tab of the origin is closed. See
 * `update-snooze.ts` for the incident that made the distinction matter.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [snoozedAt, setSnoozedAt] = useState<number | null>(null);
  const [updating, setUpdating] = useState(false);
  const controlsRef = useRef<ServiceWorkerControls | null>(null);

  useEffect(() => {
    const controls = registerServiceWorker(() => setNeedsRefresh(true));
    controlsRef.current = controls;
    return () => controls.dispose();
  }, []);

  useEffect(() => {
    if (snoozedAt === null) {
      return;
    }
    const timer = setTimeout(
      () => setSnoozedAt(null),
      snoozeRemainingMs(snoozedAt, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snoozedAt]);

  if (!needsRefresh || snoozedAt !== null) {
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
        onClick={() => setSnoozedAt(Date.now())}
      >
        {t("update.later")}
      </Button>
    </div>
  );
}
