import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { applyUpdate } from "@/lib/apply-update";
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
  apply = applyUpdate,
}: {
  /** Test seam: a real apply reloads the page. */
  apply?: (target?: string | null) => Promise<unknown>;
} = {}) {
  const { t } = useTranslation();
  const build = useBuildStaleness();
  const inCall = useInCall();
  const [updating, setUpdating] = useState(false);

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
          disabled={updating}
          data-testid="forced-update-button"
          onClick={() => {
            setUpdating(true);
            void apply(build.latestBuild);
          }}
        >
          {updating ? t("update.updating") : t("update.reload")}
        </Button>
      }
    >
      <p className="px-5 py-4 text-sm text-text-secondary">
        {t("update.forced.detail")}
      </p>
    </Dialog>
  );
}
