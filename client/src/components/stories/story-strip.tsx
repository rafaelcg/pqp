import { CaretRight } from "@phosphor-icons/react";
import { ChevronRight, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, type MouseEvent } from "react";
import type { StoryAuthor, StoryNotice, StoryStripItem } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { useTranslation } from "@/lib/i18n";
import { ringLabel } from "@/lib/stories/format";
import { failedRingLabel } from "@/lib/stories/post";
import { useSeenStories } from "@/lib/stories/seen-store";
import { trayWarmIds, warmTray } from "@/lib/stories/warm-tray";
import { stripView } from "@/lib/stories/strip-state";
import {
  openStoryComposer,
  openStoryViewer,
  ringAudienceKey,
  setPosting,
  useStoriesUi,
  type StoryAudienceKey,
} from "@/lib/stories/ui-store";
import { useStoryNotices, useStoryStrip } from "@/lib/stories/use-story-strip";
import { Icon } from "@/components/ui/icon";
import { SECTION_LABEL_REDESIGN } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import { StoryRing } from "./story-ring";

/**
 * The strip of rings at the top of the channel sidebar (a server's stories)
 * or of the Conversas list (friends' stories).
 *
 * Draws nothing at all unless something is live, so a server without stories
 * pays no row for them (design decision 22). The one exception is the card
 * telling an author that staff removed their story, which is said once and
 * then acknowledged.
 */

export interface StoryViewerSelf {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface StoryStripProps {
  audience: StoryAudienceKey;
  me: StoryViewerSelf;
  /**
   * Keep the "Teu story" bubble when nothing is live. For the Conversas
   * strip of somebody who has friends (design §3.4); nothing for nobody.
   */
  ownSlot?: boolean;
}

export function StoryStrip({ audience, me, ownSlot = false }: StoryStripProps) {
  const { t } = useTranslation();
  const stripAudience = useMemo(
    () =>
      audience.kind === "server"
        ? ({ kind: "server", serverId: audience.serverId } as const)
        : ({ kind: "friends" } as const),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ringAudienceKey(audience)],
  );
  const { strip, now, setPointerOnStrip } = useStoryStrip(stripAudience, me.id);
  const seen = useSeenStories();
  const ui = useStoriesUi();
  const { notices, dismiss } = useStoryNotices(Boolean(strip?.enabled));

  const audienceKey = ringAudienceKey(audience);
  const posting =
    ui.posting && ui.posting.audienceKeys.includes(audienceKey) ? ui.posting : null;

  const view = strip
    ? stripView(strip, { now, seenIds: seen, ownSlot })
    : ({ kind: "hidden" } as const);

  // Warm the first unseen story of the first three rings while the strip is up, so opening one shows
  // it with no wait. Keyed by the ids, not the strip object, so a refetch that changed nothing is free.
  const warmIds = strip?.enabled ? trayWarmIds(strip.items, seen) : [];
  const warmKey = warmIds.join(",");
  useEffect(
    () => warmTray(`strip:${audienceKey}`, warmKey ? warmKey.split(",") : []),
    [audienceKey, warmKey],
  );

  const myNotices =
    audience.kind === "server"
      ? notices.filter((notice) => notice.serverId === audience.serverId)
      : [];

  const compose = () =>
    openStoryComposer({
      context:
        audience.kind === "server"
          ? { kind: "server", serverId: audience.serverId }
          : { kind: "friends" },
    });

  if (!strip?.enabled) {
    return null;
  }

  const noticeCards = myNotices.map((notice) => (
    <RemovedNoticeCard key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />
  ));

  if (view.kind === "hidden" && !posting) {
    return noticeCards.length > 0 ? <div className="mb-3 space-y-2">{noticeCards}</div> : null;
  }

  const own = view.kind === "strip" ? view.own : null;
  const items = view.kind === "strip" ? view.items : [];
  const authors: Record<string, StoryAuthor> = {};
  for (const item of items) {
    authors[item.author.id] = item.author;
  }

