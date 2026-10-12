import { ChevronRight, X } from "lucide-react";
import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import type { StoryAuthor, StoryNotice, StoryStripItem } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { isHintSeen, rememberHint } from "@/lib/hints";
import { ringLabel } from "@/lib/stories/format";
import { failedRingLabel } from "@/lib/stories/post";
import { useSeenStories } from "@/lib/stories/seen-store";
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
import { cn } from "@/lib/utils";
import { StoryRing } from "./story-ring";

/**
 * The strip of rings at the top of the channel sidebar (a server's stories)
 * or of the Conversas list (friends' stories).
 *
 * Draws nothing at all unless something is live, so a server without stories
 * pays no row for them (design decision 22). The two exceptions are the
 * one-off first-run row, and the card telling an author that staff removed
 * their story, which is said once and then acknowledged.
 */

export interface StoryViewerSelf {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface StoryStripProps {
  audience: StoryAudienceKey;
  me: StoryViewerSelf;
}

/** Session memory for a dismissed first-run row, where hints do not persist. */
const dismissedThisSession = new Set<string>();

function firstRunKey(meId: string, audience: StoryAudienceKey): string {
  return `pqp:stories-first-run:${meId}:${ringAudienceKey(audience)}`;
}

export function StoryStrip({ audience, me }: StoryStripProps) {
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
  const hintKey = firstRunKey(me.id, audience);
  const [dismissed, setDismissed] = useState(
    () => dismissedThisSession.has(hintKey) || isHintSeen(hintKey),
  );
  const { notices, dismiss } = useStoryNotices(Boolean(strip?.enabled));

  const audienceKey = ringAudienceKey(audience);
  const posting =
    ui.posting && ui.posting.audienceKeys.includes(audienceKey) ? ui.posting : null;

  const view = strip
    ? stripView(strip, { now, seenIds: seen, firstRunDismissed: dismissed })
    : ({ kind: "hidden" } as const);

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

  if (view.kind === "first-run" && !posting) {
    return (
      <div className="mb-3 space-y-2">
        {noticeCards}
        <FirstRunRow
          me={me}
          onPost={compose}
          onDismiss={() => {
            dismissedThisSession.add(hintKey);
            rememberHint(hintKey);
            setDismissed(true);
          }}
        />
      </div>
    );
  }

  if (view.kind === "hidden" && !posting) {
    return noticeCards.length > 0 ? <div className="mb-3 space-y-2">{noticeCards}</div> : null;
  }

  const own = view.kind === "strip" ? view.own : null;
  const items = view.kind === "strip" ? view.items : [];
  const authors: Record<string, StoryAuthor> = {};
  for (const item of items) {
    authors[item.author.id] = item.author;
  }

  function openItems(startIndex: number, event: MouseEvent<HTMLElement> | null) {
    const ring = event?.currentTarget;
    openStoryViewer({
      audience,
      people: items.map((item) => ({ authorId: item.author.id, storyIds: item.storyIds })),
      authors,
      startIndex,
      originRect: ring ? ring.getBoundingClientRect() : null,
      originRingId: ring?.getAttribute("data-story-ring") ?? null,
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
    });
  }

  const ownSeen = own ? own.storyIds.every((id) => seen.has(id)) : false;
  const failedLabel =
    posting?.status === "failed" ? failedRingLabel(posting.failure, Boolean(posting.retry)) : null;
  const showOwn = Boolean(own) || strip.canPost || Boolean(posting);

  return (
    <section
      aria-label={t("stories.strip.label")}
      data-story-strip={audienceKey}
      className="mb-2 border-b border-border pb-2.5"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      onPointerEnter={() => setPointerOnStrip(true)}
      onPointerLeave={() => setPointerOnStrip(false)}
    >
      {noticeCards.length > 0 && <div className="mb-2 space-y-2">{noticeCards}</div>}
      <div className="flex items-center justify-between px-0.5 pb-2 pt-0.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
          {t("stories.strip.label")}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            data-story-see-all=""
            onClick={() => openItems(0, null)}
            className="flex items-center gap-0.5 rounded-[var(--radius-control)] px-1 text-xs font-semibold text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {t("stories.strip.seeAll")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div
        className="-mx-1 flex gap-[9px] overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
        style={{ "--story-ring-bg": "var(--color-surface-1)" } as CSSProperties}
      >
        {showOwn && (
          <StoryRing
            key="own"
            ringId={`${audienceKey}:own`}
            name={me.displayName}
            avatarUrl={me.avatarUrl}
            label={t("stories.strip.yours")}
            ariaLabel={
              failedLabel
                ? t(failedLabel.key, failedLabel.vars)
                : posting
                  ? t(posting.status === "processing" ? "stories.upload.processing" : "stories.upload.posting")
                  : own
                    ? t("stories.strip.ownView")
                    : t("stories.strip.ownPost")
            }
            state={own ? (ownSeen ? "seen" : "unseen") : posting ? "seen" : "none"}
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
            onOpen={(event) => {
              if (posting?.status === "failed") {
                if (posting.retry) {
                  posting.retry();
                } else {
                  setPosting(null);
                }
                return;
              }
              if (own) {
                openOwn(own, event);
              } else if (strip.canPost) {
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

function FirstRunRow({
  me,
  onPost,
  onDismiss,
}: {
  me: StoryViewerSelf;
  onPost: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-story-first-run=""
      className="relative flex items-start gap-3 rounded-[var(--radius-card)] border border-dashed border-border-strong p-3"
    >
      <div className="relative h-10 w-10 shrink-0">
        <UserAvatar
          name={me.displayName}
          avatarUrl={me.avatarUrl}
          rounded="full"
          className="h-10 w-10"
          fallbackClassName="bg-surface-3 text-text text-sm"
        />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[11px] font-bold leading-none text-on-accent shadow-[0_0_0_2px_var(--color-surface-1)]">
          +
        </span>
      </div>
      <div className="min-w-0 flex-1 pr-4">
        <p className="text-sm font-semibold text-text">{t("stories.empty.title")}</p>
        <p className="mt-0.5 text-xs leading-snug text-text-secondary">
          {t("stories.empty.body")}
        </p>
        <Button size="sm" className="mt-2 h-7 rounded-full px-3" onClick={onPost}>
          {t("stories.empty.cta")}
        </Button>
      </div>
      <button
        type="button"
        aria-label={t("stories.empty.dismiss")}
        onClick={onDismiss}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
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
      className={cn("elevation-1 rounded-[var(--radius-card)] p-3")}
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
