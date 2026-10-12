import type { CommunityListingNudge } from "@pqp/shared";
import { Compass } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { updateCommunitySettings } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { useTranslation } from "@/lib/i18n";

/**
 * One corner card: "{name} já tem endereço público. Aparecer no diretório?"
 *
 * For the owner of a room that has a public address and is not in the
 * directory, once (`lib/community-listing-nudge.ts` has the rules, the server
 * picks the room). The body is the same sentence the directory switch carries
 * in Server settings, so the card and the setting say the same thing.
 *
 * The button lists the room right here: the person reading the card is the
 * only one who may (listing is the owner's), and sending them into a settings
 * pane to tick the box the card just described is a detour. Undoing it is the
 * same switch, in Configurações do servidor › Comunidade, and the notice after
 * says so.
 *
 * `onSeen` fires the first time the card paints (the impression spends it);
 * `onDismiss` when it closes for any reason, so the corner queue moves on.
 */
export function ListingNudgeHint({
  enabled,
  nudge,
  onSeen,
  onDismiss,
  onListed,
  onFailed,
}: {
  enabled: boolean;
  nudge: CommunityListingNudge;
  onSeen: () => void;
  onDismiss: () => void;
  onListed: (serverId: string, name: string) => void;
  onFailed: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const seenRef = useRef(false);

  const show = enabled && open && nudge !== null;

  useEffect(() => {
    if (show && !seenRef.current) {
      seenRef.current = true;
      onSeen();
    }
  }, [show, onSeen]);

  if (!nudge) {
    return null;
  }

  const close = () => {
    setOpen(false);
    onDismiss();
  };

  async function list() {
    if (busy || !nudge) {
      return;
    }
    setBusy(true);
    try {
      await updateCommunitySettings(nudge.serverId, { isListed: true });
      setOpen(false);
      onListed(nudge.serverId, nudge.name);
    } catch {
      setBusy(false);
      onFailed();
    }
  }

  const icon = resolveUploadedImageUrl(nudge.iconUrl);

  return (
    <CornerCard
      open={show}
      onClose={close}
      label={t("listingNudge.title")}
      dismissLabel={t("listingNudge.dismiss")}
      dataAttribute="listing-nudge"
      title={t("listingNudge.title")}
      body={t("listingNudge.body", { name: nudge.name })}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            disabled={busy}
            onClick={() => void list()}
          >
            {t(busy ? "listingNudge.listing" : "listingNudge.cta")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-3"
            disabled={busy}
            onClick={close}
          >
            {t("listingNudge.later")}
          </Button>
        </div>
      }
    >
      {/* What a stranger would see: the room's face on a directory row. A
          picture of the real thing, not a screenshot that goes stale. */}
      <div
        aria-hidden
        className="pointer-events-none mt-3 flex items-center gap-3 rounded-xl bg-ink-3/60 px-3 py-2"
      >
        {icon ? (
          <img
            src={icon}
            alt=""
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-4 font-display text-sm font-bold text-paper">
            {nudge.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-paper">
          {nudge.name}
        </span>
        <Compass className="h-4 w-4 shrink-0 text-signal" />
      </div>
    </CornerCard>
  );
}
