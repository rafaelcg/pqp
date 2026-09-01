import {
  ArrowLeft,
  CalendarClock,
  Download,
  Heart,
  Lock,
  Menu,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  createCommunityHomeComment,
  createCommunityHomePost,
  deleteCommunityHomeComment,
  deleteCommunityHomePost,
  fetchCommunityHomeComments,
  fetchCommunityHomeDrafts,
  fetchCommunityHomeMediaConfig,
  fetchCommunityHomePost,
  fetchCommunityHomePosts,
  publishCommunityHomePost,
  scheduleCommunityHomePost,
  toggleCommunityHomeLike,
  unpublishCommunityHomePost,
  updateCommunityHomePost,
} from "@/lib/api";
import {
  COMMUNITY_HOME_MAX_BYTES,
  formatHomeBytes,
  homeMediaKindFromFile,
  isPostLockedForViewer,
  loadCommunityHomeViewerMode,
  lockedPostSummary,
  parseYoutubeVideoId,
  saveCommunityHomeViewerMode,
  uploadHomeMedia,
  youtubeEmbedSrc,
  type CommunityHomeComment,
  type CommunityHomeMedia,
  type CommunityHomePost,
  type CommunityHomeViewerMode,
  type CommunityHomeVisibility,
} from "@/lib/community-home";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type CommunityHomeFeedProps = {
  serverId: string;
  serverName: string;
  authorName: string;
  canManageServer: boolean;
  isOwner: boolean;
  isVip: boolean;
  currentUserId?: string;
  onOpenNav?: () => void;
  refreshSignal?: number;
};

type InspectorMode = CommunityHomeViewerMode;
type ComposeStep = "edit" | "preview";
type SaveMode = "draft" | "publish" | "schedule";

/*
 * These keys are being added to the catalogues by the parent change. Keeping
 * them in one typed table makes every lookup static (never a templated key)
 * while this file can be reviewed independently from that catalogue patch.
 */
const COPY = {
  emptyTitle: "communityHome.empty.title" as MessageKey,
  emptyBody: "communityHome.empty.body" as MessageKey,
  introBody: "communityHome.intro.body" as MessageKey,
  introGotIt: "communityHome.intro.gotIt" as MessageKey,
  introNew: "communityHome.intro.new" as MessageKey,
  previewPost: "communityHome.compose.previewPost" as MessageKey,
  backToEdit: "communityHome.compose.backToEdit" as MessageKey,
  schedule: "communityHome.compose.schedule" as MessageKey,
  scheduleAt: "communityHome.compose.scheduleAt" as MessageKey,
  drafts: "communityHome.drafts.title" as MessageKey,
  noDrafts: "communityHome.drafts.empty" as MessageKey,
  inspector: "communityHome.inspector.title" as MessageKey,
  viewerMembers: "communityHome.viewer.members" as MessageKey,
  badgeStaff: "communityHome.badge.staff" as MessageKey,
  statusScheduled: "communityHome.status.scheduled" as MessageKey,
  like: "communityHome.like" as MessageKey,
} as const;

function relativeDayLabel(
  iso: string,
  t: (key: "time.today" | "time.yesterday") => string,
): string {
  const timestamp = new Date(iso).getTime();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  if (timestamp >= startToday.getTime()) {
    return t("time.today");
  }
  if (timestamp >= startToday.getTime() - 24 * 60 * 60 * 1000) {
    return t("time.yesterday");
  }
  return new Date(iso).toLocaleDateString();
}

function introStorageKey(
  serverId: string,
  currentUserId: string | undefined,
  authorName: string,
): string {
  return `pqp:community-home-intro:${serverId}:${currentUserId || authorName}`;
}

function isIntroSeen(key: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markIntroSeen(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // A blocked localStorage only makes the small intro appear next time.
  }
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
        className="h-40 bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_8px,var(--color-surface-0)_8px_16px)] blur-[1px]"
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-0/80 px-4 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Lock className="h-4 w-4" aria-hidden />
        </span>
        <p className="font-display text-sm font-semibold text-text">{title}</p>
        <p className="max-w-xs text-xs text-text-muted">{teaser}</p>
      </div>
    </div>
  );
}

