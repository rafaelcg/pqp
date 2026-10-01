import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useApplyUpdate } from "@/hooks/use-apply-update";
import { useInCall } from "@/lib/in-call-state";
import { useTranslation } from "@/lib/i18n";
import { isBlockingUpdate } from "@/lib/update-policy";
import { useBuildStaleness } from "@/lib/update-prompt-state";

/**
 * "Atualização necessária": the screen an operator can put in front of every
 * client that is not on the latest build (`client_force_update`, or
 * `CLIENT_MIN_BUILT_AT`; see `server/src/lib/client-update-config.ts`).
 *
 * It exists for the day a bundle is BAD. The ordinary path (the card, the idle
 * reload, the twelve-hour reload) is gentle and takes however long it takes;
 * this is the one that does not wait. It has no close button, no Escape and no
 * backdrop dismissal (`dismissible={false}`), because a prompt that can be
 * waved away is the same prompt that stranded people on an old bundle before.
 *
 * The one thing that holds it back is a call. A reload ends a screen share
 * (nobody can restore a capture without the picker) and drops the seat, so while
 * `inCall` this renders nothing and the quiet card carries on; the moment the
 * person hangs up, it appears. The update is late, never lost.
 */
export function ForcedUpdateScreen({
  apply,
}: {
  /** Test seam: the real ladder navigates away. A failure is `{ ok: false }` or a rejection. */
  apply?: (target: string | null) => Promise<unknown>;
} = {}) {
  const { t } = useTranslation();
  const build = useBuildStaleness();
  const inCall = useInCall();
  const { state, start } = useApplyUpdate(apply);

  const open = isBlockingUpdate(build, inCall);

  return (
    <Dialog
      open={open}
      title={
        <span className="flex items-center gap-3">
          <RefreshCw className="h-6 w-6 shrink-0 text-accent" aria-hidden="true" />
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
