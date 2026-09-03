import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  registerServiceWorker,
  type ServiceWorkerControls,
} from "@/lib/register-sw";
import { snoozeRemainingMs } from "@/lib/update-snooze";
import { setUpdatePromptShowing } from "@/lib/update-prompt-state";

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

  const show = needsRefresh && snoozedAt === null;

  // Tell the corner-hint queue inside App to yield while this is up.
  useEffect(() => {
    setUpdatePromptShowing(show);
    return () => setUpdatePromptShowing(false);
  }, [show]);

  return (
    <CornerCard
      open={show}
      onClose={() => setSnoozedAt(Date.now())}
      label={t("update.ready")}
      dismissLabel={t("update.dismiss")}
      dataAttribute="update"
      tone="status"
      title={
        <span className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
          {t("update.ready")}
        </span>
      }
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
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
            onClick={() => setSnoozedAt(Date.now())}
          >
            {t("update.later")}
          </Button>
        </div>
      }
    />
  );
}