  function openItems(
    startIndex: number,
    event: MouseEvent<HTMLElement> | null,
    byKeyboard = event?.detail === 0,
  ) {
    const ring = event?.currentTarget;
    openStoryViewer({
      audience,
      people: items.map((item) => ({ authorId: item.author.id, storyIds: item.storyIds })),
      authors,
      startIndex,
      originRect: ring ? ring.getBoundingClientRect() : null,
      originRingId: ring?.getAttribute("data-story-ring") ?? null,
      originByKeyboard: byKeyboard,
    });
  }

  function openOwn(item: StoryStripItem, event: MouseEvent<HTMLElement>) {
    openStoryViewer({
      audience,
      people: [{ authorId: item.author.id, storyIds: item.storyIds }],
      authors: { [item.author.id]: item.author },
      startIndex: 0,
      originRect: event.currentTarget.getBoundingClientRect(),
      originRingId: event.currentTarget.getAttribute("data-story-ring"),
      originByKeyboard: event.detail === 0,
    });
  }

  const ownSeen = own ? own.storyIds.every((id) => seen.has(id)) : false;
  const failedLabel =
    posting?.status === "failed" ? failedRingLabel(posting.failure, Boolean(posting.retry)) : null;
  // A failed post that can be sent again keeps its draft until the author chooses: try again or discard
  // (which also deletes whatever was already uploaded). One that cannot is only put away.
  const discardPost = () => {
    if (posting?.discard) {
      posting.discard();
    } else {
      setPosting(null);
    }
  };
  const failedActions: ContextMenuItemDef[] | undefined =
    (posting?.status === "failed" || posting?.status === "waiting") && posting.retry
      ? [
          { id: "retry", label: t("stories.upload.retryAction"), icon: RotateCw, onSelect: posting.retry },
          { id: "discard", label: t("stories.upload.discardAction"), icon: Trash2, danger: true, onSelect: discardPost },
        ]
      : undefined;
  const ownLabel =
    posting && posting.status !== "done"
      ? t(
          posting.status === "failed"
            ? "stories.ring.failed"
            : posting.status === "waiting"
              ? "stories.ring.offline"
              : "stories.ring.posting",
        )
      : t("stories.strip.yours");
  const showOwn = Boolean(own) || strip.canPost || Boolean(posting);

