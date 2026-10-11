import { Menu, MessagesSquare } from "lucide-react";
import type {
  Channel,
  ForumPostRemoved,
  ForumPostSummary,
  ForumPostUpsert,
} from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { ChannelIcon } from "@/components/layout/channel-icon";

/**
 * THE SEAM BETWEEN THE SHELL AND THE FORUM PANE.
 *
 * Forum PR 3a (the shell: sidebar, settings, routing, App wiring) mounts this
 * component for a `forum` channel; forum PR 3b (the pane: list, filters,
 * cards, composer, post view variant) owns everything inside it. The body
 * below is 3a's placeholder and 3b replaces it. The props are the contract:
 * change them additively, and say so in the PR.
 *
 * What App owns and hands down, so the pane never re-derives it:
 *
 * - The flag (`postingEnabled`, `configLoaded`). Off is "Novos posts estão
 *   pausados neste fórum.", never a hidden forum; say nothing about it until
 *   `configLoaded`, or a forum that is on flashes "pausados" for a frame.
 * - Permissions, already resolved for this forum and its overwrites.
 * - `previousReadAt`: the forum's read cursor BEFORE this visit, what "Novo"
 *   is measured against. App marks the forum read as it opens it (so the
 *   sidebar pip clears at once) and hands the old cursor here; the list
 *   response's `forumPreviousReadAt` may already be the NEW cursor, because
 *   the two requests race. `undefined` while that mark-read is in flight.
 * - The open post. A post opens in App's thread panel (the column beside the
 *   main pane, full screen on a phone), which already owns the `thread-join`
 *   controller, the composer, mentions and the read cursor. The pane asks
 *   with `onOpenPost(summary)`; App opens the panel, puts
 *   `/channel/<forumId>/post/<postId>` in the address bar, and passes the id
 *   back as `openPostId` so the list can mark the open card and go compact.
 *   Deep links, search hits and pushes reach a post the same way, through
 *   App, without the pane being involved.
 * - Live frames. `forum-post-upsert` and `forum-post-removed` arrive on App's
 *   one socket handler, which calls `dispatchForumFrame` (in `./index.ts`)
 *   for every frame; the pane subscribes there. `connectionEpoch` goes up
 *   on every reconnect, which is when the list should refetch page 1 and
 *   merge (frames missed while offline are not replayed).
 * - A file dropped on the forum (`droppedFiles`): the whole pane is a drop
 *   target (`chatDropVerdict` says when), and a drop means "start a post
 *   with this attached". The pane opens Novo post with the files and calls
 *   `onDroppedFilesTaken` so App clears them; a drop it cannot take must
 *   still be cleared, never left to replay on the next render.
 */
export interface ForumPaneProps {
  /** The forum channel (`type === "forum"`); `topic` is its guidelines. */
  channel: Channel;
  serverId: string;
  currentUserId: string | null;
  /** `forum_channels` is on for this server: new posts may be created. */
  postingEnabled: boolean;
  /** The flag has answered at least once. */
  configLoaded: boolean;
  /** SEND_MESSAGES on this forum: may create a post. */
  canPost: boolean;
  /** MANAGE_MESSAGES or MANAGE_CHANNELS on this forum: pin, lock, delete, staff tags. */
  canModerate: boolean;
  /** MANAGE_CHANNELS on this forum: may open its settings (Tags, guidelines). */
  canManage: boolean;
  /** See the header. `null` = first visit; `undefined` = not known yet. */
  previousReadAt: string | null | undefined;
  /** The post open in App's thread panel, if it belongs to this forum. */
  openPostId: string | null;
  onOpenPost: (post: ForumPostSummary) => void;
  /** "Configurar tags", "Adicionar regras": open this forum's settings there. */
  onOpenSettings: (section: "overview" | "tags") => void;
  /** The phone header's menu button. */
  onOpenNav: () => void;
  /** Goes up on every socket reconnect. */
  connectionEpoch: number;
  droppedFiles: File[] | null;
  onDroppedFilesTaken: () => void;
}

/** The frames App forwards to the pane (see `dispatchForumFrame`). */
export type ForumFrame = ForumPostUpsert | ForumPostRemoved;

/**
 * Placeholder until forum PR 3b lands: a forum opened before then says what
 * it is instead of drawing a header over nothing.
 */
export function ForumPane({ channel, onOpenNav }: ForumPaneProps) {
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
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-display text-base font-bold">
            <ChannelIcon channel={channel} className="h-4 w-4" />
            {channel.name}
          </p>
          {channel.topic && (
            <p className="truncate text-[11px] text-text-tertiary">{channel.topic}</p>
          )}
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MessagesSquare className="h-8 w-8 text-text-tertiary" aria-hidden />
        <p className="font-display text-base font-bold">{t("forum.placeholder.title")}</p>
        <p className="max-w-sm text-sm text-text-tertiary">{t("forum.placeholder.body")}</p>
      </div>
    </div>
  );
}
