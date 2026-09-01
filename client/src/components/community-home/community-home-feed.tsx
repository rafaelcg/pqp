import type { PublicUser } from "@pqp/shared";
import {
  Archive,
  CalendarClock,
  Download,
  Eye,
  Heart,
  Lock,
  Menu,
  MessageCircle,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  createCommunityHomeComment,
  createCommunityHomePost,
  deleteCommunityHomeComment,
  deleteCommunityHomePost,
  fetchCommunityHomeComments,
  fetchCommunityHomeDrafts,
  fetchCommunityHomePosts,
  publishCommunityHomePost,
  scheduleCommunityHomePost,
  toggleCommunityHomeLike,
  unpublishCommunityHomePost,
  updateCommunityHomePost,
} from "@/lib/api";
import {
  COMMUNITY_HOME_BODY_MAX,
  COMMUNITY_HOME_COMMENT_MAX,
  COMMUNITY_HOME_MAX_BYTES,
  COMMUNITY_HOME_TEASER_MAX,
  COMMUNITY_HOME_TITLE_MAX,
  formatHomeBytes,
  isHomeVideoFile,
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
  type UploadedHomeMedia,
} from "@/lib/community-home";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CommunityHomeIntroCard,
  CommunityHomeStaffGuide,
} from "./community-home-onboarding";

/**
 * Baú: the durable media feed of a server. Posts, likes, flat comments,
 * a staff composer with preview and schedule. Everything here is read from
 * and written to the API; the component owns no truth of its own beyond
 * what is in flight.
 *
 * Shape of the pane:
 *   header   Baú · server name · (staff) Feed | Compose | Drafts
 *   body     intro card (until dismissed) · posts · empty states
 *
 * Comments are deliberately not chat. A card shows the two newest and a
 * "see all" link; the full list is fetched only when asked for. That is what
 * keeps a popular post from turning the feed into #geral.
 */

type Props = {
  serverId: string;
  serverName: string;
  /** The signed-in person, for the composer preview and optimistic comments. */
  me: PublicUser;
  /** Real manage-server bit. VIP cargo alone cannot publish. */
  canManageServer: boolean;
  isOwner: boolean;
  isVip: boolean;
  /** `COMMUNITY_HOME_VIP_ENABLED` from the config endpoint. */
  vipEnabled: boolean;
  /** Object storage configured on the API, so file uploads are possible. */
  mediaEnabled: boolean;
  /** `preferences.communityHomeIntroDismissedAt` is set. */
  introDismissed: boolean;
  onDismissIntro: () => void;
  onOpenNav?: () => void;
  /** Bumped by App on `community-home-update` for this server. */
  refreshSignal?: number;
};

type StaffTab = "feed" | "compose" | "drafts";

// ------------------------------------------------------------------ helpers

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

function scheduledLabel(iso: string, timezone: string | null): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message || fallback;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultScheduleValue(): string {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  return toLocalInputValue(next);
}

// -------------------------------------------------------------------- media

function LockedMedia({ title, teaser }: { title: string; teaser: string }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-ink-4 bg-ink"
      data-home-locked-media
    >
      <div
        className="flex h-40 items-center justify-center bg-[repeating-linear-gradient(135deg,var(--color-surface-3)_0_8px,var(--color-surface-0)_8px_16px)] blur-[1px]"
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/70 px-4 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-signal/15 text-signal">
          <Lock className="h-4 w-4" aria-hidden />
        </span>
        <p className="font-display text-sm font-semibold text-signal">{title}</p>
        <p className="max-w-xs text-xs text-paper-muted">{teaser}</p>
      </div>
    </div>
  );
}

function MediaCaption({ media }: { media: CommunityHomeMedia }) {
  return (
    <div className="border-t border-ink-4 px-3 py-1.5 text-[11px] text-paper-muted">
      {media.name}
      {media.byteSize != null ? ` · ${formatHomeBytes(media.byteSize)}` : null}
    </div>
  );
}

