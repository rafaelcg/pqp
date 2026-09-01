import {
  Download,
  Home,
  Lock,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  addCommunityHomeComment,
  COMMUNITY_HOME_MAX_BYTES,
  createCommunityHomePost,
  deleteCommunityHomeComment,
  deleteCommunityHomePost,
  formatHomeBytes,
  homeMediaFromFile,
  homeMediaFromYoutube,
  homePostIsLocked,
  loadCommunityHomePosts,
  loadCommunityHomeViewerMode,
  prependCommunityHomePost,
  readFileAsDataUrl,
  resolveCommunityHomeViewer,
  saveCommunityHomeViewerMode,
  updateCommunityHomePost,
  visibleCommunityHomePosts,
  youtubeEmbedSrc,
  type CommunityHomeAuthorBadge,
  type CommunityHomeMedia,
  type CommunityHomePost,
  type CommunityHomeViewerMode,
  type CommunityHomeViewerRole,
  type CommunityHomeVisibility,
} from "@/lib/community-home";

type Props = {
  serverId: string;
  serverName: string;
  authorName: string;
  /** Real manage-server bit. VIP cargo alone cannot publish. */
  canManageServer: boolean;
  isOwner: boolean;
  isVip: boolean;
  onOpenNav?: () => void;
};

type StaffTab = "compose" | "preview";

