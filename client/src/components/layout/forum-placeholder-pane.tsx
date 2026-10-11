import { Menu, MessagesSquare } from "lucide-react";
import type { Channel } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { ChannelIcon } from "./channel-icon";

/**
 * What the main pane shows for a `forum` channel until the real forum pane
 * lands (forum PR 3b replaces this file's one call site in `App.tsx`).
 *
 * Without it a forum inside a category opened onto a header over nothing: the
 * chat pane only mounts for text and voice rooms, and a forum is neither. A
 * forum only exists where the operator turned `forum_channels` on, so this is
 * what a tester sees between the contract landing and the pane, never a dead
 * pane with no explanation.
 */
export function ForumPlaceholderPane({
  channel,
  onOpenNav,
}: {
  channel: Channel;
  onOpenNav: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
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
            <p className="truncate text-[11px] text-paper-muted">{channel.topic}</p>
          )}
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MessagesSquare className="h-8 w-8 text-paper-muted" aria-hidden />
        <p className="font-display text-base font-bold">{t("forum.placeholder.title")}</p>
        <p className="max-w-sm text-sm text-paper-muted">{t("forum.placeholder.body")}</p>
      </div>
    </div>
  );
}
