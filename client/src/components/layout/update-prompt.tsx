import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { useApplyUpdate } from "@/hooks/use-apply-update";
import { registerServiceWorker } from "@/lib/register-sw";
import { snoozeRemainingMs } from "@/lib/update-snooze";
import {
  setUpdatePromptShowing,
  setUpdateWaiting,
  shouldShowUpdateCard,
  useBuildStaleness,
  useUpdateRequestedAt,
} from "@/lib/update-prompt-state";
import { useInCall } from "@/lib/in-call-state";

/**
 * "A new version is ready" — the visible half of `registerType: "prompt"`.
 *
 * This card is the ASKING path. It never reloads by itself; `BuildWatcher`
 * does that, and only at a safe moment (idle, not in a call, not typing; see
 * `lib/update-policy.ts`). This client holds a live WebSocket, unsent composer
 * drafts, and possibly an active call, and swapping the bundle out from under
 * any of those is worse than running yesterday's build for another minute.
 *
 * "Later" SNOOZES, it does not dismiss: the card returns after twenty minutes.
 * A permanent dismissal is how a person ended up on an old build for as long as
 * they kept a tab open. See `update-snooze.ts` for the incident that made the
 * distinction matter, and `docs/PWA.md` ("Nobody stays on an old bundle") for
 * the rest of what now stands behind this card.
 *
 * ESCAPE DOES NOT CLOSE THIS ONE, and it is the only corner card that opts out.
 * Escape means "get the thing I just opened out of my way"; nobody opened this.
 * Every corner card listens on `document`, this one is mounted first and so
 * registers first, and the result was that one Escape aimed at an onboarding
 * card silenced the update and left the onboarding card standing. Reported from
 * production on 9 Sep 2026 as "other onboarding popups are making the update
 * one disappear so im stuck on an old version".
 */
export function UpdatePrompt({
  /**
   * Test seam. `virtual:pwa-register` only exists after vite-plugin-pwa has
   * run, so nothing outside a real build can make a build "arrive"; without
   * this the only observable state of this component is the empty one, and
   * every rule above it would be unpinned.
   */
  register = registerServiceWorker,
  apply,
}: {
  register?: typeof registerServiceWorker;
  /** Test seam: the real ladder navigates away. A failure is `{ ok: false }` or a rejection. */
  apply?: (target: string | null) => Promise<unknown>;
} = {}) {
  const { t } = useTranslation();
  // Two independent ways to learn a build is waiting, and either is enough: the
  // service worker saying so (`register`), and the page comparing itself to
  // `/version.json` (`BuildWatcher`). The second reaches a window that never
  // navigates, which the first cannot.
  const [workerNeedsRefresh, setWorkerNeedsRefresh] = useState(false);
  const build = useBuildStaleness();
  const needsRefresh = workerNeedsRefresh || build.stale;
  const [snoozedAt, setSnoozedAt] = useState<number | null>(null);
  const { state: applying, start } = useApplyUpdate(apply);

  useEffect(() => {
    const controls = register(() => setWorkerNeedsRefresh(true));
    return () => controls.dispose();
  }, [register]);

  // The durable fact, published for the rail: it draws the way back to this
  // card and must keep drawing it through a snooze and through a call.
  useEffect(() => {
    setUpdateWaiting(needsRefresh);
  }, [needsRefresh]);

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

  // Never ask someone in a call to reload unprompted: a reload ends their
  // screen share and drops them out of the room. The card waits until they
  // hang up, or until they ask for it from the rail, which is what
  // `requestedAt` is.
  const inCall = useInCall();
  const requestedAt = useUpdateRequestedAt();
  const show = shouldShowUpdateCard({
    waiting: needsRefresh,
    snoozedAt,
    requestedAt,
    inCall,
  });

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
      // A waiting build outranks every campaign card in `CORNER_HINT_ORDER`,
      // and this is the same claim expressed in pixels: should a card ever
      // forget to yield, the update is still the one you can click.
      elevated
      dismissOnEscape={false}
      title={
        <span className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
          {t("update.ready")}
        </span>
      }
      body={
        applying.status === "error" ? (
          <span role="alert">
            {applying.reason === "offline"
              ? t("update.error.offline")
              : t("update.error.failed")}
          </span>
        ) : inCall ? (
          t("update.inCall")
        ) : undefined
      }
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            disabled={applying.status === "updating"}
            // Makes the new worker the active one, then reloads, and walks
            // heavier fallbacks if that fails (`lib/update-ladder.ts`).
            onClick={() => start(build.latestBuild)}
          >
            {applying.status === "updating"
              ? t("update.updating")
              : applying.status === "error"
                ? t("update.retry")
                : t("update.reload")}
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
