import { Home, Lock, Phone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Channel } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  createCommunityHomePost,
  loadCommunityHomePosts,
  loadCommunityHomeViewerMode,
  prependCommunityHomePost,
  resolveCommunityHomeViewer,
  resolveHomeVoiceChannelId,
  saveCommunityHomeViewerMode,
  homePostIsLocked,
  type CommunityHomePost,
  type CommunityHomeViewerMode,
  type CommunityHomeViewerRole,
  type CommunityHomeVisibility,
} from "@/lib/community-home";

type Props = {
  serverId: string;
  serverName: string;
  channels: Channel[];
  authorName: string;
  isOwner: boolean;
  isVip: boolean;
  onJoinVoice: (channelId: string) => void;
  onOpenNav?: () => void;
};

function relativeDayLabel(
  iso: string,
  t: (key: "time.today" | "time.yesterday") => string,
): string {
  const then = new Date(iso).getTime();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  if (then >= startToday.getTime()) {
    return t("time.today");
  }
  const startYesterday = startToday.getTime() - 24 * 60 * 60 * 1000;
  if (then >= startYesterday) {
    return t("time.yesterday");
  }
  return new Date(iso).toLocaleDateString();
}

function MockMedia({
  post,
  locked,
}: {
  post: CommunityHomePost;
  locked: boolean;
}) {
  const { t } = useTranslation();
  if (!post.media) {
    return null;
  }
  if (locked) {
    return (
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface-0">
        <div
          className="flex h-40 items-center justify-center bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_8px,var(--color-surface-0)_8px_16px)] blur-[1px]"
          aria-hidden
        />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-0/70 px-4 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent shadow-[0_0_24px_rgba(186,237,77,0.35)]">
            <Lock className="h-4 w-4" aria-hidden />
          </span>
          <p className="font-display text-sm font-semibold text-accent">
            {t("communityHome.lockedTitle")}
          </p>
          <p className="max-w-xs text-xs text-text-muted">
            {post.teaser ?? t("communityHome.lockedBody")}
          </p>
        </div>
      </div>
    );
  }
  if (post.media.kind === "file") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-0 px-3 py-2.5 text-sm">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
          PDF
        </span>
        <span className="min-w-0 truncate text-text">{post.media.name}</span>
        <span className="ml-auto shrink-0 text-xs text-text-muted">
          {post.media.sizeLabel}
        </span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-0">
      <div
        className="flex h-44 items-end bg-[linear-gradient(180deg,rgba(186,237,77,0.08),transparent_40%),repeating-linear-gradient(0deg,transparent_0_19px,rgba(39,47,55,0.9)_19px_20px),repeating-linear-gradient(90deg,transparent_0_19px,rgba(39,47,55,0.9)_19px_20px)] px-3 py-2"
        role="img"
        aria-label={post.media.name}
      >
        <span className="rounded bg-surface-0/80 px-2 py-0.5 text-[11px] text-text-muted">
          {post.media.name} · {post.media.sizeLabel}
        </span>
      </div>
    </div>
  );
}

