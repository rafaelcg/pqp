import { RefreshCw } from "lucide-react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  setStaleChunkBannerVisible,
  useStaleChunkBannerVisible,
} from "@/lib/stale-chunk-state";

/**
 * "pqp updated, reload to continue": the mid-call counterpart to a stale
 * chunk's usual fix (a silent, guarded `window.location.reload()`).
 *
 * `recoverFromChunkLoadError` never reloads a tab that is in an active voice
 * call (see `lib/chunk-reload.ts` and `lib/in-call-state.ts`), because that
 * would drop the call without warning. This is what it shows instead: a
 * small corner card, not urgent, that the person can act on once they hang
 * up. Mounted once next to `UpdatePrompt`, which is the same shape of
 * problem (a new build waiting) with the same "never interrupt a call"
 * rule, just reached from a different trigger (a chunk 404 instead of a
 * service-worker update event).
 */
export function StaleChunkBanner() {
  const { t } = useTranslation();
  const show = useStaleChunkBannerVisible();

  return (
    <CornerCard
      open={show}
      onClose={() => setStaleChunkBannerVisible(false)}
      label={t("staleChunk.ready")}
      dismissLabel={t("staleChunk.dismiss")}
      dataAttribute="stale-chunk"
      tone="status"
      title={
        <span className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
          {t("staleChunk.ready")}
        </span>
      }
      body={t("staleChunk.inCall")}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={() => window.location.reload()}
        >
          {t("update.reload")}
        </Button>
      }
    />
  );
}
