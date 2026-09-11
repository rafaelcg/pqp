import { useEffect } from "react";
import { Archive } from "lucide-react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { COMMUNITY_HOME_POST_TOAST_MS } from "@/lib/community-home/post-toast";
import { useTranslation } from "@/lib/i18n";

/**
 * Live corner card: somebody just published in this server's Baú.
 *
 * Not a campaign. It does not write `lib/hints.ts`, Playwright may see it
 * (the e2e that publishes while you read #general asserts it), and it only
 * mounts when it holds the corner so it cannot stack under the update notice.
 * Click the CTA (or wait; it puts itself away) — the unread badge stays
 * until the feed is actually opened.
 */
export function CommunityHomePostHint({
  enabled,
  serverName,
  onOpen,
  onDismiss,
}: {
  enabled: boolean;
  serverName: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setTimeout(onDismiss, COMMUNITY_HOME_POST_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, onDismiss]);

  const name = serverName.trim() || t("communityHome.channelName");

  return (
    <CornerCard
      open={enabled}
      onClose={onDismiss}
      label={t("communityHome.toast.label")}
      dismissLabel={t("communityHome.toast.dismiss")}
      dataAttribute="community-home-post"
      tone="status"
      hero={
        <div className="flex h-28 items-center justify-center bg-ink-1">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-signal text-ink">
            <Archive className="h-5 w-5" aria-hidden />
          </span>
        </div>
      }
      title={t("communityHome.toast.title")}
      body={t("communityHome.toast.body", { name })}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={onOpen}
        >
          {t("communityHome.toast.cta")}
        </Button>
      }
    />
  );
}