function PostCard({
  post,
  viewer,
  voiceChannelId,
  onJoinVoice,
}: {
  post: CommunityHomePost;
  viewer: CommunityHomeViewerRole;
  voiceChannelId: string | null;
  onJoinVoice: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const locked = homePostIsLocked(post.visibility, viewer);
  const badgeKey =
    post.authorBadge === "owner"
      ? "communityHome.badge.owner"
      : post.authorBadge === "vip"
        ? "communityHome.badge.vip"
        : "communityHome.badge.member";

  return (
    <article className="rounded-xl border border-border/80 bg-surface-2 p-4 shadow-none">
      <header className="mb-3 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 font-display text-xs font-bold text-text">
          {post.authorName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-text">{post.authorName}</span>
            <span className="rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
              {t(badgeKey)}
            </span>
            <span className="text-xs text-text-muted">
              {relativeDayLabel(post.createdAt, t)}
            </span>
            {post.visibility === "members" && (
              <span className="rounded border border-accent/40 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
                {t("communityHome.visibility.members")}
              </span>
            )}
            {post.visibility === "free" && (
              <span className="rounded border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t("communityHome.visibility.free")}
              </span>
            )}
          </div>
        </div>
      </header>

      <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-text">
        {locked ? (post.teaser ?? post.body) : post.body}
      </p>

      <MockMedia post={post} locked={locked} />

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {locked ? (
          <Button type="button" variant="secondary" className="gap-1.5" disabled>
            <Lock className="h-3.5 w-3.5" aria-hidden />
            {t("communityHome.unlockCta")}
          </Button>
        ) : (
          voiceChannelId && (
            <Button
              type="button"
              className="gap-1.5 bg-accent text-surface-0 hover:bg-accent/90"
              onClick={() => onJoinVoice(voiceChannelId)}
            >
              <Phone className="h-3.5 w-3.5" aria-hidden />
              {t("communityHome.joinCall")}
            </Button>
          )
        )}
        <span className="ml-auto text-xs text-text-muted">
          {t("communityHome.comments", { count: post.commentCount })}
        </span>
      </footer>
    </article>
  );
}

function ComposeCard({
  onSubmit,
}: {
  onSubmit: (input: {
    body: string;
    visibility: CommunityHomeVisibility;
    teaser: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  const [teaser, setTeaser] = useState("");
  const [visibility, setVisibility] =
    useState<CommunityHomeVisibility>("free");

  return (
    <form
      className="rounded-xl border border-dashed border-accent/40 bg-surface-2/80 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) {
          return;
        }
        onSubmit({ body, visibility, teaser });
        setBody("");
        setTeaser("");
        setVisibility("free");
      }}
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
        {t("communityHome.compose.title")}
      </p>
      <textarea
        className="mb-2 w-full resize-y rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t("communityHome.compose.placeholder")}
      />
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="radio"
            name="home-visibility"
            checked={visibility === "free"}
            onChange={() => setVisibility("free")}
          />
          {t("communityHome.visibility.free")}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="radio"
            name="home-visibility"
            checked={visibility === "members"}
            onChange={() => setVisibility("members")}
          />
          {t("communityHome.visibility.members")}
        </label>
      </div>
      {visibility === "members" && (
        <input
          className="mb-2 w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
          value={teaser}
          onChange={(event) => setTeaser(event.target.value)}
          placeholder={t("communityHome.compose.teaserPlaceholder")}
        />
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={!body.trim()}>
          {t("communityHome.compose.submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Durable owner-post timeline for the Community Home experiment.
 *
 * Client-only fixtures + localStorage. Comments are counts, not a live chat.
 */
export function CommunityHomeFeed({
  serverId,
  serverName,
  channels,
  authorName,
  isOwner,
  isVip,
  onJoinVoice,
  onOpenNav,
}: Props) {
  const { t } = useTranslation();
  const [viewerMode, setViewerMode] = useState<CommunityHomeViewerMode>(() =>
    loadCommunityHomeViewerMode(),
  );
  const [posts, setPosts] = useState<CommunityHomePost[]>(() =>
    loadCommunityHomePosts(serverId),
  );

  useEffect(() => {
    setPosts(loadCommunityHomePosts(serverId));
  }, [serverId]);

  const viewer = useMemo(
    () =>
      resolveCommunityHomeViewer({
        mode: viewerMode,
        isOwner,
        isVip,
      }),
    [viewerMode, isOwner, isVip],
  );

  const canCompose = viewer === "owner";
  const defaultVoiceId = resolveHomeVoiceChannelId(channels, null);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/80 px-4">
        {onOpenNav && (
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-surface-3 md:hidden"
            aria-label={t("empty.openNav")}
            onClick={onOpenNav}
          >
            <Home className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
              {t("communityHome.headerTag")}
            </span>
            <h1 className="truncate font-display text-base font-bold text-text">
              {t("communityHome.title")}
            </h1>
          </div>
          <p className="truncate text-[11px] text-text-muted">
            {t("communityHome.subtitle", { name: serverName })}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-2 p-0.5 text-[11px]">
          {(
            [
              ["auto", "communityHome.viewer.auto"],
              ["owner", "communityHome.viewer.owner"],
              ["free", "communityHome.viewer.free"],
              ["vip", "communityHome.viewer.vip"],
            ] as const
          ).map(([mode, labelKey]) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "rounded-md px-2 py-1 capitalize text-text-muted",
                viewerMode === mode && "bg-surface-3 font-semibold text-text",
              )}
              onClick={() => {
                setViewerMode(mode);
                saveCommunityHomeViewerMode(mode);
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="mb-4 text-xs text-text-muted">
          {t("communityHome.note")} · {t("communityHome.viewer.showing", {
            role: t(`communityHome.viewer.${viewer}`),
          })}
        </p>

        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {canCompose && (
            <ComposeCard
              onSubmit={(input) => {
                const post = createCommunityHomePost(serverId, authorName, {
                  ...input,
                  voiceChannelName: null,
                });
                setPosts(prependCommunityHomePost(serverId, post));
              }}
            />
          )}

          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              viewer={viewer}
              voiceChannelId={
                resolveHomeVoiceChannelId(channels, post.voiceChannelName) ??
                defaultVoiceId
              }
              onJoinVoice={onJoinVoice}
            />
          ))}

          <aside className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-text-muted">
            <p className="mb-1 font-semibold uppercase tracking-[0.14em] text-text">
              {t("communityHome.whyNotAvisos.title")}
            </p>
            <p>{t("communityHome.whyNotAvisos.body")}</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