function UnlockedMedia({ media }: { media: CommunityHomeMedia }) {
  if (media.kind === "youtube") {
    const src = media.youtubeUrl ? youtubeEmbedSrc(media.youtubeUrl) : null;
    return src ? (
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
    ) : null;
  }

  const size =
    media.byteSize == null ? null : formatHomeBytes(media.byteSize);

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
        {size && (
          <span className="ml-auto shrink-0 text-xs text-text-muted">
            {size}
          </span>
        )}
        {media.url && (
          <a
            className="inline-flex shrink-0 items-center text-accent hover:text-text"
            href={media.url}
            download={media.name}
          >
            <Download className="h-4 w-4" aria-hidden />
          </a>
        )}
      </div>
    );
  }

  if (!media.url) {
    return (
      <div className="rounded-lg border border-border bg-surface-0 px-3 py-8 text-center text-xs text-text-muted">
        {media.name}
        {size ? ` · ${size}` : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface-0"
        data-home-media="video"
      >
        <video
          className="max-h-96 w-full bg-surface-0"
          controls
          playsInline
          src={media.url}
        >
          <track kind="captions" />
        </video>
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
          {media.name}
          {size ? ` · ${size}` : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-surface-0"
      data-home-media="image"
    >
      <img
        src={media.url}
        alt={media.name}
        className="max-h-96 w-full object-contain"
      />
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
        {media.name}
        {size ? ` · ${size}` : null}
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
  if (locked) {
    return (
      <LockedMedia
        title={post.title?.trim() || t("communityHome.lockedTitle")}
        teaser={
          lockedPostSummary(post) || t("communityHome.lockedBody")
        }
      />
    );
  }
  return post.media ? <UnlockedMedia media={post.media} /> : null;
}

function AuthorBadge({
  badge,
}: {
  badge: CommunityHomePost["authorBadge"];
}) {
  const { t } = useTranslation();
  if (!badge) {
    return null;
  }
  return (
    <span className="rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
      {t(
        badge === "owner"
          ? "communityHome.badge.owner"
          : COPY.badgeStaff,
      )}
    </span>
  );
}

function CommentTeaser({
  comments,
}: {
  comments: CommunityHomeComment[];
}) {
  return comments.length > 0 ? (
    <ul className="mt-3 space-y-1.5" data-home-comment-teaser>
      {comments.map((comment) => (
        <li
          key={comment.id}
          className="rounded-lg bg-surface-0/60 px-3 py-2 text-sm"
        >
          <span className="mr-2 font-semibold text-text">
            {comment.author.displayName}
          </span>
          <span className="text-text-muted">{comment.body}</span>
        </li>
      ))}
    </ul>
  ) : null;
}

type PostCardProps = {
  post: CommunityHomePost;
  canManageServer: boolean;
  inspectorMode: InspectorMode;
  onOpenComments: (post: CommunityHomePost) => void;
  onLike: (post: CommunityHomePost) => void;
  onEdit: (post: CommunityHomePost) => void;
  onDelete: (post: CommunityHomePost) => void;
  onUnpublish: (post: CommunityHomePost) => void;
  onToggleComments: (post: CommunityHomePost) => void;
};

function CommunityHomePostCard({
  post,
  canManageServer,
  inspectorMode,
  onOpenComments,
  onLike,
  onEdit,
  onDelete,
  onUnpublish,
  onToggleComments,
}: PostCardProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const locked = isPostLockedForViewer(
    post,
    canManageServer,
    inspectorMode,
  );
  const summary = lockedPostSummary(post);

  return (
    <article
      className="rounded-xl border border-border/80 bg-surface-2 p-4"
      data-home-post
      data-home-post-visibility={post.visibility}
      data-home-post-status={post.status}
      data-home-post-locked={locked ? "1" : "0"}
    >
      <header className="mb-3 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 font-display text-xs font-bold text-text">
          {post.author.displayName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-text">
              {post.author.displayName}
            </span>
            <AuthorBadge badge={post.authorBadge} />
            <span className="text-xs text-text-muted">
              {relativeDayLabel(
                post.publishedAt ?? post.createdAt,
                t,
              )}
            </span>
          </div>
        </div>
        {canManageServer && (
          <div className="relative shrink-0">
            <button
              type="button"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-3 hover:text-text"
              aria-label={t("chat.more")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              data-home-post-menu
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-border bg-surface-2 p-1 shadow-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text hover:bg-surface-3"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit(post);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t("communityHome.compose.edit")}
                </button>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1.5 text-left text-xs text-text hover:bg-surface-3"
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleComments(post);
                  }}
                >
                  {post.commentsEnabled
                    ? t("communityHome.comments.disable")
                    : t("communityHome.comments.enable")}
                </button>
                {post.status === "published" && (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-text hover:bg-surface-3"
                    onClick={() => {
                      setMenuOpen(false);
                      onUnpublish(post);
                    }}
                  >
                    {t("communityHome.compose.saveDraft")}
                  </button>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger hover:bg-surface-3"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(post);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  {t("communityHome.compose.delete")}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {post.title && (
        <h2 className="mb-1 font-display text-base font-semibold text-text">
          {post.title}
        </h2>
      )}
      {(locked ? post.teaser : post.body) && (
        <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-text">
          {locked ? post.teaser : post.body}
        </p>
      )}
      {locked && !post.teaser && summary && summary !== post.title && (
        <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-text">
          {summary}
        </p>
      )}

      <PostMedia post={post} locked={locked} />
      <CommentTeaser comments={post.commentTeaser} />

      {post.status === "published" && (
        <footer className="mt-3 flex items-center gap-4 border-t border-border/60 pt-3">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text",
              post.likedByMe && "text-accent",
            )}
            aria-label={t(COPY.like)}
            aria-pressed={post.likedByMe}
            onClick={() => onLike(post)}
            data-home-like
          >
            <Heart
              className={cn("h-4 w-4", post.likedByMe && "fill-current")}
              aria-hidden
            />
            {post.likeCount > 0 ? post.likeCount : null}
          </button>
          <button
            type="button"
            className="text-xs text-text-muted hover:text-text"
            onClick={() => onOpenComments(post)}
            data-home-comments-open
          >
            {t("communityHome.comments", { count: post.commentCount })}
          </button>
        </footer>
      )}
    </article>
  );
}

export type CommunityHomeFeedContentProps = {
  posts: CommunityHomePost[];
  canManageServer: boolean;
  inspectorMode?: InspectorMode;
  onOpenComments?: (post: CommunityHomePost) => void;
  onLike?: (post: CommunityHomePost) => void;
  onEdit?: (post: CommunityHomePost) => void;
  onDelete?: (post: CommunityHomePost) => void;
  onUnpublish?: (post: CommunityHomePost) => void;
  onToggleComments?: (post: CommunityHomePost) => void;
};

const noopPost = () => {};

/** Pure feed body, exported so lock redaction can be pinned without a browser. */
export function CommunityHomeFeedContent({
  posts,
  canManageServer,
  inspectorMode = "auto",
  onOpenComments = noopPost,
  onLike = noopPost,
  onEdit = noopPost,
  onDelete = noopPost,
  onUnpublish = noopPost,
  onToggleComments = noopPost,
}: CommunityHomeFeedContentProps) {
  const { t } = useTranslation();
  if (posts.length === 0) {
    return (
      <div
        className="rounded-xl border border-border/70 bg-surface-1 px-5 py-8 text-center"
        data-home-empty
      >
        <p className="font-display text-sm font-semibold text-text">
          {t(COPY.emptyTitle)}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-text-muted">
          {t(COPY.emptyBody)}
        </p>
      </div>
    );
  }
  return (
    <>
      {posts.map((post) => (
        <CommunityHomePostCard
          key={post.id}
          post={post}
          canManageServer={canManageServer}
          inspectorMode={inspectorMode}
          onOpenComments={onOpenComments}
          onLike={onLike}
          onEdit={onEdit}
          onDelete={onDelete}
          onUnpublish={onUnpublish}
          onToggleComments={onToggleComments}
        />
      ))}
    </>
  );
}

type ComposeState = {
  title: string;
  body: string;
  teaser: string;
  visibility: CommunityHomeVisibility;
  commentsEnabled: boolean;
  youtubeUrl: string;
  file: File | null;
  existingMedia: CommunityHomeMedia | null;
  clearMedia: boolean;
  editingPost: CommunityHomePost | null;
};

function composeState(post: CommunityHomePost | null = null): ComposeState {
  return {
    title: post?.title ?? "",
    body: post?.body ?? "",
    teaser: post?.teaser ?? "",
    visibility: post?.visibility ?? "free",
    commentsEnabled: post?.commentsEnabled ?? true,
    youtubeUrl:
      post?.media?.kind === "youtube" ? post.media.youtubeUrl ?? "" : "",
    file: null,
    existingMedia:
      post?.media?.kind === "youtube" ? null : post?.media ?? null,
    clearMedia: false,
    editingPost: post,
  };
}

type ComposeOverlayProps = {
  serverId: string;
  authorName: string;
  isOwner: boolean;
  initialPost: CommunityHomePost | null;
  mediaEnabled: boolean;
  mediaMaxBytes: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
};

function ComposeOverlay({
  serverId,
  authorName,
  isOwner,
  initialPost,
  mediaEnabled,
  mediaMaxBytes,
  onClose,
  onSaved,
}: ComposeOverlayProps) {
  const { t } = useTranslation();
  const [state, setState] = useState(() => composeState(initialPost));
  const [step, setStep] = useState<ComposeStep>("edit");
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  useEffect(() => {
    setState(composeState(initialPost));
    setStep("edit");
    setScheduleAt("");
    setErrorKey(null);
  }, [initialPost]);

  const filePreviewUrl = useMemo(
    () =>
      state.file && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(state.file)
        : null,
    [state.file],
  );

  useEffect(
    () => () => {
      if (filePreviewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(filePreviewUrl);
      }
    },
    [filePreviewUrl],
  );

  const previewMedia = useMemo<CommunityHomeMedia | null>(() => {
    if (state.file) {
      return {
        kind: homeMediaKindFromFile(state.file),
        name: state.file.name,
        contentType: state.file.type || null,
        byteSize: state.file.size,
        url: filePreviewUrl,
        youtubeUrl: null,
      };
    }
    if (state.youtubeUrl.trim()) {
      return parseYoutubeVideoId(state.youtubeUrl)
        ? {
            kind: "youtube",
            name: "YouTube",
            contentType: null,
            byteSize: null,
            url: null,
            youtubeUrl: state.youtubeUrl.trim(),
          }
        : null;
    }
    return state.clearMedia ? null : state.existingMedia;
  }, [
    filePreviewUrl,
    state.clearMedia,
    state.existingMedia,
    state.file,
    state.youtubeUrl,
  ]);

  function validatePublish(): boolean {
    if (!state.title.trim()) {
      setErrorKey("communityHome.compose.titlePlaceholder");
      return false;
    }
    if (!state.body.trim() && !previewMedia) {
      setErrorKey("communityHome.compose.placeholder");
      return false;
    }
    if (state.youtubeUrl.trim() && !parseYoutubeVideoId(state.youtubeUrl)) {
      setErrorKey("communityHome.compose.badYoutube");
      return false;
    }
    setErrorKey(null);
    return true;
  }

  async function save(mode: SaveMode) {
    if (mode !== "draft" && !validatePublish()) {
      setStep("edit");
      return;
    }
    let scheduleRequest: {
      scheduledAt: string;
      scheduleTimezone: string;
    } | null = null;
    if (mode === "schedule") {
      const parsedSchedule = new Date(scheduleAt);
      if (
        !scheduleAt ||
        !Number.isFinite(parsedSchedule.getTime()) ||
        parsedSchedule.getTime() <= Date.now()
      ) {
        setErrorKey(COPY.scheduleAt);
        return;
      }
      scheduleRequest = {
        scheduledAt: parsedSchedule.toISOString(),
        scheduleTimezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      };
    }
    setBusy(true);
    setErrorKey(null);
    try {
      let mediaUploadId: string | undefined;
      if (state.file) {
        const uploaded = await uploadHomeMedia(serverId, state.file, {
          onProgress: setProgress,
        });
        mediaUploadId = uploaded.uploadId;
      }

      const common = {
        title: state.title.trim() || null,
        body: state.body.trim() || null,
        teaser:
          state.visibility === "members"
            ? state.teaser.trim() || null
            : null,
        visibility: state.visibility,
        commentsEnabled: state.commentsEnabled,
      };
      const mediaFields = mediaUploadId
        ? { mediaUploadId }
        : state.youtubeUrl.trim()
          ? { youtubeUrl: state.youtubeUrl.trim() }
          : state.clearMedia
            ? { clearMedia: true }
            : {};

      let saved: CommunityHomePost;
      if (state.editingPost) {
        ({ post: saved } = await updateCommunityHomePost(
          serverId,
          state.editingPost.id,
          { ...common, ...mediaFields },
        ));
      } else {
        ({ post: saved } = await createCommunityHomePost(serverId, {
          ...common,
          ...mediaFields,
          status: mode === "publish" ? "published" : "draft",
        }));
      }

      if (mode === "publish" && saved.status !== "published") {
        ({ post: saved } = await publishCommunityHomePost(serverId, saved.id));
      } else if (mode === "schedule" && scheduleRequest) {
        ({ post: saved } = await scheduleCommunityHomePost(
          serverId,
          saved.id,
          scheduleRequest,
        ));
      } else if (
        mode === "draft" &&
        (saved.status === "published" || saved.status === "scheduled")
      ) {
        await unpublishCommunityHomePost(serverId, saved.id);
      }

      await onSaved();
      onClose();
    } catch {
      setErrorKey("common.failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const previewPost: CommunityHomePost = {
    id: state.editingPost?.id ?? "00000000-0000-4000-8000-000000000000",
    serverId,
    author: state.editingPost?.author ?? {
      id: "00000000-0000-4000-8000-000000000000",
      displayName: authorName,
      username: null,
      tag: null,
      avatarUrl: null,
    },
    authorBadge: isOwner ? "owner" : "staff",
    title: state.title.trim() || null,
    body: state.body.trim() || null,
    teaser: state.teaser.trim() || null,
    visibility: state.visibility,
    status: "draft",
    commentsEnabled: state.commentsEnabled,
    media: previewMedia,
    locked: false,
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    commentTeaser: [],
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-0"
      data-home-compose
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        {step === "preview" ? (
          <button
            type="button"
            className="rounded-md p-2 text-text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t(COPY.backToEdit)}
            onClick={() => setStep("edit")}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <span className="h-8 w-8" aria-hidden />
        )}
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-bold text-text">
          {step === "preview"
            ? t("communityHome.cms.preview")
            : initialPost
              ? t("communityHome.compose.editTitle")
              : t("communityHome.compose.title")}
        </h2>
        <button
          type="button"
          className="rounded-md p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-2xl">
          {step === "edit" ? (
            <div className="space-y-4">
              <input
                className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-muted"
                value={state.title}
                maxLength={200}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder={t("communityHome.compose.titlePlaceholder")}
                data-home-compose-title
              />
              <textarea
                className="w-full resize-y rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-muted"
                rows={7}
                value={state.body}
                maxLength={4000}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    body: event.target.value,
                  }))
                }
                placeholder={t("communityHome.compose.placeholder")}
                data-home-compose-body
              />
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-text-muted">
                  <input
                    type="radio"
                    name="home-visibility"
                    checked={state.visibility === "free"}
                    onChange={() =>
                      setState((current) => ({
                        ...current,
                        visibility: "free",
                      }))
                    }
                  />
                  {t("communityHome.visibility.free")}
                </label>
                <label className="flex items-center gap-2 text-sm text-text-muted">
                  <input
                    type="radio"
                    name="home-visibility"
                    checked={state.visibility === "members"}
                    onChange={() =>
                      setState((current) => ({
                        ...current,
                        visibility: "members",
                      }))
                    }
                  />
                  {t("communityHome.visibility.members")}
                </label>
                <label className="ml-auto flex items-center gap-2 text-sm text-text-muted">
                  <input
                    type="checkbox"
                    checked={state.commentsEnabled}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        commentsEnabled: event.target.checked,
                      }))
                    }
                  />
                  {t("communityHome.comments.enable")}
                </label>
              </div>
              {state.visibility === "members" && (
                <input
                  className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-muted"
                  value={state.teaser}
                  maxLength={500}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      teaser: event.target.value,
                    }))
                  }
                  placeholder={t(
                    "communityHome.compose.teaserPlaceholder",
                  )}
                  data-home-compose-teaser
                />
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {mediaEnabled && (
                  <label className="block text-xs text-text-muted">
                    <span className="mb-1 block">
                      {t("communityHome.compose.fileHint", {
                        limit: formatHomeBytes(
                          Math.min(mediaMaxBytes, COMMUNITY_HOME_MAX_BYTES),
                        ),
                      })}
                    </span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,application/pdf"
                      className="block w-full text-xs"
                      data-home-compose-file
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        if (
                          file &&
                          file.size >
                            Math.min(
                              mediaMaxBytes,
                              COMMUNITY_HOME_MAX_BYTES,
                            )
                        ) {
                          setErrorKey(
                            file.type.startsWith("video/")
                              ? "communityHome.compose.videoOverLimit"
                              : "communityHome.compose.fileOverLimit",
                          );
                          event.target.value = "";
                          return;
                        }
                        setState((current) => ({
                          ...current,
                          file,
                          youtubeUrl: "",
                          clearMedia: Boolean(file),
                        }));
                        setErrorKey(null);
                      }}
                    />
                  </label>
                )}
                <label className="block text-xs text-text-muted">
                  <span className="mb-1 block">
                    {t("communityHome.compose.youtubeHint")}
                  </span>
                  <input
                    className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-muted"
                    value={state.youtubeUrl}
                    onChange={(event) => {
                      const youtubeUrl = event.target.value;
                      setState((current) => ({
                        ...current,
                        youtubeUrl,
                        file: null,
                        clearMedia: !youtubeUrl.trim(),
                      }));
                      setErrorKey(null);
                    }}
                    placeholder="https://youtu.be/…"
                    data-home-compose-youtube
                  />
                </label>
              </div>
              {(state.file ||
                (!state.clearMedia && state.existingMedia)) && (
                <p className="text-xs text-text-muted">
                  {state.file?.name ?? state.existingMedia?.name}
                  <button
                    type="button"
                    className="ml-2 text-accent hover:text-text"
                    onClick={() =>
                      setState((current) => ({
                        ...current,
                        file: null,
                        existingMedia: null,
                        youtubeUrl: "",
                        clearMedia: true,
                      }))
                    }
                  >
                    {t("communityHome.compose.clearMedia")}
                  </button>
                </p>
              )}
              {errorKey && (
                <p className="text-sm text-danger" data-home-compose-error>
                  {t(errorKey)}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {(!initialPost || initialPost.status !== "published") && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void save("draft")}
                  >
                    {t("communityHome.compose.saveDraft")}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (validatePublish()) {
                      setStep("preview");
                    }
                  }}
                  data-home-preview-post
                >
                  {t(COPY.previewPost)}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <CommunityHomePostCard
                post={previewPost}
                canManageServer={false}
                inspectorMode="auto"
                onOpenComments={noopPost}
                onLike={noopPost}
                onEdit={noopPost}
                onDelete={noopPost}
                onUnpublish={noopPost}
                onToggleComments={noopPost}
              />
              <label className="block text-xs text-text-muted">
                <span className="mb-1 block">{t(COPY.scheduleAt)}</span>
                <input
                  type="datetime-local"
                  className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                  data-home-schedule-at
                />
              </label>
              {progress != null && (
                <div className="h-1 overflow-hidden rounded bg-surface-3">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              )}
              {errorKey && (
                <p className="text-sm text-danger" data-home-compose-error>
                  {t(errorKey)}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || !scheduleAt}
                  onClick={() => void save("schedule")}
                  data-home-schedule
                >
                  <CalendarClock className="h-4 w-4" aria-hidden />
                  {t(COPY.schedule)}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void save("publish")}
                  data-home-publish
                >
                  {t("communityHome.compose.submit")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type CommentsOverlayProps = {
  serverId: string;
  post: CommunityHomePost;
  currentUserId?: string;
  canManageServer: boolean;
  onClose: () => void;
  onPostChange: (post: CommunityHomePost) => void;
};

function CommentsOverlay({
  serverId,
  post,
  currentUserId,
  canManageServer,
  onClose,
  onPostChange,
}: CommentsOverlayProps) {
  const { t } = useTranslation();
  const [comments, setComments] = useState<CommunityHomeComment[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ comments: nextComments }, { post: freshPost }] =
        await Promise.all([
          fetchCommunityHomeComments(serverId, post.id),
          fetchCommunityHomePost(serverId, post.id),
        ]);
      setComments(nextComments);
      onPostChange(freshPost);
    } finally {
      setLoading(false);
    }
  }, [onPostChange, post.id, serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || saving) {
      return;
    }
    setSaving(true);
    try {
      const { comment } = await createCommunityHomeComment(
        serverId,
        post.id,
        { body: draft.trim() },
      );
      setComments((current) => [...current, comment]);
      setDraft("");
      const { post: freshPost } = await fetchCommunityHomePost(
        serverId,
        post.id,
      );
      onPostChange(freshPost);
    } finally {
      setSaving(false);
    }
  }

  async function remove(comment: CommunityHomeComment) {
    await deleteCommunityHomeComment(serverId, post.id, comment.id);
    setComments((current) =>
      current.filter((entry) => entry.id !== comment.id),
    );
    const { post: freshPost } = await fetchCommunityHomePost(
      serverId,
      post.id,
    );
    onPostChange(freshPost);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-0"
      data-home-comments-detail
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="h-8 w-8" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-bold text-text">
          {post.title ?? t("communityHome.title")}
        </h2>
        <button
          type="button"
          className="rounded-md p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-2xl space-y-3">
          {loading ? (
            <p className="text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <ul className="space-y-2">
              {comments.map((comment) => (
                <li
                  key={comment.id}
                  className="rounded-lg border border-border/70 bg-surface-1 px-3 py-2"
                  data-home-comment
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text">
                      {comment.author.displayName}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      {relativeDayLabel(comment.createdAt, t)}
                    </span>
                    {(canManageServer ||
                      comment.author.id === currentUserId) && (
                      <button
                        type="button"
                        className="ml-auto rounded p-1 text-text-muted hover:text-danger"
                        aria-label={t(
                          "communityHome.comments.delete",
                        )}
                        onClick={() => void remove(comment)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-text-muted">
                    {comment.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {!post.commentsEnabled && (
            <p className="text-sm text-text-muted">
              {t("communityHome.comments.off")}
            </p>
          )}
        </div>
      </div>
      {post.commentsEnabled && (
        <form
          className="border-t border-border bg-surface-1 p-3"
          onSubmit={(event) => void submit(event)}
        >
          <div className="mx-auto flex max-w-2xl gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text placeholder:text-text-muted"
              value={draft}
              maxLength={1000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("communityHome.comments.placeholder")}
              data-home-comment-input
            />
            <Button
              type="submit"
              size="sm"
              disabled={!draft.trim() || saving}
            >
              {t("communityHome.comments.submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

type DraftsOverlayProps = {
  drafts: CommunityHomePost[];
  onClose: () => void;
  onEdit: (post: CommunityHomePost) => void;
  onPublish: (post: CommunityHomePost) => void;
  onDelete: (post: CommunityHomePost) => void;
};

function DraftsOverlay({
  drafts,
  onClose,
  onEdit,
  onPublish,
  onDelete,
}: DraftsOverlayProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-0" data-home-drafts>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="h-8 w-8" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-bold text-text">
          {t(COPY.drafts)}
        </h2>
        <button
          type="button"
          className="rounded-md p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-2xl space-y-3">
          {drafts.length === 0 ? (
            <p className="text-sm text-text-muted">{t(COPY.noDrafts)}</p>
          ) : (
            drafts.map((post) => (
              <article
                key={post.id}
                className="rounded-xl border border-border bg-surface-1 p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-text">
                      {post.title || t("communityHome.compose.title")}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {t(
                        post.status === "scheduled"
                          ? COPY.statusScheduled
                          : "communityHome.status.draft",
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(post)}
                  >
                    {t("communityHome.compose.edit")}
                  </Button>
                  {post.status === "draft" && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onPublish(post)}
                    >
                      {t("communityHome.compose.submit")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("communityHome.compose.delete")}
                    onClick={() => onDelete(post)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function CommunityHomeFeed({
  serverId,
  serverName,
  authorName,
  canManageServer,
  isOwner,
  currentUserId,
  onOpenNav,
  refreshSignal,
}: CommunityHomeFeedProps) {
  const { t } = useTranslation();
  const introKey = introStorageKey(serverId, currentUserId, authorName);
  const [showIntro, setShowIntro] = useState(() => !isIntroSeen(introKey));
  const [posts, setPosts] = useState<CommunityHomePost[]>([]);
  const [drafts, setDrafts] = useState<CommunityHomePost[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>(() =>
    loadCommunityHomeViewerMode(),
  );
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [composePost, setComposePost] = useState<
    CommunityHomePost | null | undefined
  >(undefined);
  const [commentsPost, setCommentsPost] =
    useState<CommunityHomePost | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [mediaEnabled, setMediaEnabled] = useState(false);
  const [mediaMaxBytes, setMediaMaxBytes] = useState(
    COMMUNITY_HOME_MAX_BYTES,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [feed, staffDrafts] = await Promise.all([
        fetchCommunityHomePosts(serverId),
        canManageServer
          ? fetchCommunityHomeDrafts(serverId)
          : Promise.resolve({ posts: [] }),
      ]);
      setPosts(feed.posts);
      setDrafts(staffDrafts.posts);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [canManageServer, serverId]);

  useEffect(() => {
    let cancelled = false;
    setPosts([]);
    setDrafts([]);
    setLoading(true);
    setLoadFailed(false);
    void Promise.all([
      fetchCommunityHomePosts(serverId),
      canManageServer
        ? fetchCommunityHomeDrafts(serverId)
        : Promise.resolve({ posts: [] }),
    ])
      .then(([feed, staffDrafts]) => {
        if (!cancelled) {
          setPosts(feed.posts);
          setDrafts(staffDrafts.posts);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canManageServer, refreshSignal, serverId]);

  useEffect(() => {
    const seen = isIntroSeen(introKey);
    setShowIntro(!seen);
    if (!seen) {
      markIntroSeen(introKey);
    }
  }, [introKey]);

  useEffect(() => {
    if (composePost === undefined) {
      return;
    }
    let cancelled = false;
    void fetchCommunityHomeMediaConfig(serverId)
      .then((config) => {
        if (!cancelled) {
          setMediaEnabled(config.enabled);
          setMediaMaxBytes(config.maxBytes);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMediaEnabled(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composePost, serverId]);

  const replacePost = useCallback((post: CommunityHomePost) => {
    setPosts((current) =>
      current.map((entry) => (entry.id === post.id ? post : entry)),
    );
    setDrafts((current) =>
      current.map((entry) => (entry.id === post.id ? post : entry)),
    );
    setCommentsPost((current) =>
      current?.id === post.id ? post : current,
    );
  }, []);

  async function like(post: CommunityHomePost) {
    const result = await toggleCommunityHomeLike(serverId, post.id);
    replacePost({
      ...post,
      likedByMe: result.liked,
      likeCount: result.likeCount,
    });
  }

  async function remove(post: CommunityHomePost) {
    await deleteCommunityHomePost(serverId, post.id);
    setPosts((current) => current.filter((entry) => entry.id !== post.id));
    setDrafts((current) => current.filter((entry) => entry.id !== post.id));
  }

  async function unpublish(post: CommunityHomePost) {
    await unpublishCommunityHomePost(serverId, post.id);
    await refresh();
  }

  async function toggleComments(post: CommunityHomePost) {
    const { post: updated } = await updateCommunityHomePost(
      serverId,
      post.id,
      {
        commentsEnabled: !post.commentsEnabled,
        // The current API update contract replaces the teaser when visibility
        // is members-only, so carry it through this otherwise unrelated edit.
        ...(post.visibility === "members" ? { teaser: post.teaser } : {}),
      },
    );
    replacePost(updated);
  }

  async function publishDraft(post: CommunityHomePost) {
    await publishCommunityHomePost(serverId, post.id);
    await refresh();
    setDraftsOpen(false);
  }

  function openComposer(post: CommunityHomePost | null = null) {
    setHeaderMenuOpen(false);
    setDraftsOpen(false);
    setComposePost(post);
  }

  function dismissIntro(openNew = false) {
    markIntroSeen(introKey);
    setShowIntro(false);
    if (openNew && canManageServer) {
      openComposer();
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-transparent"
      data-community-home-feed
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/80 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center">
          {onOpenNav && (
            <button
              type="button"
              className="rounded-md p-1.5 text-text-muted hover:bg-surface-3 hover:text-text md:hidden"
              aria-label={t("empty.openNav")}
              onClick={onOpenNav}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>
        <h1
          className="min-w-0 flex-1 truncate font-display text-base font-bold text-text"
          title={serverName}
        >
          {t("communityHome.title")}
        </h1>
        {canManageServer ? (
          <>
            <button
              type="button"
              className="rounded-md p-2 text-text-muted hover:bg-surface-3 hover:text-text"
              aria-label={t("communityHome.compose.title")}
              onClick={() => openComposer()}
              data-home-staff-pen
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
            <div className="relative">
              <button
                type="button"
                className="rounded-md p-2 text-text-muted hover:bg-surface-3 hover:text-text"
                aria-label={t("chat.more")}
                aria-expanded={headerMenuOpen}
                onClick={() => setHeaderMenuOpen((open) => !open)}
                data-home-staff-overflow
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
              {headerMenuOpen && (
                <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-border bg-surface-2 p-1 shadow-xl">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {t(COPY.inspector)}
                  </p>
                  {(
                    [
                      ["auto", "communityHome.viewer.auto"],
                      ["owner", "communityHome.viewer.owner"],
                      ["members", COPY.viewerMembers],
                    ] as const
                  ).map(([mode, key]) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-left text-xs text-text-muted hover:bg-surface-3 hover:text-text",
                        inspectorMode === mode &&
                          "bg-surface-3 font-semibold text-text",
                      )}
                      onClick={() => {
                        setInspectorMode(mode);
                        saveCommunityHomeViewerMode(mode);
                        setHeaderMenuOpen(false);
                      }}
                      data-home-inspector-mode={mode}
                    >
                      {t(key)}
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-text-muted hover:bg-surface-3 hover:text-text"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      setDraftsOpen(true);
                    }}
                  >
                    {t(COPY.drafts)}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="h-8 w-8 shrink-0" aria-hidden />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {showIntro && (
            <aside
              className="rounded-xl border border-border bg-surface-1 px-4 py-4"
              data-home-intro
            >
              <p className="text-sm leading-relaxed text-text-muted">
                {t(COPY.introBody)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => dismissIntro()}
                >
                  {t(COPY.introGotIt)}
                </Button>
                {canManageServer && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => dismissIntro(true)}
                  >
                    {t(COPY.introNew)}
                  </Button>
                )}
              </div>
            </aside>
          )}

          {loading && posts.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">
              {t("common.loading")}
            </p>
          ) : loadFailed && posts.length === 0 ? (
            <button
              type="button"
              className="rounded-xl border border-border bg-surface-1 px-4 py-8 text-sm text-text-muted hover:text-text"
              onClick={() => void refresh()}
            >
              {t("common.failed")}
            </button>
          ) : (
            <CommunityHomeFeedContent
              posts={posts}
              canManageServer={canManageServer}
              inspectorMode={inspectorMode}
              onOpenComments={setCommentsPost}
              onLike={(post) => void like(post)}
              onEdit={(post) => openComposer(post)}
              onDelete={(post) => void remove(post)}
              onUnpublish={(post) => void unpublish(post)}
              onToggleComments={(post) => void toggleComments(post)}
            />
          )}
        </div>
      </div>

      {composePost !== undefined && (
        <ComposeOverlay
          serverId={serverId}
          authorName={authorName}
          isOwner={isOwner}
          initialPost={composePost}
          mediaEnabled={mediaEnabled}
          mediaMaxBytes={mediaMaxBytes}
          onClose={() => setComposePost(undefined)}
          onSaved={refresh}
        />
      )}
      {commentsPost && (
        <CommentsOverlay
          serverId={serverId}
          post={commentsPost}
          currentUserId={currentUserId}
          canManageServer={canManageServer}
          onClose={() => setCommentsPost(null)}
          onPostChange={replacePost}
        />
      )}
      {draftsOpen && (
        <DraftsOverlay
          drafts={drafts}
          onClose={() => setDraftsOpen(false)}
          onEdit={openComposer}
          onPublish={(post) => void publishDraft(post)}
          onDelete={(post) => void remove(post)}
        />
      )}
    </div>
  );
}
