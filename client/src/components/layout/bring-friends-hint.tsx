import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FeatureHint } from "@/components/layout/feature-hint";
import { useTranslation } from "@/lib/i18n";
import { copyInvitePaste } from "@/lib/invite-paste-copy";

type BringFriendsServerValue = {
  serverId: string | null;
  canCreateInvite: boolean;
};

const BringFriendsServerContext = createContext<BringFriendsServerValue>({
  serverId: null,
  canCreateInvite: false,
});

export function BringFriendsServerProvider({
  serverId,
  canCreateInvite,
  children,
}: {
  serverId: string | null;
  canCreateInvite: boolean;
  children: ReactNode;
}) {
  return (
    <BringFriendsServerContext.Provider value={{ serverId, canCreateInvite }}>
      {children}
    </BringFriendsServerContext.Provider>
  );
}

export function useBringFriendsServer(): BringFriendsServerValue {
  return useContext(BringFriendsServerContext);
}

const COPY_MS = 1200;

/**
 * One-shot nudge for a lone presenter. CTA makes a 7-day invite and
 * copies the short paste. createInvite is permission-checked on the API.
 */
export function BringFriendsHint({
  enabled,
  serverId: serverIdProp,
  canCreateInvite: canCreateInviteProp,
}: {
  enabled: boolean;
  serverId?: string | null;
  canCreateInvite?: boolean;
}) {
  const ctx = useBringFriendsServer();
  const serverId = serverIdProp === undefined ? ctx.serverId : serverIdProp;
  const canCreateInvite =
    canCreateInviteProp === undefined ? ctx.canCreateInvite : canCreateInviteProp;
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  async function copyPaste() {
    if (!serverId || !canCreateInvite || busy) {
      throw new Error("unavailable");
    }
    setBusy(true);
    try {
      await copyInvitePaste({ serverId, locale });
      setFailed(false);
      setCopied(true);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      await new Promise<void>((resolve) => {
        copyTimer.current = window.setTimeout(resolve, COPY_MS);
      });
    } catch (error) {
      setCopied(false);
      setFailed(true);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  if (!serverId || !canCreateInvite) {
    return null;
  }

  return (
    <FeatureHint
      id="bringFriends"
      enabled={enabled}
      title={t("invite.hint.bringFriends.title")}
      body={
        failed
          ? t("invite.hint.bringFriends.failed")
          : t("invite.hint.bringFriends.body")
      }
      actionLabel={
        copied
          ? t("invite.paste.copied")
          : t("invite.hint.bringFriends.cta")
      }
      actionBusy={busy}
      onAction={copyPaste}
    />
  );
}
