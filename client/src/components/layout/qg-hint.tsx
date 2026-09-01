import { useEffect, useState } from "react";
import qgHintArtUrl from "@/assets/qg-hint.webp";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { joinCommunity, lookupCommunityBySlug } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import {
  QG_HINT_SLUG,
  isQgHintSeen,
  rememberQgHint,
  shouldPersistQgHint,
  shouldShowQgHint,
} from "@/lib/qg-hint";

export interface QgHintJoin {
  serverId: string;
  serverName: string;
  joinedNow: boolean;
}

/**
 * One corner card: the QG exists, and this account is not in it.
 *
 * Same shape as cargos and the dice/polls note. No backdrop, no focus trap,
 * Escape or the X closes it. A PNG of the live room would go stale the next
 * time the QG swaps a banner; the illustration is the fallback, and a live
 * banner from the listing replaces it when the community has one.
 */
export function QgHint({
  onJoined,
  onFailed,
  onShowingChange,
}: {
  onJoined: (result: QgHintJoin) => void;
  onFailed: () => void;
  /** Fired once lookup has settled, and again when the card is dismissed. */
  onShowingChange?: (showing: boolean) => void;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(
    () => !isAutomatedBrowser() && !isQgHintSeen(),
  );
  const [open, setOpen] = useState(true);
  const [joining, setJoining] = useState(false);
  const [listing, setListing] = useState<
    | { status: "pending" }
    | { status: "ready"; listed: boolean; joined: boolean; id: string | null; bannerUrl: string | null }
  >({ status: "pending" });

  useEffect(() => {
    if (!eligible) {
      return;
    }
    let cancelled = false;
    void lookupCommunityBySlug(QG_HINT_SLUG)
      .then(({ community }) => {
        if (cancelled) {
          return;
        }
        setListing({
          status: "ready",
          listed: true,
          joined: community.joined,
          id: community.id,
          bannerUrl: community.bannerUrl,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setListing({
          status: "ready",
          listed: false,
          joined: false,
          id: null,
          bannerUrl: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  const preview = !shouldPersistQgHint();
  const show =
    eligible &&
    open &&
    listing.status === "ready" &&
    shouldShowQgHint({
      automated: false,
      seen: false,
      listed: listing.listed,
      joined: listing.joined,
      preview,
    });

  useEffect(() => {
    if (show) {
      rememberQgHint();
    }
  }, [show]);

  useEffect(() => {
    if (!eligible) {
      onShowingChange?.(false);
      return;
    }
    if (listing.status !== "ready") {
      return;
    }
    onShowingChange?.(show);
  }, [eligible, listing.status, show, onShowingChange]);

  if (!show || listing.status !== "ready") {
    return null;
  }

  const liveBanner = resolveUploadedImageUrl(listing.bannerUrl);
  const art = liveBanner ?? qgHintArtUrl;
  const communityId = listing.id;

  async function join() {
    if (joining) {
      return;
    }
    if (communityId === null) {
      // Localhost preview: communities are off, there is no QG to join.
      setOpen(false);
      return;
    }
    setJoining(true);
    try {
      const result = await joinCommunity(communityId);
      setOpen(false);
      onJoined({
        serverId: result.serverId,
        serverName: result.serverName,
        joinedNow: result.joinedNow,
      });
    } catch {
      setJoining(false);
      onFailed();
    }
  }

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t("qgHint.title")}
      dismissLabel={t("qgHint.dismiss")}
      dataAttribute="qg"
      hero={<img src={art} alt="" className="h-40 w-full object-cover" />}
      title={t("qgHint.title")}
      body={t("qgHint.body")}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          disabled={joining}
          onClick={() => void join()}
        >
          {t(joining ? "communities.joining" : "qgHint.cta")}
        </Button>
      }
    />
  );
}