  return (
    <section
      aria-label={t("stories.strip.label")}
      data-story-strip={audienceKey}
      // Under the redesign the space below separates it from the channels,
      // not a rule.
      className="mb-2 border-b border-border pb-2.5 redesign:mb-3 redesign:border-b-0 redesign:pb-1"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      onPointerEnter={() => setPointerOnStrip(true)}
      onPointerLeave={() => setPointerOnStrip(false)}
    >
      {noticeCards.length > 0 && <div className="mb-2 space-y-2">{noticeCards}</div>}
      <div className="flex items-center justify-between px-0.5 pb-2 pt-0.5">
        <span
          className={cn(
            "text-[11px] font-bold uppercase tracking-wider text-text-tertiary",
            // The section label's face; the row sets the spacing.
            SECTION_LABEL_REDESIGN,
            "redesign:mb-0",
          )}
        >
          {t("stories.strip.label")}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            data-story-see-all=""
            onClick={(event) => openItems(0, null, event.detail === 0)}
            className="flex items-center gap-0.5 rounded-[var(--radius-control)] px-1 text-xs font-semibold text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring redesign:rounded-full redesign:px-2 redesign:py-0.5 redesign:hover:bg-row-hover redesign:focus-visible:ring-accent"
          >
            {t("stories.strip.seeAll")}
            <ChevronRight className="h-3.5 w-3.5 redesign:hidden" aria-hidden />
            <Icon icon={CaretRight} kind="symbol" size="sm" className="hidden h-3 w-3 redesign:block" />
          </button>
        )}
      </div>
      <div
        // The ring's cutout is the pane behind it: the side pane under the
        // redesign.
        className="-mx-1 -mt-1 flex gap-[9px] overflow-x-auto px-1 pb-0.5 pt-1 [scrollbar-width:none] [--story-ring-bg:var(--color-surface-1)] redesign:[--story-ring-bg:var(--color-pane-side)]"
      >
        {showOwn && (
          <StoryRing
            key="own"
            ringId={`${audienceKey}:own`}
            name={me.displayName}
            avatarUrl={me.avatarUrl}
            label={ownLabel}
            ariaLabel={
              failedLabel
                ? t(failedLabel.key, failedLabel.vars)
                : posting
                  ? t(
                      posting.status === "processing"
                        ? "stories.upload.processing"
                        : posting.status === "waiting"
                          ? "stories.upload.offline"
                          : "stories.upload.posting",
                    )
                  : own
                    ? t("stories.strip.ownView")
                    : t("stories.strip.ownPost")
            }
            // A story just posted that the strip has not read back yet is still a new story: the gradient
            // ring, not a grey one and not a bare face (that was a flash on a first-ever story).
            state={own ? (ownSeen ? "seen" : "unseen") : posting ? (posting.status === "done" ? "unseen" : "seen") : "none"}
            plus={strip.canPost}
            plusLabel={t("stories.strip.post")}
            onPlus={own ? compose : undefined}
            upload={
              posting
                ? {
                    status: posting.status,
                    progress: posting.progress,
                    retryable: Boolean(posting.retry),
                  }
                : null
            }
            arrive={Boolean(own)}
            failedActions={failedActions}
            contextItems={
              strip.canPost && !posting
                ? [{ id: "new-story", label: t("stories.compose.title"), icon: Plus, onSelect: compose }]
                : undefined
            }
            onOpen={(event) => {
              if (posting?.status === "failed") {
                // With actions the ring opens its menu instead; this is the one that can only be put away.
                discardPost();
                return;
              }
              if (own) {
                openOwn(own, event);
              } else if (strip.canPost && !posting) {
                // A ring that says "Postando..." is the story going up: a tap must not open a second composer.
                compose();
              }
            }}
          />
        )}
        {items.map((item, index) => (
          <StoryRing
            key={item.author.id}
            ringId={`${audienceKey}:${item.author.id}`}
            name={item.author.displayName}
            avatarUrl={item.author.avatarUrl}
            label={ringLabel(item.author.displayName)}
            ariaLabel={
              item.hasCall
                ? t("stories.strip.ringCall", { name: item.author.displayName })
                : item.unseen
                  ? t("stories.strip.ringNew", { name: item.author.displayName })
                  : t("stories.strip.ringSeen", { name: item.author.displayName })
            }
            state={item.unseen ? "unseen" : "seen"}
            hasCall={item.hasCall}
            arrive
            onOpen={(event) => openItems(index, event)}
          />
        ))}
      </div>
    </section>
  );
}

function RemovedNoticeCard({
  notice,
  onDismiss,
}: {
  notice: StoryNotice;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const server = notice.serverName ?? "";
  return (
    <div
      role="status"
      data-story-notice=""
      className={cn(
        "elevation-1 rounded-[var(--radius-card)] p-3",
        "redesign:rounded-[var(--sidebar-card-radius)] redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:shadow-none",
      )}
    >
      <p className="text-sm font-semibold text-text">
        {t("stories.removed.title", { server })}
      </p>
      <p className="mt-1 text-xs leading-snug text-text-secondary">
        {notice.reason
          ? t("stories.removed.body", { reason: notice.reason })
          : t("stories.removed.bodyNoReason")}
      </p>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="secondary" className="h-7" onClick={onDismiss}>
          {t("stories.removed.ok")}
        </Button>
      </div>
    </div>
  );
}
