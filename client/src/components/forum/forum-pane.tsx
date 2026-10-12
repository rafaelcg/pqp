import { Menu, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { Channel } from "@pqp/shared";
import type { ComposerSlashContext } from "@/components/chat/message-composer";
import type {
  MessageAuthorInfo,
  MessageRoleColor,
} from "@/components/chat/message-list";
import { ChannelIcon } from "@/components/layout/channel-icon";
import type { ChatController, ChatMessage } from "@/hooks/use-chat";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";

/**
 * THE SEAM BETWEEN THE SHELL AND THE FORUM PANE.
 *
 * Forum PR 3a (the shell: sidebar, settings, routing, App wiring) mounts this
 * for a `forum` channel; forum PR 3b (the pane: list, filters, cards,
 * composer, post view) owns everything inside it and replaces this file. The
 * props below are 3b's interface as App feeds it; keep changes additive.
 *
 * What App does around the pane:
 *
 * - Opening the forum sends `join-channel` for it (so `forum-post-upsert` and
 *   `forum-post-removed` arrive) and moves the forum's read cursor, so the
 *   sidebar pip clears the moment the forum opens. `markRead(forumId)`, asked
 *   ONCE per visit, answers the cursor from BEFORE this visit (what "Novo" is
 *   measured against) instead of moving it again: the list's own
 *   `forumPreviousReadAt` can already be the new cursor, because App's
 *   mark-read and the list request race. Every other call moves the cursor
 *   and answers the one it replaced, as `markChannelRead` does.
 * - Frames and reconnects go through `lib/forum-frames.ts`: App calls
 *   `dispatchForumFrame` for every forum frame and `dispatchForumReconnected`
 *   when the socket comes back.
 * - The address bar: `routePostId` is the post in `/channel/<id>/post/<id>`
 *   (deep links, search hits, pushes, a post id given as a channel), and
 *   `onRoutePostChange` is how the pane opens or closes one; App writes the
 *   URL. `null` = no post open.
 * - A file dropped on the forum (`droppedFiles`): the whole pane is a drop
 *   target when `chatDropVerdict` accepts, and a drop means "start a post with
 *   this attached". The pane opens Novo post with the files and calls
 *   `onDroppedFilesTaken`; a drop it cannot take is still cleared.
 */
export interface ForumPaneProps {
  /** The forum channel. Its topic is the forum's guidelines. */
  channel: Channel;
  server: { id: string; name: string };
  viewerId: string | null;
  currentUser: {
    id: string;
    displayName: string;
    username: string | null;
    tag: string | null;
    avatarUrl: string | null;
  } | null;
  /** SEND_MESSAGES on the forum: may publish a post. */
  canPost: boolean;
  /** MANAGE_MESSAGES or MANAGE_CHANNELS on the forum. */
  isStaff: boolean;
  /** MANAGE_CHANNELS on the forum: tags and settings. */
  canManage: boolean;
  /**
   * The runtime flag `forum_channels` for this server (`useForumConfig`).
   * Off never hides anything; Novo post becomes the paused line. Omitted
   * while the flag has not answered yet.
   */
  creationEnabled?: boolean;
  /** App's second chat controller, on the `thread-join` slot. */
  postController: ChatController;
  /** See the header: the first call for the forum answers the old cursor. */
  markRead: (channelId: string) => Promise<string | null>;
  routePostId?: string | null;
  onRoutePostChange?: (postId: string | null) => void;
  onOpenNav: () => void;
  /** Channel settings, at the Tags section when asked. */
  onOpenSettings?: (section?: "tags") => void;
  /** The channel header's usual buttons (settings, members). */
  headerActions?: ReactNode;
  mentionCandidates: MentionCandidate[];
  blockedAuthorIds: ReadonlySet<string>;
  authors?: ReadonlyMap<string, MessageAuthorInfo>;
  roles?: readonly MessageRoleColor[];
  showLinkEmbeds: boolean;
  slashContext?: Omit<
    ComposerSlashContext,
    "sendChance" | "sendPoll" | "canPurgeMessages" | "openPurgeDialog"
  >;
  onReportMessage?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  /** Files dropped on the forum, waiting to start a post. See the header. */
  droppedFiles?: File[] | null;
  onDroppedFilesTaken?: () => void;
}

/** A post's shareable address, the form `parseAppRoute` reads back. */
export function forumPostPath(serverId: string, forumId: string, postId: string): string {
  return `/app/server/${serverId}/channel/${forumId}/post/${postId}`;
}

/**
 * Placeholder until forum PR 3b lands: a forum opened before then says what
 * it is instead of drawing a header over nothing.
 */
export function ForumPane({ channel, onOpenNav, headerActions }: ForumPaneProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-forum-pane="">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-[var(--radius-control)] p-1.5 hover:bg-surface-2 md:hidden"
          aria-label={t("chrome.openNav")}
          onClick={onOpenNav}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-display text-base font-bold">
            <ChannelIcon channel={channel} className="h-4 w-4" />
            {channel.name}
          </p>
          {channel.topic && (
            <p className="truncate text-[11px] text-text-tertiary">{channel.topic}</p>
          )}
        </div>
        {headerActions}
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MessagesSquare className="h-8 w-8 text-text-tertiary" aria-hidden />
        <p className="font-display text-base font-bold">{t("forum.placeholder.title")}</p>
        <p className="max-w-sm text-sm text-text-tertiary">{t("forum.placeholder.body")}</p>
      </div>
    </div>
  );
}