function UnlockedMedia({ media }: { media: CommunityHomeMedia }) {
  const { t } = useTranslation();
  if (media.kind === "youtube") {
    const src = media.youtubeUrl ? youtubeEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div
        className="overflow-hidden rounded-lg border border-ink-4 bg-ink"
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

  if (media.kind === "file") {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-ink-4 bg-ink px-3 py-2.5 text-sm"
        data-home-media="file"
      >
        <span className="rounded bg-signal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal">
          {media.name.toLowerCase().endsWith(".pdf") ? "PDF" : t("communityHome.media.file")}
        </span>
        <span className="min-w-0 truncate">{media.name}</span>
        {media.byteSize != null && (
          <span className="ml-auto shrink-0 text-xs text-paper-muted">
            {formatHomeBytes(media.byteSize)}
          </span>
        )}
        {media.url ? (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs text-signal hover:underline"
            href={media.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("communityHome.media.download")}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div
        className="overflow-hidden rounded-lg border border-ink-4 bg-ink"
        data-home-media="video"
      >
        {media.url ? (
          <video
            className="max-h-96 w-full bg-ink"
            controls
            playsInline
            preload="metadata"
            src={media.url}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
            {t("communityHome.media.unavailable")}
          </div>
        )}
        <MediaCaption media={media} />
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-lg border border-ink-4 bg-ink"
      data-home-media="image"
    >
      {media.url ? (
        <img
          src={media.url}
          alt={media.name}
          loading="lazy"
          decoding="async"
          className="max-h-[32rem] w-full object-contain"
        />
      ) : (
        <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
          {t("communityHome.media.unavailable")}
        </div>
      )}
      <MediaCaption media={media} />
    </div>
  );
}

// ----------------------------------------------------------------- comments

function CommentRow({
  comment,
  canDelete,
  onDelete,
}: {
  comment: CommunityHomeComment;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex gap-2.5" data-home-comment>
      <UserAvatar
        name={comment.author.displayName}
        avatarUrl={comment.author.avatarUrl}
        className="mt-0.5 h-6 w-6"
        fallbackClassName="bg-ink-4 text-[10px] text-paper"
        rounded="full"
      />
      <div className="min-w-0 flex-1 rounded-lg bg-ink/60 px-3 py-2 text-sm">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="truncate font-semibold">
            {comment.author.displayName}
          </span>
          <span className="shrink-0 text-[11px] text-paper-muted">
            {relativeDayLabel(comment.createdAt, t)}
          </span>
          {canDelete && (
            <button
              type="button"
              className="ml-auto shrink-0 rounded p-0.5 text-paper-muted hover:text-danger"
              aria-label={t("communityHome.comments.delete")}
              title={t("communityHome.comments.delete")}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-paper-muted">
          {comment.body}
        </p>
      </div>
    </li>
  );
}

/**
 * The comment block under a published post.
 *
 * Collapsed: count + the two newest. Expanded: the whole list, fetched on
 * demand. The composer is a single line, never a full chat input.
 */
function CommentsBlock({
  post,
  me,
  canManageServer,
  onPatch,
}: {
  post: CommunityHomePost;
  me: PublicUser;
  canManageServer: boolean;
  onPatch: (patch: Partial<CommunityHomePost>) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [all, setAll] = useState<CommunityHomeComment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = expanded && all ? all : post.commentTeaser;
  const hiddenCount = Math.max(0, post.commentCount - post.commentTeaser.length);

  async function expand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (all) {
      return;
    }
    setLoading(true);
    try {
      const { comments } = await fetchCommunityHomeComments(
        post.serverId,
        post.id,
      );
      setAll(comments);
    } catch (error) {
      setError(errorMessage(error, t("communityHome.error.generic")));
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { comment } = await createCommunityHomeComment(
        post.serverId,
        post.id,
        { body },
      );
      setDraft("");
      const teaser = [...post.commentTeaser, comment].slice(-2);
      onPatch({ commentTeaser: teaser, commentCount: post.commentCount + 1 });
      setAll((previous) => (previous ? [...previous, comment] : previous));
    } catch (error) {
      setError(errorMessage(error, t("communityHome.error.generic")));
    } finally {
      setSending(false);
    }
  }

  async function remove(comment: CommunityHomeComment) {
    try {
      await deleteCommunityHomeComment(post.serverId, post.id, comment.id);
      onPatch({
        commentTeaser: post.commentTeaser.filter((c) => c.id !== comment.id),
        commentCount: Math.max(0, post.commentCount - 1),
      });
      setAll((previous) =>
        previous ? previous.filter((c) => c.id !== comment.id) : previous,
      );
    } catch (error) {
      setError(errorMessage(error, t("communityHome.error.generic")));
    }
  }

  return (
    <div className="mt-3 border-t border-ink-4/60 pt-3" data-home-comments>
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              canDelete={canManageServer || comment.author.id === me.id}
              onDelete={() => void remove(comment)}
            />
          ))}
        </ul>
      )}

      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          className="mt-2 text-xs text-paper-muted hover:text-paper"
          onClick={() => void expand()}
          disabled={loading}
          data-home-comments-toggle
        >
          {expanded
            ? t("communityHome.comments.showLess")
            : t("communityHome.comments.viewAll", { count: post.commentCount })}
        </button>
      )}

      {!post.commentsEnabled ? (
        <p className="mt-2 text-xs text-paper-muted" data-home-comments-off>
          {t("communityHome.comments.off")}
        </p>
      ) : (
        <form className="mt-2 flex gap-2" onSubmit={(event) => void submit(event)}>
          <input
            className="min-w-0 flex-1 rounded-lg border border-ink-4 bg-ink px-3 py-1.5 text-sm placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
            value={draft}
            maxLength={COMMUNITY_HOME_COMMENT_MAX}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("communityHome.comments.placeholder")}
            data-home-comment-input
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!draft.trim() || sending}
          >
            {t("communityHome.comments.submit")}
          </Button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

// -------------------------------------------------------------------- card

type PostCardProps = {
  post: CommunityHomePost;
  me: PublicUser;
  locked: boolean;
  canManageServer: boolean;
  vipEnabled: boolean;
  /** Staff list of drafts and scheduled posts, with its own actions. */
  mode?: "feed" | "drafts" | "preview";
  onPatch?: (patch: Partial<CommunityHomePost>) => void;
  onEdit?: (post: CommunityHomePost) => void;
  onDelete?: (post: CommunityHomePost) => void;
  onPublishNow?: (post: CommunityHomePost) => void;
  onUnpublish?: (post: CommunityHomePost) => void;
};

/**
 * One post. Exported for the unit test, which renders it without the feed's
 * network around it.
 *
 * NO "FREE" CHIP. Free is the default state of a post and needs no label;
 * the only tier chip is VIP on a members-only post, and only while the VIP
 * flag is on. Tagging every post "free" is what makes a feed look like a
 * paywall before there is anything to pay for.
 */
