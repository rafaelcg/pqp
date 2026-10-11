import type { DmSummary, UserStatus } from "@pqp/shared";
import { Menu } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useFriends } from "@/components/friends/use-friends";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { conversationTitle } from "@/lib/conversations";
import { useTranslation } from "@/lib/i18n";
import { retroStatusKey } from "@/lib/retro-look";
import { isMusicRecado } from "@/components/retro/retro-model";

/** The one other person in a 1:1, with what the friends list knows of them. */
function usePeer(conversation: DmSummary) {
  const friends = useFriends();
  if (conversation.kind !== "dm" || conversation.participants.length !== 1) {
    return null;
  }
  const person = conversation.participants[0]!;
  const friend = friends.data.friends.find((one) => one.id === person.id);
  return {
    person,
    status: (friend?.status ?? null) as UserStatus | null,
    recado: friend?.customStatus ?? person.customStatus ?? null,
  };
}

export interface RetroWindowChromeProps {
  conversation: DmSummary;
  onOpenNav: () => void;
  onCall?: () => void;
  onVideo?: () => void;
  onSendFiles?: (files: File[]) => void;
  onPins: () => void;
  /** 1:1 only: whether the other person is blocked, and the two ways to flip it. */
  blocked?: boolean;
  onBlock?: () => void;
  onUnblock?: () => void;
  /** "Chamar a atenção", once the nudge exists. Hidden while undefined. */
  onNudge?: () => void;
  /** Extra header actions the regular header carries (a call already live). */
  trailing?: ReactNode;
}

/**
 * The conversation "window": a glossy title bar with decorative window
 * buttons, a toolbar of big labelled actions wired to the ones the regular
 * header already has, and the "Para:" strip. Stands in for the header of a
 * conversation while Modo 2005 is on; server channels keep their header.
 */
export function RetroWindowChrome({
  conversation,
  onOpenNav,
  onCall,
  onVideo,
  onSendFiles,
  onPins,
  blocked = false,
  onBlock,
  onUnblock,
  onNudge,
  trailing,
}: RetroWindowChromeProps) {
  const { t } = useTranslation();
  const peer = usePeer(conversation);
  const fileRef = useRef<HTMLInputElement>(null);
  const title = conversationTitle(conversation.participants);

  return (
    <div className="flex shrink-0 flex-col" data-retro-chrome="">
      <div className="retro-titlebar">
        <button
          type="button"
          className="-ml-1 rounded p-0.5 md:hidden"
          aria-label={t("chrome.openNav")}
          onClick={onOpenNav}
        >
          <Menu className="h-4 w-4" aria-hidden />
        </button>
        {peer?.status && <StatusDot status={peer.status} />}
        <p className="retro-titlebar-text">
          {t("retro.window.title", { name: title })}
        </p>
        <span className="retro-winbuttons" aria-hidden="true">
          <span className="retro-winbutton" data-kind="min" />
          <span className="retro-winbutton" data-kind="max" />
          <span className="retro-winbutton" data-kind="close" />
        </span>
      </div>

      <div className="retro-tools" role="toolbar" aria-label={t("retro.toolbar")}>
        {onCall && <Tool icon="📞" label={t("retro.tool.call")} onClick={onCall} />}
        {onVideo && <Tool icon="🎥" label={t("retro.tool.video")} onClick={onVideo} />}
        {onSendFiles && (
          <>
            <Tool
              icon="📎"
              label={t("retro.tool.file")}
              onClick={() => fileRef.current?.click()}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                if (files.length > 0) {
                  onSendFiles(files);
                }
              }}
            />
          </>
        )}
        <Tool icon="📌" label={t("retro.tool.pins")} onClick={onPins} />
        {onNudge && <Tool icon="📳" label={t("retro.tool.nudge")} onClick={onNudge} />}
        {peer && blocked && onUnblock && (
          <Tool icon="✅" label={t("retro.tool.unblock")} onClick={onUnblock} />
        )}
        {peer && !blocked && onBlock && (
          <Tool icon="🚫" label={t("retro.tool.block")} onClick={onBlock} />
        )}
        {trailing && <div className="ml-auto flex items-center pr-1">{trailing}</div>}
      </div>

      <div className="retro-to">
        <span className="retro-to-label">{t("retro.to")}</span>
        <b className="min-w-0 truncate">{title}</b>
        {peer?.status && (
          <span className="retro-to-status">({t(retroStatusKey(peer.status))})</span>
        )}
        {peer?.recado && (
          <span
            className="retro-to-recado"
            data-music={isMusicRecado(peer.recado) ? "" : undefined}
          >
            {peer.recado}
          </span>
        )}
      </div>
    </div>
  );
}

function Tool({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="retro-tool" onClick={onClick}>
      <span className="retro-tool-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}

/**
 * The log with the framed display pictures on its right: theirs on top, yours
 * at the bottom. The pictures are decoration (the names are in the title and
 * the log) and fold away under 900 px.
 */
export function RetroLogFrame({
  conversation,
  me,
  children,
}: {
  conversation: DmSummary;
  me: { displayName: string; avatarUrl: string | null; status: UserStatus } | null;
  children: ReactNode;
}) {
  const peer = usePeer(conversation);
  const other = conversation.participants[0] ?? null;
  return (
    <div className="retro-log-frame">
      {children}
      <aside className="retro-pictures" aria-hidden="true">
        {other ? (
          <span className="retro-frame" data-status={peer?.status ?? undefined}>
            <UserAvatar
              name={other.displayName}
              avatarUrl={other.avatarUrl}
              className="h-24 w-24 text-3xl"
              rounded="md"
              fallbackClassName="retro-avatar-fallback"
            />
          </span>
        ) : (
          <span />
        )}
        {me && (
          <span className="retro-frame" data-status={me.status}>
            <UserAvatar
              name={me.displayName}
              avatarUrl={me.avatarUrl}
              className="h-20 w-20 text-2xl"
              rounded="md"
              fallbackClassName="retro-avatar-fallback"
            />
          </span>
        )}
      </aside>
    </div>
  );
}
