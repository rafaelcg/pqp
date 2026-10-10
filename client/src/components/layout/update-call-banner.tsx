import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplyUpdate } from "@/hooks/use-apply-update";
import { useTranslation } from "@/lib/i18n";
import { useInCall } from "@/lib/in-call-state";
import {
  useBuildStaleness,
  useUpdatePromptShowing,
  useUpdateWaiting,
} from "@/lib/update-prompt-state";

/**
 * The in-call half of "nobody stays on an old bundle": a slim lime strip at the
 * top of the window while a call is up and a newer build is waiting.
 *
 * In a call nothing reloads by itself (a reload drops the seat and ends a screen
 * share), and the corner card stays away too (`shouldShowUpdateCard`). Without
 * this strip, somebody who lives in calls would never hear about an update. It
 * says the update is there and that it happens on its own at the hangup, which
 * `BuildWatcher` keeps (`LEFT_CALL_RELOAD_MS` in `lib/update-policy.ts`). The
 * button is for whoever would rather reload now, call and all.
 *
 * Not shown for a CRITICAL update: that one reloads by itself, and the blocking
 * screen covers the moment in between.
 */
export function UpdateCallBanner({
  apply,
}: {
  /** Test seam: the real ladder navigates away. */
  apply?: (target: string | null) => Promise<unknown>;
} = {}) {
  const { t } = useTranslation();
  const inCall = useInCall();
  const waiting = useUpdateWaiting();
  const cardShowing = useUpdatePromptShowing();
  const build = useBuildStaleness();
  const { state: applying, start } = useApplyUpdate(apply);

  if (!inCall || !waiting || cardShowing || build.critical) {
    return null;
  }

  return (
    <div
      role="status"
      data-update-call-banner=""
      className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full bg-accent py-1.5 pl-4 pr-1.5 text-sm text-on-accent shadow-[var(--shadow-2)]">
        <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          <span className="font-semibold">{t("update.callBanner.title")}</span>
          <span className="hidden sm:inline"> {t("update.callBanner.body")}</span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 rounded-full"
          disabled={applying.status === "updating"}
          onClick={() => start(build.latestBuild)}
        >
          {applying.status === "updating"
            ? t("update.updating")
            : t("update.callBanner.now")}
        </Button>
      </div>
    </div>
  );
}