export function PostCard({
  post,
  me,
  locked,
  canManageServer,
  vipEnabled,
  mode = "feed",
  onPatch,
  onEdit,
  onDelete,
  onPublishNow,
  onUnpublish,
}: PostCardProps) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [liking, setLiking] = useState(false);
  const summary = lockedPostSummary(post);
  const isPreview = mode === "preview";
  const interactive = mode === "feed" && post.status === "published";

  useEffect(() => {
    if (!confirmDelete) {
      return;
    }
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function like() {
    if (liking || isPreview || !onPatch) {
      return;
    }
    setLiking(true);
    const wasLiked = post.likedByMe;
    onPatch({
      likedByMe: !wasLiked,
      likeCount: Math.max(0, post.likeCount + (wasLiked ? -1 : 1)),
    });
    try {
      const result = await toggleCommunityHomeLike(post.serverId, post.id);
      onPatch({ likedByMe: result.liked, likeCount: result.likeCount });
    } catch {
      onPatch({ likedByMe: wasLiked, likeCount: post.likeCount });
    } finally {
      setLiking(false);
    }
  }

  return (
    <article
      className={cn(
        "rounded-xl border border-ink-4/80 bg-ink-3/40 p-4",
        isPreview && "border-dashed border-signal/40",
      )}
      data-home-post
      data-home-post-visibility={post.visibility}
      data-home-post-status={post.status}
      data-home-post-locked={locked ? "1" : "0"}
    >
      <header className="mb-3 flex items-start gap-3">
        <UserAvatar
          name={post.author.displayName}
          avatarUrl={post.author.avatarUrl}
          className="h-9 w-9"
          fallbackClassName="bg-ink-4 text-xs text-paper"
          rounded="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-semibold">
              {post.author.displayName}
            </span>
            {post.authorBadge && (
              <span className="rounded bg-signal/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal">
                {post.authorBadge === "owner"
                  ? t("communityHome.badge.owner")
                  : t("communityHome.badge.staff")}
              </span>
            )}
            {vipEnabled && post.visibility === "members" && (
              <span
                className="inline-flex items-center gap-1 rounded border border-signal/40 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-signal"
                data-home-vip-chip
              >
                <Lock className="h-2.5 w-2.5" aria-hidden />
                {t("communityHome.visibility.members")}
              </span>
            )}
            {post.status === "draft" && (
              <span className="rounded border border-ink-4 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
                {t("communityHome.status.draft")}
              </span>
            )}
            {post.status === "scheduled" && post.scheduledAt && (
              <span className="inline-flex items-center gap-1 rounded border border-ink-4 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
                <CalendarClock className="h-2.5 w-2.5" aria-hidden />
                {t("communityHome.status.scheduledFor", {
                  when: scheduledLabel(post.scheduledAt, post.scheduleTimezone),
                })}
              </span>
            )}
          </div>
          <p className="text-xs text-paper-muted">
            {isPreview
              ? t("communityHome.compose.previewNow")
              : relativeDayLabel(post.publishedAt ?? post.createdAt, t)}
          </p>
        </div>
        {canManageServer && !isPreview && (
          <div className="flex shrink-0 items-center gap-0.5">
            {mode === "drafts" && post.status === "draft" && onPublishNow && (
              <Button
                type="button"
                size="sm"
                onClick={() => onPublishNow(post)}
                data-home-publish-now
              >
                {t("communityHome.drafts.publishNow")}
              </Button>
            )}
            {mode === "drafts" && post.status === "scheduled" && onUnpublish && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onUnpublish(post)}
                title={t("communityHome.drafts.unscheduleHint")}
              >
                {t("communityHome.drafts.unschedule")}
              </Button>
            )}
            {onEdit && (
              <button
                type="button"
                className="rounded-md p-1.5 text-paper-muted hover:bg-ink-4 hover:text-paper"
                aria-label={t("communityHome.compose.edit")}
                title={t("communityHome.compose.edit")}
                onClick={() => onEdit(post)}
                data-home-edit
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
            {onDelete &&
              (confirmDelete ? (
                <button
                  type="button"
                  className="rounded-md bg-danger/20 px-2 py-1 text-xs font-semibold text-danger"
                  onClick={() => onDelete(post)}
                  data-home-delete-confirm
                >
                  {t("communityHome.compose.deleteConfirm")}
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-md p-1.5 text-paper-muted hover:bg-ink-4 hover:text-danger"
                  aria-label={t("communityHome.compose.delete")}
                  title={t("communityHome.compose.delete")}
                  onClick={() => setConfirmDelete(true)}
                  data-home-delete
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              ))}
          </div>
        )}
      </header>

      {post.title && (
        <h2 className="mb-1 font-display text-base font-semibold leading-snug">
          {post.title}
        </h2>
      )}

      {locked ? (
        <>
          {summary && summary !== post.title?.trim() && (
            <p className="mb-3 text-sm leading-relaxed text-paper-muted">
              {summary}
            </p>
          )}
          <LockedMedia
            title={t("communityHome.lockedTitle")}
            teaser={t("communityHome.lockedBody")}
          />
          <div className="mt-3">
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
          </div>
        </>
      ) : (
        <>
          {post.body && (
            <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {post.body}
            </p>
          )}
          {post.media && <UnlockedMedia media={post.media} />}
        </>
      )}

      {(interactive || isPreview) && !locked && (
        <footer className="mt-3 flex flex-wrap items-center gap-3 text-xs text-paper-muted">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-ink-4 hover:text-paper",
              post.likedByMe && "text-signal",
            )}
            onClick={() => void like()}
            disabled={isPreview || liking}
            aria-pressed={post.likedByMe}
            aria-label={
              post.likedByMe
                ? t("communityHome.likes.unlike")
                : t("communityHome.likes.like")
            }
            data-home-like
          >
            <Heart
              className={cn("h-4 w-4", post.likedByMe && "fill-current")}
              aria-hidden
            />
            <span className="tabular-nums">{post.likeCount}</span>
          </button>
          <span className="inline-flex items-center gap-1.5 px-2 py-1">
            <MessageCircle className="h-4 w-4" aria-hidden />
            <span className="tabular-nums">{post.commentCount}</span>
          </span>
        </footer>
      )}

      {interactive && !locked && onPatch && (
        <CommentsBlock
          post={post}
          me={me}
          canManageServer={canManageServer}
          onPatch={onPatch}
        />
      )}
    </article>
  );
}

