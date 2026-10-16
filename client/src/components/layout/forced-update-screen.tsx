import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useApplyUpdate } from "@/hooks/use-apply-update";
import { useTranslation } from "@/lib/i18n";
import { isBlockingUpdate } from "@/lib/update-policy";
import { useBuildStaleness } from "@/lib/update-prompt-state";

/**
 * "Atualização necessária": the one blocking screen, for a CRITICAL update and
 * nothing else (a bundle built before `CLIENT_CRITICAL_MIN_BUILT_AT`, or the
 * operator's `client_force_update_in_call` on a forced build; see
 * `isCriticalBuild` in `lib/client-version.ts` and
 * `server/src/lib/client-update-config.ts`).
 *
 * It used to be what `client_force_update` showed, to everybody not on the
 * latest build, on every deploy. On 2026-10-13 that was nineteen blocking
 * screens in a day and a user writing in capitals that it came "de 10 em 10
 * segundos". That switch now only announces an update at once and draws the
 * indicator with emphasis (`components/layout/update-indicator.tsx`); this is
 * for the day a bundle is genuinely bad, which is rare and which the person
 * should be told in so many words.
 *
 * It is small on purpose: a calm dialog of the same size as every other, one
 * sentence and one button, not a page. It has no close button, no Escape and no
 * backdrop dismissal (`dismissible={false}`), because a prompt that can be waved
 * away is the same prompt that stranded people on an old bundle before. A
 * critical build also reloads on its own (`BuildWatcher`, once); this is what is
 * on screen if that reload does not land, and the button is then the person's.
 */
export function ForcedUpdateScreen({
  apply,
}: {
  /** Test seam: the real ladder navigates away. A failure is `{ ok: false }` or a rejection. */
  apply?: (target: string | null) => Promise<unknown>;
} = {}) {
  const { t } = useTranslation();
  const build = useBuildStaleness();
  const { state, start } = useApplyUpdate(apply);

  const open = isBlockingUpdate(build);

  return (
    <Dialog
      open={open}
      title={
        <span className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          {t("update.forced.title")}
        </span>
      }
      description={t("update.forced.body")}
      size="sm"
      dismissible={false}
      closeOnBackdrop={false}
      onClose={() => {}}
      footer={
        <Button
          className="w-full sm:w-auto"
          disabled={state.status === "updating"}
          data-testid="forced-update-button"
          onClick={() => start(build.latestBuild)}
        >
          {state.status === "updating"
            ? t("update.updating")
            : state.status === "error"
              ? t("update.retry")
              : t("update.reload")}
        </Button>
      }
    >
      <p className="px-5 py-4 text-sm text-text-secondary">
        {t("update.forced.detail")}
      </p>
      {/* The button is the person's again after a failure, and this says why.
          A blocking screen that fails silently is a lock-out. */}
      {state.status === "error" && (
        <p
          role="alert"
          data-testid="forced-update-error"
          className="border-t border-border px-5 py-3 text-sm text-danger"
        >
          {state.reason === "offline"
            ? t("update.error.offline")
            : t("update.error.failed")}
        </p>
      )}
    </Dialog>
  );
}
