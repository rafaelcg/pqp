import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FeatureHint } from "@/components/layout/feature-hint";
import { createInvite, listInvites } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { shareInviteText, shareInviteUrl } from "@/lib/share-invite";

const BringFriendsServerContext = createContext<string | null>(null);

export function BringFriendsServerProvider({
  serverId,
  children,
}: {
  serverId: string | null;
  children: ReactNode;
}) {
  return (
    <BringFriendsServerContext.Provider value={serverId}>
      {children}
    </BringFriendsServerContext.Provider>
  );
}

export function useBringFriendsServerId(): string | null {
  return useContext(BringFriendsServerContext);
}

const DEFAULT_EXPIRY_HOURS = 168;
const COPY_MS = 1600;

function inviteStillOpen(expiresAt: string | null, maxUses: number | null, uses: number) {
  if (maxUses !== null && uses >= maxUses) {
    return false;
  }
  if (!expiresAt) {
    return true;
  }
  const remaining = new Date(expiresAt).getTime() - Date.now();
  return !Number.isNaN(remaining) && remaining > 0;
}

/**
 * One-shot nudge for a lone presenter. CTA copies the short invite paste
 * (reuses a live link, or makes a 7-day one).
 */
export function BringFriendsHint({
  enabled,
  serverId: serverIdProp,
}: {
  enabled: boolean;
  serverId?: string | null;
}) {
  const serverIdFromContext = useBringFriendsServerId();
  const serverId = serverIdProp === undefined ? serverIdFromContext : serverIdProp;
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copyTimer = useRef<number | null>(null);

  async function copyInvitePaste() {
    if (!serverId || busy) {
      return;
    }
    setBusy(true);
    try {
      const { invites } = await listInvites(serverId);
      const live = invites.find((invite) =>
        inviteStillOpen(invite.expiresAt, invite.maxUses, invite.uses),
      );
      const invite =
        live ??
        (await createInvite(serverId, { expiresInHours: DEFAULT_EXPIRY_HOURS }))
          .invite;
      const url = shareInviteUrl(window.location.origin, invite.code);
      await navigator.clipboard.writeText(shareInviteText("short", locale, url));
      setCopied(true);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(false), COPY_MS);
    } catch {
      setCopied(false);
    } finally {
      setBusy(false);
    }
  }

  if (!serverId) {
    return null;
  }

  return (
    <FeatureHint
      id="bringFriends"
      enabled={enabled}
      title={t("invite.hint.bringFriends.title")}
      body={t("invite.hint.bringFriends.body")}
      actionLabel={
        copied
          ? t("invite.paste.copied")
          : t("invite.hint.bringFriends.cta")
      }
      actionBusy={busy}
      onAction={() => void copyInvitePaste()}
    />
  );
}