// ----------------------------------------------------------------- compose

type ComposeState = {
  editingId: string | null;
  editingStatus: CommunityHomePost["status"] | null;
  title: string;
  body: string;
  teaser: string;
  visibility: CommunityHomeVisibility;
  commentsEnabled: boolean;
  youtubeUrl: string;
  /** A file uploaded and claimed in this session, not yet on a post. */
  upload: UploadedHomeMedia | null;
  /** Local preview of `upload`, an object URL. */
  uploadPreviewUrl: string | null;
  /** Media already on the post being edited, until replaced or removed. */
  existingMedia: CommunityHomeMedia | null;
  clearMedia: boolean;
};

const emptyCompose = (): ComposeState => ({
  editingId: null,
  editingStatus: null,
  title: "",
  body: "",
  teaser: "",
  visibility: "free",
  commentsEnabled: true,
  youtubeUrl: "",
  upload: null,
  uploadPreviewUrl: null,
  existingMedia: null,
  clearMedia: false,
});

function composeFromPost(post: CommunityHomePost): ComposeState {
  return {
    ...emptyCompose(),
    editingId: post.id,
    editingStatus: post.status,
    title: post.title ?? "",
    body: post.body ?? "",
    teaser: post.teaser ?? "",
    visibility: post.visibility,
    commentsEnabled: post.commentsEnabled,
    youtubeUrl: post.media?.kind === "youtube" ? (post.media.youtubeUrl ?? "") : "",
    existingMedia: post.media && post.media.kind !== "youtube" ? post.media : null,
  };
}

