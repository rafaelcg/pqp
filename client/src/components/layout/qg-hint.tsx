import { X } from "lucide-react";
import { useEffect, useState } from "react";
import qgHintArtUrl from "@/assets/qg-hint.webp";
import { Button } from "@/components/ui/button";
import { joinCommunity, lookupCommunityBySlug } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { isAutomatedBrowser } from "@/lib/cargos-hint";
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
}: {
  onJoined: (result: QgHintJoin) => void;
  onFailed: () => void;
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
    if (!show) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [show]);

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
    <aside
      aria-label={t("qgHint.title")}
      className="animate-fade-in safe-pb fixed inset-x-3 bottom-3 z-[31] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]"
    >
      <div className="relative overflow-hidden rounded-2xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)]">
        <div aria-hidden className="relative h-40 overflow-hidden bg-ink-1">
          <img
            src={art}
            alt=""
            className="h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink-2 to-transparent" />
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("qgHint.dismiss")}
          className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md bg-ink/70 text-paper outline-none backdrop-blur-sm hover:bg-ink hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>

        <div className="p-4">
          <h2 className="font-display text-sm font-bold tracking-tight text-paper">
            {t("qgHint.title")}
          </h2>
          <p className="mt-1.5 text-pretty text-sm leading-relaxed text-paper-muted">
            {t("qgHint.body")}
          </p>
          <Button
            size="sm"
            className="cta-lift mt-3 rounded-full px-4"
            disabled={joining}
            onClick={() => void join()}
          >
            {t(joining ? "communities.joining" : "qgHint.cta")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