/** Catalogue keys for resolved viewer roles — never interpolate into t(). */
const VIEWER_ROLE_LABEL: Record<CommunityHomeViewerRole, MessageKey> = {
  owner: "communityHome.viewer.owner",
  free: "communityHome.viewer.free",
  vip: "communityHome.viewer.vip",
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

function LockedMedia({
  title,
  teaser,
}: {
  title: string;
  teaser: string;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border bg-surface-0"
      data-home-locked-media
    >
      <div
        className="flex h-40 items-center justify-center bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_8px,var(--color-surface-0)_8px_16px)] blur-[1px]"
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-0/70 px-4 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent shadow-[0_0_24px_var(--glow-accent)]">
          <Lock className="h-4 w-4" aria-hidden />
        </span>
        <p className="font-display text-sm font-semibold text-accent">{title}</p>
        <p className="max-w-xs text-xs text-text-muted">{teaser}</p>
      </div>
    </div>
  );
}

function UnlockedMedia({ media }: { media: CommunityHomeMedia }) {
  if (media.kind === "file") {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-border bg-surface-0 px-3 py-2.5 text-sm"
        data-home-media="file"
      >
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
          {media.name.toLowerCase().endsWith(".pdf") ? "PDF" : "FILE"}
        </span>
        <span className="min-w-0 truncate text-text">{media.name}</span>
        <span className="ml-auto shrink-0 text-xs text-text-muted">
          {media.sizeLabel}
        </span>
        {media.dataUrl ? (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
            href={media.dataUrl}
            download={media.name}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
    );
  }

  if (media.kind === "youtube") {
    const src =
      media.youtubeUrl != null ? youtubeEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface-0"
        data-home-media="youtube"
      >
        <iframe
          title={media.name}
          src={src}
          className="aspect-video w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "video") {
    if (media.dataUrl) {
      return (
        <div
          className="overflow-hidden rounded-lg border border-border bg-surface-0"
          data-home-media="video"
        >
          <video
            className="max-h-80 w-full bg-surface-0"
            controls
            playsInline
            src={media.dataUrl}
          >
            <track kind="captions" />
          </video>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
            {media.name} · {media.sizeLabel}
          </div>
        </div>
      );
    }
    return (
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface-0"
        data-home-media="video"
      >
        <div
          className="flex h-44 items-end bg-[linear-gradient(180deg,var(--glow-accent-soft),transparent_40%),repeating-linear-gradient(0deg,transparent_0_19px,color-mix(in_oklab,var(--color-surface-3)_90%,transparent)_19px_20px),repeating-linear-gradient(90deg,transparent_0_19px,color-mix(in_oklab,var(--color-surface-3)_90%,transparent)_19px_20px)] px-3 py-2"
          role="img"
          aria-label={media.name}
        >
          <span className="rounded bg-surface-0/80 px-2 py-0.5 text-[11px] text-text-muted">
            {media.name} · {media.sizeLabel}
          </span>
        </div>
      </div>
    );
  }

  // image
  if (media.dataUrl) {
    return (
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface-0"
        data-home-media="image"
      >
        <img
          src={media.dataUrl}
          alt={media.name}
          className="max-h-80 w-full object-contain"
        />
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
          {media.name} · {media.sizeLabel}
        </div>
      </div>
    );
  }
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-surface-0"
      data-home-media="image"
    >
      <div
        className="flex h-44 items-end bg-[linear-gradient(180deg,var(--glow-accent-soft),transparent_40%),repeating-linear-gradient(0deg,transparent_0_19px,color-mix(in_oklab,var(--color-surface-3)_90%,transparent)_19px_20px),repeating-linear-gradient(90deg,transparent_0_19px,color-mix(in_oklab,var(--color-surface-3)_90%,transparent)_19px_20px)] px-3 py-2"
        role="img"
        aria-label={media.name}
      >
        <span className="rounded bg-surface-0/80 px-2 py-0.5 text-[11px] text-text-muted">
          {media.name} · {media.sizeLabel}
        </span>
      </div>
    </div>
  );
}

function PostMedia({
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
    // Intentionally omit youtubeUrl / dataUrl from the free DOM.
    return (
      <LockedMedia
        title={post.title?.trim() || t("communityHome.lockedTitle")}
        teaser={post.teaser ?? t("communityHome.lockedBody")}
      />
    );
  }
  return <UnlockedMedia media={post.media} />;
}

function CommentsBlock({
  post,
  authorName,
  canManageServer,
  onChange,
}: {
  post: CommunityHomePost;
  authorName: string;
  canManageServer: boolean;
  onChange: (posts: CommunityHomePost[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  if (post.status !== "published") {
    return null;
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-3" data-home-comments>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text"
          onClick={() => setOpen((value) => !value)}
          data-home-comments-toggle
        >
          {t("communityHome.comments", { count: post.comments.length })}
        </button>
        {canManageServer && (
          <button
            type="button"
            className="text-xs text-text-muted hover:text-text"
            onClick={() => {
              onChange(
                updateCommunityHomePost(post.serverId, post.id, {
                  commentsEnabled: !post.commentsEnabled,
                }),
              );
            }}
            data-home-comments-toggle-enabled
          >
            {post.commentsEnabled
              ? t("communityHome.comments.disable")
              : t("communityHome.comments.enable")}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {!post.commentsEnabled && (
            <p className="text-xs text-text-muted">
              {t("communityHome.comments.off")}
            </p>
          )}
          <ul className="space-y-2">
            {post.comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-lg bg-surface-0/60 px-3 py-2 text-sm"
                data-home-comment
              >
                <div className="mb-0.5 flex items-center gap-2">
                  <span className="font-semibold text-text">
                    {comment.authorName}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {relativeDayLabel(comment.createdAt, t)}
                  </span>
                  {canManageServer && (
                    <button
                      type="button"
                      className="ml-auto text-text-muted hover:text-danger"
                      aria-label={t("communityHome.comments.delete")}
                      onClick={() => {
                        onChange(
                          deleteCommunityHomeComment(
                            post.serverId,
                            post.id,
                            comment.id,
                          ),
                        );
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-text-muted">
                  {comment.body}
                </p>
              </li>
            ))}
          </ul>
          {post.commentsEnabled && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.trim()) {
                  return;
                }
                onChange(
                  addCommunityHomeComment(
                    post.serverId,
                    post.id,
                    authorName,
                    draft,
                  ),
                );
                setDraft("");
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface-0 px-3 py-1.5 text-sm text-text placeholder:text-text-muted"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("communityHome.comments.placeholder")}
                data-home-comment-input
              />
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                {t("communityHome.comments.submit")}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  viewer,
  canManageServer,
  authorName,
  onChange,
  onEdit,
}: {
  post: CommunityHomePost;
  viewer: CommunityHomeViewerRole;
  canManageServer: boolean;
  authorName: string;
  onChange: (posts: CommunityHomePost[]) => void;
  onEdit: (post: CommunityHomePost) => void;
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
    <article
      className="rounded-xl border border-border/80 bg-surface-2 p-4 shadow-none"
      data-home-post
      data-home-post-visibility={post.visibility}
      data-home-post-status={post.status}
      data-home-post-locked={locked ? "1" : "0"}
    >
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
            {post.status === "draft" && (
              <span className="rounded border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t("communityHome.status.draft")}
              </span>
            )}
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
        {canManageServer && (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-3 hover:text-text"
              aria-label={t("communityHome.compose.edit")}
              onClick={() => onEdit(post)}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-3 hover:text-danger"
              aria-label={t("communityHome.compose.delete")}
              onClick={() => {
                onChange(deleteCommunityHomePost(post.serverId, post.id));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </header>

      {post.title && !locked && (
        <h2 className="mb-1 font-display text-base font-semibold text-text">
          {post.title}
        </h2>
      )}

      <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-text">
        {locked
          ? (post.teaser ?? post.title ?? post.body)
          : post.body}
      </p>

      <PostMedia post={post} locked={locked} />

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {locked ? (
          <Button
            type="button"
            variant="secondary"
            className="gap-1.5"
            disabled
            data-home-unlock-cta
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            {t("communityHome.unlockCta")}
          </Button>
        ) : null}
      </footer>

      {!locked && (
        <CommentsBlock
          post={post}
          authorName={authorName}
          canManageServer={canManageServer}
          onChange={onChange}
        />
      )}
    </article>
  );
}

type ComposeState = {
  title: string;
  body: string;
  teaser: string;
  visibility: CommunityHomeVisibility;
  status: "draft" | "published";
  youtubeUrl: string;
  media: CommunityHomeMedia | null;
  editingId: string | null;
  commentsEnabled: boolean;
  errorKey: MessageKey | null;
};

const emptyCompose = (): ComposeState => ({
  title: "",
  body: "",
  teaser: "",
  visibility: "free",
  status: "published",
  youtubeUrl: "",
  media: null,
  editingId: null,
  commentsEnabled: true,
  errorKey: null,
});

function ComposeCard({
  initial,
  authorName,
  authorBadge,
  serverId,
  onSaved,
  onCancelEdit,
}: {
  initial: ComposeState;
  authorName: string;
  authorBadge: CommunityHomeAuthorBadge;
  serverId: string;
  onSaved: (posts: CommunityHomePost[]) => void;
  onCancelEdit: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ComposeState>(initial);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  async function onPickFile(file: File | null) {
    if (!file) {
      return;
    }
    if (file.size > COMMUNITY_HOME_MAX_BYTES) {
      const isVideo =
        file.type === "video/mp4" ||
        file.type === "video/webm" ||
        file.name.toLowerCase().endsWith(".mp4") ||
        file.name.toLowerCase().endsWith(".webm");
      setState((prev) => ({
        ...prev,
        errorKey: isVideo
          ? "communityHome.compose.videoOverLimit"
          : "communityHome.compose.fileOverLimit",
        media: null,
      }));
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setState((prev) => ({
        ...prev,
        media: homeMediaFromFile(file, dataUrl),
        youtubeUrl: "",
        errorKey: null,
      }));
    } catch {
      setState((prev) => ({
        ...prev,
        errorKey: "communityHome.compose.readFailed",
      }));
    }
  }

  return (
    <form
      className="rounded-xl border border-dashed border-accent/40 bg-surface-2/80 p-4"
      data-home-compose
      onSubmit={(event) => {
        event.preventDefault();
        if (!state.body.trim() && !state.title.trim()) {
          return;
        }
        let media = state.media;
        if (state.youtubeUrl.trim()) {
          const fromYt = homeMediaFromYoutube(state.youtubeUrl);
          if (!fromYt) {
            setState((prev) => ({
              ...prev,
              errorKey: "communityHome.compose.badYoutube",
            }));
            return;
          }
          media = fromYt;
        }
        const input = {
          title: state.title,
          body: state.body || state.title,
          visibility: state.visibility,
          teaser: state.teaser,
          media,
          status: state.status,
          commentsEnabled: state.commentsEnabled,
          authorBadge,
        };
        if (state.editingId) {
          onSaved(
            updateCommunityHomePost(serverId, state.editingId, {
              ...input,
              authorName,
              authorBadge,
            }),
          );
        } else {
          const post = createCommunityHomePost(serverId, authorName, input);
          onSaved(prependCommunityHomePost(serverId, post));
        }
        setState(emptyCompose());
        onCancelEdit();
      }}
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
        {state.editingId
          ? t("communityHome.compose.editTitle")
          : t("communityHome.compose.title")}
      </p>
      <input
        className="mb-2 w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
        value={state.title}
        onChange={(event) =>
          setState((prev) => ({ ...prev, title: event.target.value }))
        }
        placeholder={t("communityHome.compose.titlePlaceholder")}
        data-home-compose-title
      />
      <textarea
        className="mb-2 w-full resize-y rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
        rows={3}
        value={state.body}
        onChange={(event) =>
          setState((prev) => ({ ...prev, body: event.target.value }))
        }
        placeholder={t("communityHome.compose.placeholder")}
        data-home-compose-body
      />
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="radio"
            name="home-visibility"
            checked={state.visibility === "free"}
            onChange={() =>
              setState((prev) => ({ ...prev, visibility: "free" }))
            }
          />
          {t("communityHome.visibility.free")}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="radio"
            name="home-visibility"
            checked={state.visibility === "members"}
            onChange={() =>
              setState((prev) => ({ ...prev, visibility: "members" }))
            }
          />
          {t("communityHome.visibility.members")}
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={state.status === "draft"}
            onChange={(event) =>
              setState((prev) => ({
                ...prev,
                status: event.target.checked ? "draft" : "published",
              }))
            }
          />
          {t("communityHome.status.draft")}
        </label>
      </div>
      {state.visibility === "members" && (
        <input
          className="mb-2 w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
          value={state.teaser}
          onChange={(event) =>
            setState((prev) => ({ ...prev, teaser: event.target.value }))
          }
          placeholder={t("communityHome.compose.teaserPlaceholder")}
          data-home-compose-teaser
        />
      )}
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-text-muted">
          <span className="mb-1 block">
            {t("communityHome.compose.fileHint", {
              limit: formatHomeBytes(COMMUNITY_HOME_MAX_BYTES),
            })}
          </span>
          <input
            type="file"
            accept="image/*,video/mp4,video/webm,application/pdf,.pdf,.mp4,.webm"
            className="block w-full text-xs"
            data-home-compose-file
            onChange={(event) => {
              void onPickFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
        </label>
        <label className="block text-xs text-text-muted">
          <span className="mb-1 block">
            {t("communityHome.compose.youtubeHint")}
          </span>
          <input
            className="w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
            value={state.youtubeUrl}
            onChange={(event) =>
              setState((prev) => ({
                ...prev,
                youtubeUrl: event.target.value,
                media:
                  prev.media?.kind === "youtube" ? null : prev.media,
                errorKey: null,
              }))
            }
            placeholder="https://youtu.be/…"
            data-home-compose-youtube
          />
        </label>
      </div>
      {state.media && state.media.kind !== "youtube" && (
        <p className="mb-2 text-xs text-text-muted" data-home-compose-media-label>
          {state.media.name} · {state.media.sizeLabel}
          <button
            type="button"
            className="ml-2 text-accent hover:underline"
            onClick={() =>
              setState((prev) => ({ ...prev, media: null }))
            }
          >
            {t("communityHome.compose.clearMedia")}
          </button>
        </p>
      )}
      {state.errorKey && (
        <p className="mb-2 text-xs text-danger" data-home-compose-error>
          {t(state.errorKey)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {state.editingId && (
          <Button type="button" variant="secondary" onClick={onCancelEdit}>
            {t("communityHome.compose.cancel")}
          </Button>
        )}
        <Button
          type="submit"
          disabled={!state.body.trim() && !state.title.trim()}
          data-home-compose-submit
        >
          {state.status === "draft"
            ? t("communityHome.compose.saveDraft")
            : state.editingId
              ? t("communityHome.compose.save")
              : t("communityHome.compose.submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Durable manage-server post timeline for the Community Home experiment.
 *
 * Client-only fixtures + localStorage. Comments are a flat list, not chat.
 * Home is durable media — there is no "join the call" primary CTA.
 */
export function CommunityHomeFeed({
  serverId,
  serverName,
  authorName,
  canManageServer,
  isOwner,
  isVip,
  onOpenNav,
}: Props) {
  const { t } = useTranslation();
  const [viewerMode, setViewerMode] = useState<CommunityHomeViewerMode>(() =>
    loadCommunityHomeViewerMode(),
  );
  const [posts, setPosts] = useState<CommunityHomePost[]>(() =>
    loadCommunityHomePosts(serverId),
  );
  const [staffTab, setStaffTab] = useState<StaffTab>("preview");
  const [composeSeed, setComposeSeed] = useState<ComposeState>(emptyCompose);

  useEffect(() => {
    setPosts(loadCommunityHomePosts(serverId));
    setComposeSeed(emptyCompose());
  }, [serverId]);

  const viewer = useMemo(
    () =>
      resolveCommunityHomeViewer({
        mode: viewerMode,
        isOwner: canManageServer || isOwner,
        isVip,
      }),
    [viewerMode, canManageServer, isOwner, isVip],
  );

  const authorBadge: CommunityHomeAuthorBadge = isOwner ? "owner" : "member";

  const feedPosts = useMemo(
    () =>
      visibleCommunityHomePosts(posts, { canManageServer }).filter((post) => {
        // In preview-as-member modes staff still see drafts only when managing.
        if (post.status === "draft") {
          return canManageServer;
        }
        return true;
      }),
    [posts, canManageServer],
  );

  function beginEdit(post: CommunityHomePost) {
    setStaffTab("compose");
    setComposeSeed({
      title: post.title ?? "",
      body: post.body,
      teaser: post.teaser ?? "",
      visibility: post.visibility,
      status: post.status,
      youtubeUrl:
        post.media?.kind === "youtube" ? (post.media.youtubeUrl ?? "") : "",
      media: post.media?.kind === "youtube" ? null : post.media,
      editingId: post.id,
      commentsEnabled: post.commentsEnabled,
      errorKey: null,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent" data-community-home-feed>
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
        {canManageServer && (
          <div
            className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-2 p-0.5 text-[11px]"
            data-home-staff-tabs
          >
            {(
              [
                ["compose", "communityHome.cms.compose"],
                ["preview", "communityHome.cms.preview"],
              ] as const
            ).map(([tab, labelKey]) => (
              <button
                key={tab}
                type="button"
                className={cn(
                  "rounded-md px-2 py-1 capitalize text-text-muted",
                  staffTab === tab && "bg-surface-3 font-semibold text-text",
                )}
                onClick={() => setStaffTab(tab)}
                data-home-staff-tab={tab}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="mb-4 text-xs text-text-muted">
          {t("communityHome.note")}
          {canManageServer && staffTab === "preview"
            ? ` · ${t("communityHome.viewer.showing", {
                role: t(VIEWER_ROLE_LABEL[viewer]),
              })}`
            : null}
        </p>

        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {canManageServer && (
            <>
              {/* Compose stays mounted so switching Preview → Free/VIP never
                  unmounts the staff CMS; we only hide it visually. */}
              <div
                className={cn(staffTab !== "compose" && "hidden")}
                data-home-compose-panel
              >
                <ComposeCard
                  initial={composeSeed}
                  authorName={authorName}
                  authorBadge={authorBadge}
                  serverId={serverId}
                  onSaved={(next) => {
                    setPosts(next);
                    setComposeSeed(emptyCompose());
                  }}
                  onCancelEdit={() => setComposeSeed(emptyCompose())}
                />
              </div>

              {staffTab === "preview" && (
                <div
                  className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-2 p-0.5 text-[11px]"
                  data-home-viewer-tabs
                >
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
                        viewerMode === mode &&
                          "bg-surface-3 font-semibold text-text",
                      )}
                      onClick={() => {
                        setViewerMode(mode);
                        saveCommunityHomeViewerMode(mode);
                      }}
                      data-home-viewer-tab={mode}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {!canManageServer && (
            <div
              className="flex flex-wrap items-center gap-1 self-end rounded-lg border border-border bg-surface-2 p-0.5 text-[11px]"
              data-home-viewer-tabs
            >
              {(
                [
                  ["auto", "communityHome.viewer.auto"],
                  ["free", "communityHome.viewer.free"],
                  ["vip", "communityHome.viewer.vip"],
                ] as const
              ).map(([mode, labelKey]) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-1 capitalize text-text-muted",
                    viewerMode === mode &&
                      "bg-surface-3 font-semibold text-text",
                  )}
                  onClick={() => {
                    setViewerMode(mode);
                    saveCommunityHomeViewerMode(mode);
                  }}
                  data-home-viewer-tab={mode}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          )}

          {(staffTab === "preview" || !canManageServer) &&
            feedPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                viewer={viewer}
                canManageServer={canManageServer}
                authorName={authorName}
                onChange={setPosts}
                onEdit={beginEdit}
              />
            ))}

          {staffTab === "compose" && canManageServer && (
            <p className="text-xs text-text-muted">
              {t("communityHome.cms.composeHint")}
            </p>
          )}

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