/** The post the preview renders, built from what is typed so far. */
function previewPost(state: ComposeState, me: PublicUser, serverId: string, isOwner: boolean): CommunityHomePost {
  let media: CommunityHomeMedia | null = null;
  if (state.youtubeUrl.trim() && parseYoutubeVideoId(state.youtubeUrl)) {
    media = {
      kind: "youtube",
      name: "YouTube",
      contentType: null,
      byteSize: null,
      url: null,
      youtubeUrl: state.youtubeUrl.trim(),
    };
  } else if (state.upload) {
    media = {
      kind: state.upload.kind,
      name: state.upload.name,
      contentType: state.upload.contentType,
      byteSize: state.upload.byteSize,
      url: state.uploadPreviewUrl,
      youtubeUrl: null,
    };
  } else if (state.existingMedia && !state.clearMedia) {
    media = state.existingMedia;
  }
  const now = new Date().toISOString();
  return {
    id: "preview",
    serverId,
    author: me,
    authorBadge: isOwner ? "owner" : "staff",
    title: state.title.trim() || null,
    body: state.body,
    teaser: state.visibility === "members" ? state.teaser.trim() || null : null,
    visibility: state.visibility,
    status: "published",
    commentsEnabled: state.commentsEnabled,
    media,
    locked: false,
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    commentTeaser: [],
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

type ComposeAction = "publish" | "draft" | "schedule" | "save";

function ComposeCard({
  state,
  setState,
  serverId,
  me,
  isOwner,
  vipEnabled,
  mediaEnabled,
  onDone,
  onCancelEdit,
}: {
  state: ComposeState;
  setState: (next: ComposeState | ((prev: ComposeState) => ComposeState)) => void;
  serverId: string;
  me: PublicUser;
  isOwner: boolean;
  vipEnabled: boolean;
  mediaEnabled: boolean;
  onDone: (post: CommunityHomePost, action: ComposeAction) => void;
  onCancelEdit: () => void;
}) {
  const { t } = useTranslation();
  const [showPreview, setShowPreview] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(defaultScheduleValue);
  const [uploading, setUploading] = useState<number | null>(null);
  const [busy, setBusy] = useState<ComposeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const timezone = useMemo(browserTimezone, []);

  const hasMedia =
    Boolean(state.upload) ||
    (Boolean(state.existingMedia) && !state.clearMedia) ||
    Boolean(state.youtubeUrl.trim());
  const canPublish = Boolean(state.title.trim()) && (Boolean(state.body.trim()) || hasMedia);
  const canSaveDraft = Boolean(state.title.trim() || state.body.trim() || hasMedia);

  // Object URLs are revoked when the file leaves the composer.
  useEffect(() => {
    const url = state.uploadPreviewUrl;
    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [state.uploadPreviewUrl]);

  async function pickFile(file: File | null) {
    if (!file) {
      return;
    }
    setError(null);
    if (file.size > COMMUNITY_HOME_MAX_BYTES) {
      setError(
        isHomeVideoFile(file)
          ? t("communityHome.compose.videoOverLimit")
          : t("communityHome.compose.fileOverLimit", {
              limit: formatHomeBytes(COMMUNITY_HOME_MAX_BYTES),
            }),
      );
      return;
    }
    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploading(0);
    try {
      const uploaded = await uploadHomeMedia(serverId, file, {
        signal: controller.signal,
        onProgress: (fraction) => setUploading(fraction),
      });
      const previewUrl =
        uploaded.kind === "file" ? null : URL.createObjectURL(file);
      setState((prev) => ({
        ...prev,
        upload: uploaded,
        uploadPreviewUrl: previewUrl,
        youtubeUrl: "",
        clearMedia: true,
      }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setError(errorMessage(error, t("communityHome.compose.uploadFailed")));
      }
    } finally {
      setUploading(null);
      uploadAbort.current = null;
    }
  }

  function removeMedia() {
    setState((prev) => ({
      ...prev,
      upload: null,
      uploadPreviewUrl: null,
      youtubeUrl: "",
      clearMedia: true,
    }));
  }

  async function run(action: ComposeAction) {
    if (busy) {
      return;
    }
    setError(null);
    if (action !== "draft" && action !== "save" && !canPublish) {
      setError(t("communityHome.compose.needsTitleAndContent"));
      return;
    }
    if (state.youtubeUrl.trim() && !parseYoutubeVideoId(state.youtubeUrl)) {
      setError(t("communityHome.compose.badYoutube"));
      return;
    }
    let scheduledIso: string | null = null;
    if (action === "schedule") {
      const when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        setError(t("communityHome.compose.scheduleInPast"));
        return;
      }
      scheduledIso = when.toISOString();
    }
    setBusy(action);
    try {
      const teaser =
        vipEnabled && state.visibility === "members" ? state.teaser.trim() || null : null;
      const visibility: CommunityHomeVisibility = vipEnabled ? state.visibility : "free";
      let post: CommunityHomePost;
      if (state.editingId) {
        const { post: updated } = await updateCommunityHomePost(
          serverId,
          state.editingId,
          {
            title: state.title.trim() || null,
            body: state.body,
            teaser,
            visibility,
            commentsEnabled: state.commentsEnabled,
            ...(state.upload
              ? { mediaUploadId: state.upload.uploadId }
              : state.youtubeUrl.trim()
                ? { youtubeUrl: state.youtubeUrl.trim() }
                : state.clearMedia
                  ? { clearMedia: true }
                  : {}),
          },
        );
        post = updated;
        if (action === "publish" && post.status !== "published") {
          post = (await publishCommunityHomePost(serverId, post.id)).post;
        } else if (action === "schedule" && scheduledIso) {
          post = (
            await scheduleCommunityHomePost(serverId, post.id, {
              scheduledAt: scheduledIso,
              scheduleTimezone: timezone,
            })
          ).post;
        }
      } else {
        const { post: created } = await createCommunityHomePost(serverId, {
          title: state.title.trim() || null,
          body: state.body,
          teaser,
          visibility,
          commentsEnabled: state.commentsEnabled,
          mediaUploadId: state.upload?.uploadId ?? null,
          youtubeUrl: state.youtubeUrl.trim() || null,
          status:
            action === "publish"
              ? "published"
              : action === "schedule"
                ? "scheduled"
                : "draft",
          scheduledAt: scheduledIso,
          scheduleTimezone: scheduledIso ? timezone : null,
        });
        post = created;
      }
      setShowPreview(false);
      setScheduling(false);
      onDone(post, action);
    } catch (error) {
      setError(errorMessage(error, t("communityHome.error.generic")));
    } finally {
      setBusy(null);
    }
  }

  const editing = Boolean(state.editingId);
  const editingPublished = state.editingStatus === "published";
  const preview = previewPost(state, me, serverId, isOwner);

  return (
    <div className="space-y-3" data-home-compose-panel>
      <form
        className="rounded-xl border border-dashed border-signal/40 bg-ink-3/40 p-4"
        data-home-compose
        onSubmit={(event) => {
          event.preventDefault();
          void run(editingPublished ? "save" : "publish");
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-signal">
            {editing
              ? t("communityHome.compose.editTitle")
              : t("communityHome.compose.title")}
          </p>
          {editing && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-paper-muted hover:text-paper"
              onClick={onCancelEdit}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {t("communityHome.compose.cancel")}
            </button>
          )}
        </div>

        <input
          className="mb-2 w-full rounded-lg border border-ink-4 bg-ink px-3 py-2 text-sm font-semibold placeholder:font-normal placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          value={state.title}
          maxLength={COMMUNITY_HOME_TITLE_MAX}
          onChange={(event) =>
            setState((prev) => ({ ...prev, title: event.target.value }))
          }
          placeholder={t("communityHome.compose.titlePlaceholder")}
          data-home-compose-title
        />
        <textarea
          className="mb-2 w-full resize-y rounded-lg border border-ink-4 bg-ink px-3 py-2 text-sm placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          rows={4}
          value={state.body}
          maxLength={COMMUNITY_HOME_BODY_MAX}
          onChange={(event) =>
            setState((prev) => ({ ...prev, body: event.target.value }))
          }
          placeholder={t("communityHome.compose.placeholder")}
          data-home-compose-body
        />

        {/* Media: one of file (when storage is on) or YouTube. */}
        <div className="mb-2 grid gap-2 sm:grid-cols-2">
          {mediaEnabled ? (
            <label className="block text-xs text-paper-muted">
              <span className="mb-1 block">
                {t("communityHome.compose.fileHint", {
                  limit: formatHomeBytes(COMMUNITY_HOME_MAX_BYTES),
                })}
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-ink-4 bg-ink px-3 py-1.5 text-xs text-paper hover:bg-ink-4">
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {t("communityHome.compose.pickFile")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,application/pdf,.pdf,.mp4,.webm"
                    className="sr-only"
                    disabled={uploading !== null}
                    data-home-compose-file
                    onChange={(event) => {
                      void pickFile(event.target.files?.[0] ?? null);
                      event.target.value = "";
                    }}
                  />
                </span>
                {uploading !== null && (
                  <span className="tabular-nums" data-home-compose-uploading>
                    {Math.round(uploading * 100)}%
                  </span>
                )}
              </span>
            </label>
          ) : (
            <p className="self-end text-xs text-paper-muted">
              {t("communityHome.compose.noStorage")}
            </p>
          )}
          <label className="block text-xs text-paper-muted">
            <span className="mb-1 block">
              {t("communityHome.compose.youtubeHint")}
            </span>
            <input
              className="w-full rounded-lg border border-ink-4 bg-ink px-3 py-1.5 text-sm placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
              value={state.youtubeUrl}
              onChange={(event) =>
                setState((prev) => ({
                  ...prev,
                  youtubeUrl: event.target.value,
                  upload: event.target.value ? null : prev.upload,
                  uploadPreviewUrl: event.target.value ? null : prev.uploadPreviewUrl,
                  clearMedia: event.target.value ? true : prev.clearMedia,
                }))
              }
              placeholder="https://youtu.be/…"
              data-home-compose-youtube
            />
          </label>
        </div>

        {(state.upload || (state.existingMedia && !state.clearMedia)) && (
          <p
            className="mb-2 flex items-center gap-2 text-xs text-paper-muted"
            data-home-compose-media-label
          >
            <span className="truncate">
              {state.upload?.name ?? state.existingMedia?.name}
              {(state.upload?.byteSize ?? state.existingMedia?.byteSize) != null
                ? ` · ${formatHomeBytes((state.upload?.byteSize ?? state.existingMedia?.byteSize)!)}`
                : null}
            </span>
            <button
              type="button"
              className="text-signal hover:underline"
              onClick={removeMedia}
            >
              {t("communityHome.compose.clearMedia")}
            </button>
          </p>
        )}

        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-paper-muted">
          {vipEnabled && (
            <div
              className="inline-flex items-center gap-1 rounded-lg border border-ink-4 bg-ink p-0.5"
              role="radiogroup"
              aria-label={t("communityHome.compose.visibilityLabel")}
              data-home-compose-visibility
            >
              {(["free", "members"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={state.visibility === value}
                  className={cn(
                    "rounded-md px-2 py-1",
                    state.visibility === value
                      ? "bg-ink-4 font-semibold text-paper"
                      : "hover:text-paper",
                  )}
                  onClick={() =>
                    setState((prev) => ({ ...prev, visibility: value }))
                  }
                >
                  {value === "free"
                    ? t("communityHome.visibility.free")
                    : t("communityHome.visibility.members")}
                </button>
              ))}
            </div>
          )}
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.commentsEnabled}
              onChange={(event) =>
                setState((prev) => ({
                  ...prev,
                  commentsEnabled: event.target.checked,
                }))
              }
            />
            {t("communityHome.compose.allowComments")}
          </label>
        </div>

        {vipEnabled && state.visibility === "members" && (
          <input
            className="mb-2 w-full rounded-lg border border-ink-4 bg-ink px-3 py-2 text-sm placeholder:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
            value={state.teaser}
            maxLength={COMMUNITY_HOME_TEASER_MAX}
            onChange={(event) =>
              setState((prev) => ({ ...prev, teaser: event.target.value }))
            }
            placeholder={t("communityHome.compose.teaserPlaceholder")}
            data-home-compose-teaser
          />
        )}

        {error && (
          <p className="mb-2 text-xs text-danger" data-home-compose-error>
            {error}
          </p>
        )}

        {scheduling && (
          <div
            className="mb-2 flex flex-wrap items-end gap-2 rounded-lg border border-ink-4 bg-ink p-3"
            data-home-compose-schedule
          >
            <label className="block text-xs text-paper-muted">
              <span className="mb-1 block">
                {t("communityHome.compose.scheduleWhen", { timezone })}
              </span>
              <input
                type="datetime-local"
                className="rounded-md border border-ink-4 bg-ink-3 px-2 py-1 text-sm"
                value={scheduleAt}
                min={toLocalInputValue(new Date())}
                onChange={(event) => setScheduleAt(event.target.value)}
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={!canPublish || busy !== null}
              onClick={() => void run("schedule")}
              data-home-compose-schedule-submit
            >
              <CalendarClock className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("communityHome.compose.scheduleConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setScheduling(false)}
            >
              {t("communityHome.compose.cancel")}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mr-auto"
            aria-pressed={showPreview}
            onClick={() => setShowPreview((value) => !value)}
            disabled={!canSaveDraft}
            data-home-compose-preview-toggle
          >
            <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {showPreview
              ? t("communityHome.compose.hidePreview")
              : t("communityHome.compose.preview")}
          </Button>
          {!editingPublished && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canSaveDraft || busy !== null}
              onClick={() => void run("draft")}
              data-home-compose-save-draft
            >
              {t("communityHome.compose.saveDraft")}
            </Button>
          )}
          {!editingPublished && !scheduling && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canPublish || busy !== null}
              onClick={() => setScheduling(true)}
              data-home-compose-schedule-open
            >
              <CalendarClock className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("communityHome.compose.schedule")}
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={
              (editingPublished ? !canSaveDraft : !canPublish) || busy !== null
            }
            data-home-compose-submit
          >
            <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {editingPublished
              ? t("communityHome.compose.save")
              : t("communityHome.compose.submit")}
          </Button>
        </div>
      </form>

      {showPreview && canSaveDraft && (
        <div data-home-compose-preview>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
            {t("communityHome.compose.previewLabel")}
          </p>
          <PostCard
            post={preview}
            me={me}
            locked={false}
            canManageServer={false}
            vipEnabled={vipEnabled}
            mode="preview"
          />
          {vipEnabled && preview.visibility === "members" && (
            <div className="mt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
                {t("communityHome.compose.previewLockedLabel")}
              </p>
              <PostCard
                post={{ ...preview, body: null, media: null, locked: true }}
                me={me}
                locked
                canManageServer={false}
                vipEnabled={vipEnabled}
                mode="preview"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- feed

export function CommunityHomeFeed({
  serverId,
  serverName,
  me,
  canManageServer,
  isOwner,
  isVip,
  vipEnabled,
  mediaEnabled,
  introDismissed,
  onDismissIntro,
  onOpenNav,
  refreshSignal = 0,
}: Props) {
  const { t } = useTranslation();
  const [posts, setPosts] = useState<CommunityHomePost[] | null>(null);
  const [drafts, setDrafts] = useState<CommunityHomePost[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [staffTab, setStaffTab] = useState<StaffTab>("feed");
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [inspector, setInspector] = useState<CommunityHomeViewerMode>(() =>
    loadCommunityHomeViewerMode(),
  );
  const [notice, setNotice] = useState<MessageKey | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setLoadError(null);
      }
      try {
        const [feed, staff] = await Promise.all([
          fetchCommunityHomePosts(serverId),
          canManageServer
            ? fetchCommunityHomeDrafts(serverId)
            : Promise.resolve({ posts: [] }),
        ]);
        setPosts(feed.posts);
        setDrafts(staff.posts);
      } catch (error) {
        if (!silent) {
          setLoadError(errorMessage(error, t("communityHome.error.load")));
        }
      }
    },
    [serverId, canManageServer, t],
  );

  useEffect(() => {
    setPosts(null);
    setDrafts([]);
    setCompose(emptyCompose());
    setStaffTab("feed");
    setActionError(null);
    void load(false);
  }, [load]);

  useEffect(() => {
    if (refreshSignal > 0) {
      void load(true);
    }
  }, [refreshSignal, load]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The inspector exists only for staff on a VIP-enabled instance; anybody
  // else always sees `post.locked` as the API computed it for them.
  const inspectorActive = vipEnabled && canManageServer;
  const inspectorMode = inspectorActive ? inspector : "auto";

  function patchPost(id: string, patch: Partial<CommunityHomePost>) {
    setPosts((previous) =>
      previous
        ? previous.map((post) => (post.id === id ? { ...post, ...patch } : post))
        : previous,
    );
  }

  async function withAction<T>(run: () => Promise<T>): Promise<T | null> {
    setActionError(null);
    try {
      return await run();
    } catch (error) {
      setActionError(errorMessage(error, t("communityHome.error.generic")));
      return null;
    }
  }

  function beginEdit(post: CommunityHomePost) {
    setCompose(composeFromPost(post));
    setStaffTab("compose");
  }

  async function removePost(post: CommunityHomePost) {
    const ok = await withAction(() =>
      deleteCommunityHomePost(serverId, post.id),
    );
    if (ok) {
      setPosts((previous) =>
        previous ? previous.filter((p) => p.id !== post.id) : previous,
      );
      setDrafts((previous) => previous.filter((p) => p.id !== post.id));
      setNotice("communityHome.notice.deleted");
    }
  }

  async function publishNow(post: CommunityHomePost) {
    const result = await withAction(() =>
      publishCommunityHomePost(serverId, post.id),
    );
    if (result) {
      setDrafts((previous) => previous.filter((p) => p.id !== post.id));
      setPosts((previous) => [result.post, ...(previous ?? [])]);
      setNotice("communityHome.notice.published");
      setStaffTab("feed");
    }
  }

  async function unschedule(post: CommunityHomePost) {
    const result = await withAction(() =>
      unpublishCommunityHomePost(serverId, post.id),
    );
    if (result) {
      setDrafts((previous) =>
        previous.map((p) => (p.id === post.id ? result.post : p)),
      );
      setNotice("communityHome.notice.unscheduled");
    }
  }

  function onComposed(post: CommunityHomePost, action: ComposeAction) {
    setCompose(emptyCompose());
    // Reconcile both lists from the returned post rather than guessing.
    setPosts((previous) => {
      const rest = (previous ?? []).filter((p) => p.id !== post.id);
      return post.status === "published"
        ? [post, ...rest].sort(
            (a, b) =>
              new Date(b.publishedAt ?? b.createdAt).getTime() -
              new Date(a.publishedAt ?? a.createdAt).getTime(),
          )
        : rest;
    });
    setDrafts((previous) => {
      const rest = previous.filter((p) => p.id !== post.id);
      return post.status === "published" ? rest : [post, ...rest];
    });
    if (action === "publish" || post.status === "published") {
      setNotice("communityHome.notice.published");
      setStaffTab("feed");
    } else if (action === "schedule") {
      setNotice("communityHome.notice.scheduled");
      setStaffTab("drafts");
    } else {
      setNotice("communityHome.notice.draftSaved");
      setStaffTab("drafts");
    }
  }

  const feedEmpty = posts !== null && posts.length === 0;
  const showIntro = !introDismissed && !canManageServer;

  const tabs: { id: StaffTab; label: MessageKey; count?: number }[] = [
    { id: "feed", label: "communityHome.tabs.feed" },
    { id: "compose", label: "communityHome.tabs.compose" },
    { id: "drafts", label: "communityHome.tabs.drafts", count: drafts.length },
  ];
  const staffTabs = (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-ink-4 bg-ink-3 p-0.5 text-[11px]"
      role="tablist"
      data-home-staff-tabs
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={staffTab === tab.id}
          className={cn(
            "rounded-md px-2 py-1 text-paper-muted transition-colors",
            staffTab === tab.id && "bg-ink-4 font-semibold text-paper",
          )}
          onClick={() => setStaffTab(tab.id)}
          data-home-staff-tab={tab.id}
        >
          {t(tab.label)}
          {tab.count ? (
            <span className="ml-1 tabular-nums opacity-70">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-community-home-feed>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-4/60 px-4">
        {onOpenNav && (
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-ink-3 md:hidden"
            aria-label={t("empty.openNav")}
            onClick={onOpenNav}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Archive aria-hidden="true" className="h-5 w-5 shrink-0 text-paper-muted" />
        <div className="min-w-0">
          <h1 className="truncate font-display text-base font-bold leading-tight">
            {t("communityHome.title")}
          </h1>
          <p className="truncate text-[11px] text-paper-muted">
            {t("communityHome.subtitle", { name: serverName })}
          </p>
        </div>
        {/* Desktop: tabs sit in the header. A phone puts them on their own
            row below, otherwise three tabs squeeze the title to one letter. */}
        {canManageServer && (
          <div className="ml-auto hidden shrink-0 sm:block">{staffTabs}</div>
        )}
      </header>
      {canManageServer && (
        <div className="flex shrink-0 justify-end border-b border-ink-4/60 px-3 py-2 sm:hidden">
          {staffTabs}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {notice && (
            <p
              className="animate-rise rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success"
              role="status"
              data-home-notice
            >
              {t(notice)}
            </p>
          )}
          {actionError && (
            <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
              {actionError}
            </p>
          )}

          {canManageServer && staffTab === "compose" && (
            <>
              {feedEmpty && drafts.length === 0 && !compose.editingId && (
                <CommunityHomeStaffGuide variant="compose" />
              )}
              <ComposeCard
                state={compose}
                setState={setCompose}
                serverId={serverId}
                me={me}
                isOwner={isOwner}
                vipEnabled={vipEnabled}
                mediaEnabled={mediaEnabled}
                onDone={onComposed}
                onCancelEdit={() => {
                  setCompose(emptyCompose());
                  setStaffTab("feed");
                }}
              />
            </>
          )}

          {canManageServer && staffTab === "drafts" && (
            <>
              {drafts.length === 0 ? (
                <p className="rounded-xl border border-dashed border-ink-4 px-4 py-6 text-center text-sm text-paper-muted">
                  {t("communityHome.drafts.empty")}
                </p>
              ) : (
                drafts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    me={me}
                    locked={false}
                    canManageServer
                    vipEnabled={vipEnabled}
                    mode="drafts"
                    onEdit={beginEdit}
                    onDelete={(target) => void removePost(target)}
                    onPublishNow={(target) => void publishNow(target)}
                    onUnpublish={(target) => void unschedule(target)}
                  />
                ))
              )}
            </>
          )}

          {(!canManageServer || staffTab === "feed") && (
            <>
              {showIntro && (
                <CommunityHomeIntroCard
                  serverName={serverName}
                  vipEnabled={vipEnabled}
                  onDismiss={onDismissIntro}
                />
              )}

              {inspectorActive && posts && posts.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-2 self-end text-[11px] text-paper-muted"
                  data-home-viewer-tabs
                >
                  <span>{t("communityHome.viewer.label")}</span>
                  <div className="inline-flex items-center gap-0.5 rounded-lg border border-ink-4 bg-ink-3 p-0.5">
                    {(
                      [
                        ["auto", "communityHome.viewer.auto"],
                        ["members", "communityHome.viewer.members"],
                      ] as const
                    ).map(([mode, labelKey]) => (
                      <button
                        key={mode}
                        type="button"
                        className={cn(
                          "rounded-md px-2 py-1",
                          inspector === mode && "bg-ink-4 font-semibold text-paper",
                        )}
                        onClick={() => {
                          setInspector(mode);
                          saveCommunityHomeViewerMode(mode);
                        }}
                        data-home-viewer-tab={mode}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {loadError && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
                  <span className="min-w-0 flex-1">{loadError}</span>
                  <Button size="sm" variant="secondary" onClick={() => void load(false)}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    {t("communityHome.error.retry")}
                  </Button>
                </div>
              )}

              {posts === null && !loadError && (
                <div className="space-y-4" aria-busy="true">
                  {[0, 1].map((n) => (
                    <div
                      key={n}
                      className="h-40 animate-pulse rounded-xl border border-ink-4/60 bg-ink-3/30"
                    />
                  ))}
                </div>
              )}

              {feedEmpty &&
                (canManageServer ? (
                  <CommunityHomeStaffGuide
                    variant="empty"
                    onCompose={() => setStaffTab("compose")}
                  />
                ) : (
                  <p
                    className="rounded-xl border border-dashed border-ink-4 px-4 py-8 text-center text-sm text-paper-muted"
                    data-home-empty
                  >
                    {t("communityHome.empty.member", { name: serverName })}
                  </p>
                ))}

              {posts?.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  me={me}
                  locked={isPostLockedForViewer(
                    post,
                    canManageServer,
                    inspectorMode,
                  )}
                  canManageServer={canManageServer}
                  vipEnabled={vipEnabled}
                  onPatch={(patch) => patchPost(post.id, patch)}
                  onEdit={canManageServer ? beginEdit : undefined}
                  onDelete={
                    canManageServer ? (target) => void removePost(target) : undefined
                  }
                />
              ))}

              {/* A member who is VIP sees everything; say so once, quietly. */}
              {vipEnabled && isVip && !canManageServer && posts && posts.length > 0 && (
                <p className="text-center text-[11px] text-paper-muted">
                  {t("communityHome.vipMemberNote")}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
