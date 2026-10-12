import {
  FORUM_MAX_TAGS_PER_POST,
  FORUM_TITLE_MAX,
  type ForumPostSummary,
  type ForumPostViewer,
  type ForumTag,
} from "@pqp/shared";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  CornerDownLeft,
  Lightbulb,
  ShieldAlert,
  ShieldCheck,
  Tag,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  MessageComposer,
  type EmbeddedComposerState,
} from "@/components/chat/message-composer";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import { isApplePlatform } from "@/lib/composer-formatting";
import { clearDraft } from "@/lib/composer-drafts";
import {
  createForumPost,
  fetchSimilarForumPosts,
  readForumPublishError,
  type ForumPublishError,
} from "@/lib/forum-api";
import type { ForumTagsStatus } from "@/lib/forum-api";
import { foldForSearch } from "@/lib/forum-list";
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "@/lib/forum-prefs";
import { useForumTagLabel } from "@/lib/forum-tag-icons";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import type { DroppedItems } from "@/lib/file-drop";
import { createSendNonce } from "@/lib/outbox";
import { cn } from "@/lib/utils";

/**
 * "Novo post" (UX §2.5): title first, the posts that look like it while the
 * title is typed, the body (the chat's own composer, minting uploads against
 * the FORUM id because the post has no id yet; the server re-homes them),
 * then tags.
 *
 * Closing never asks: the title and tags are a draft in `forum-prefs.ts`, the
 * body is the composer's own draft keyed by the forum, and reopening puts all
 * three back. Publishing is not optimistic: the server is the authority on
 * slow mode, AutoMod and the post bucket, and a post that appears and then
 * vanishes is worse than a 300 ms wait.
 */

const SIMILAR_MIN_CHARS = 4;

/**
 * The attempt whose outcome is unknown (the request failed without an
 * answer), per forum, for the rest of the session: its exact payload and the
 * nonce it went out with. Retrying the SAME payload reuses the nonce, so a
 * post the server did create comes back instead of being made twice, even
 * after the dialog was closed and reopened. A changed payload is a different
 * post and gets a new nonce. Cleared once the server answers either way.
 */
const pendingAttempts = new Map<string, { signature: string; nonce: string }>();

function attemptNonce(forumId: string, signature: string): string {
  const pending = pendingAttempts.get(forumId);
  if (pending && pending.signature === signature) {
    return pending.nonce;
  }
  const nonce = createSendNonce();
  pendingAttempts.set(forumId, { signature, nonce });
  return nonce;
}
const SIMILAR_DEBOUNCE_MS = 300;
const DRAFT_DEBOUNCE_MS = 300;

interface ForumComposerDialogProps {
  open: boolean;
  forumId: string;
  forumName: string;
  serverId: string | null;
  tags: readonly ForumTag[];
  /**
   * Whether `tags` is an answered read. A read that failed is not "no tags":
   * the composer says so and offers another try. Omitted, it is ready.
   */
  tagsStatus?: ForumTagsStatus;
  onRetryTags?: () => void;
  /** MANAGE_CHANNELS: the empty-tags notice links to the Tags settings. */
  canManageTags?: boolean;
  onOpenTagSettings?: () => void;
  requireTag: boolean;
  /** Staff see and may apply the moderated ("Só staff") tags. */
  isStaff: boolean;
  /** Prefill from the search box's "Postar ..." when the draft has no title. */
  initialTitle?: string | null;
  /** Files dropped on the forum, staged into the body as attachments. */
  droppedItems?: DroppedItems | null;
  onDroppedItemsConsumed?: () => void;
  mentionCandidates: MentionCandidate[];
  /** Slow mode on the forum, for the live countdown after a refusal. */
  onClose: () => void;
  onPublished: (post: ForumPostSummary, viewer: ForumPostViewer) => void;
  /** A similar post was chosen: the draft stays, the post opens. */
  onOpenPost: (postId: string) => void;
  /**
   * The server refused the post for a rule the pane may hold stale (the
   * forum paused, a tag now required): the pane reads that rule again, so
   * the screen catches up with the refusal.
   */
  onRefused?: (kind: ForumPublishError["kind"]) => void;
}

/**
 * `title` cut into runs, the words the query also has marked `hit`. Only the
 * word itself: the punctuation around it ("Deck:", "(WHEA)") stays plain, or
 * the underline ran on under the colon (forum QA P7).
 */
export function highlightTitleParts(
  title: string,
  query: string,
): { text: string; hit: boolean }[] {
  const words = foldForSearch(query)
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length >= 2);
  const out: { text: string; hit: boolean }[] = [];
  const push = (text: string, hit: boolean) => {
    if (!text) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.hit === hit && !hit) {
      last.text += text;
    } else {
      out.push({ text, hit });
    }
  };
  for (const part of title.split(/(\s+)/)) {
    const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(part);
    const [, before = "", core = "", after = ""] = match ?? [];
    const folded = foldForSearch(core).replace(/[^\p{L}\p{N}]/gu, "");
    const hit =
      folded.length > 0 && words.some((word) => folded === word || folded.startsWith(word));
    push(before, false);
    push(core, hit);
    push(after, false);
  }
  return out;
}

/** Underline the words of `title` that the query also has. */
function HighlightedTitle({ title, query }: { title: string; query: string }) {
  return (
    <>
      {highlightTitleParts(title, query).map((part, index) =>
        part.hit ? (
          <span
            key={index}
            className="font-semibold text-text underline decoration-accent decoration-2 underline-offset-[3px]"
          >
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs text-danger">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

export function ForumComposerDialog({
  open,
  forumId,
  forumName,
  serverId,
  tags,
  tagsStatus = "ready",
  onRetryTags,
  canManageTags = false,
  onOpenTagSettings,
  requireTag,
  isStaff,
  initialTitle = null,
  droppedItems = null,
  onDroppedItemsConsumed,
  mentionCandidates,
  onClose,
  onPublished,
  onOpenPost,
  onRefused,
}: ForumComposerDialogProps) {
  const { t } = useTranslation();
  const tagLabel = useForumTagLabel();
  const titleId = useId();
  const titleErrorId = useId();
  const tagsLabelId = useId();
  const tagsErrorId = useId();
  const similarId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const restored = useMemo(
    // Read once per opening.
    () => (open ? readComposerDraft(forumId) : null),
    [open, forumId],
  );
  const [title, setTitle] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [draftNote, setDraftNote] = useState<"saved" | "restored" | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publishError, setPublishError] = useState<ForumPublishError | null>(null);
  const [heldUntil, setHeldUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<EmbeddedComposerState>({
    body: "",
    attachments: [],
    uploading: false,
  });
  const [bodyState, setBodyState] = useState<EmbeddedComposerState>(bodyRef.current);

  // Seed from the draft (or the search box) each time the dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    const draftTitle = restored?.title ?? "";
    setTitle(draftTitle || (initialTitle ?? "").slice(0, FORUM_TITLE_MAX));
    setTagIds(
      (restored?.tagIds ?? []).filter((tagId) => tags.some((tag) => tag.id === tagId)),
    );
    setDraftNote(restored ? "restored" : null);
    setShowErrors(false);
    setPublishError(null);
    setBusy(false);
    // Tags arriving later must not reseed what the person already changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, forumId]);

  // The title and tags are the draft; the body is the composer's own.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (!open) {
      firstWrite.current = true;
      return;
    }
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    // Seeding from a restored draft is not a change: the note keeps saying
    // "Rascunho recuperado" until the person actually edits something.
    if (
      restored &&
      title === restored.title &&
      tagIds.length === restored.tagIds.length &&
      tagIds.every((tagId) => restored.tagIds.includes(tagId))
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      writeComposerDraft(forumId, { title, tagIds });
      // A blank title and no tags is no draft at all (`writeComposerDraft`
      // stores nothing), so the footer does not claim one was saved.
      setDraftNote(title.trim() || tagIds.length > 0 ? "saved" : null);
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, forumId, title, tagIds, restored]);

  // The body is the embedded composer's own draft, and the composer writes it
  // one last time from its unmount cleanup. After a publish or a discard that
  // write must not win, so the clear waits for the commit that closed the
  // dialog: passive unmount cleanups (the composer's) always run before this
  // effect. A timer is not enough: when the close lands in a deferred render
  // (opening the new post navigates), the timer fires first and the stale body
  // comes back as the next post's draft.
  const clearBodyOnClose = useRef(false);
  useEffect(() => {
    if (open || !clearBodyOnClose.current) {
      return;
    }
    clearBodyOnClose.current = false;
    clearDraft(forumId);
  }, [open, forumId]);
  // The other way out: the dialog itself unmounts (the pane goes away) before
  // `open` turns false. React tears a deleted tree down parent first, so this
  // cleanup runs BEFORE the composer's last write; the clear is queued behind
  // it. With the dialog gone nothing can race it any more.
  useEffect(
    () => () => {
      if (clearBodyOnClose.current) {
        clearBodyOnClose.current = false;
        window.setTimeout(() => clearDraft(forumId), 0);
      }
    },
    [forumId],
  );

  // --------------------------------------------------------- similar posts
  const [similar, setSimilar] = useState<ForumPostSummary[]>([]);
  const [similarFor, setSimilarFor] = useState("");
  const [similarLoading, setSimilarLoading] = useState(false);
  const [activeSimilar, setActiveSimilar] = useState(-1);
  useEffect(() => {
    if (!open) {
      return;
    }
    const query = title.trim();
    if (query.length < SIMILAR_MIN_CHARS) {
      setSimilar([]);
      setSimilarFor("");
      setActiveSimilar(-1);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSimilarLoading(true);
      fetchSimilarForumPosts(forumId, query, controller.signal)
        .then(({ posts }) => {
          setSimilar(posts);
          setSimilarFor(query);
          setActiveSimilar((index) => Math.min(index, posts.length - 1));
        })
        .catch(() => {
          // Never in the way: an error is the box disappearing silently.
          if (!controller.signal.aborted) {
            setSimilar([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSimilarLoading(false);
          }
        });
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, forumId, title]);

  // -------------------------------------------------------------- holding
  useEffect(() => {
    if (heldUntil <= Date.now()) {
      return;
    }
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= heldUntil) {
        window.clearInterval(id);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [heldUntil]);
  const heldSeconds = Math.max(0, Math.ceil((heldUntil - now) / 1000));

  // Staff deleted a tag while it was picked here (the list is live): it
  // leaves the pick, or Publicar would send a tag that no longer exists.
  useEffect(() => {
    setTagIds((current) => {
      const kept = current.filter((tagId) => tags.some((tag) => tag.id === tagId));
      return kept.length === current.length ? current : kept;
    });
  }, [tags]);

  // ----------------------------------------------------------- validation
  const visibleTags = tags.filter((tag) => isStaff || !tag.moderated);
  const trimmedTitle = title.replace(/\s+/g, " ").trim();
  const titleMissing = trimmedTitle.length === 0;
  // A rule nobody can meet is not a rule: with no tag this person could pick
  // (none exist, or only staff-only ones, or the read failed) Publicar stays
  // open and the server, which applies the same rule, decides.
  const tagMissing = requireTag && visibleTags.length > 0 && tagIds.length === 0;
  const tagsNotice =
    visibleTags.length > 0
      ? null
      : tagsStatus === "error"
        ? ("error" as const)
        : requireTag && tagsStatus === "ready"
          ? ("none" as const)
          : null;
  const bodyMissing =
    bodyState.body.length === 0 && bodyState.attachments.length === 0;
  const blocked =
    titleMissing || tagMissing || bodyMissing || bodyState.uploading || heldSeconds > 0;

  const publish = useCallback(async () => {
    if (busy) {
      return;
    }
    setShowErrors(true);
    const current = bodyRef.current;
    if (
      titleMissing ||
      tagMissing ||
      (current.body.length === 0 && current.attachments.length === 0) ||
      current.uploading ||
      heldSeconds > 0
    ) {
      // Focus goes where the first reason is, so the next keystroke fixes
      // it instead of landing on Publicar again (forum QA P4).
      if (titleMissing) {
        titleRef.current?.focus();
      } else if (current.body.length === 0 && current.attachments.length === 0) {
        formRef.current?.querySelector<HTMLElement>("[data-forum-composer-body] textarea")?.focus();
      } else if (tagMissing) {
        tagRefs.current.find(Boolean)?.focus();
      }
      return;
    }
    setBusy(true);
    setPublishError(null);
    const payload = {
      title: trimmedTitle,
      body: current.body,
      tagIds,
      attachmentIds: current.attachments.map((one) => one.attachmentId),
    };
    const nonce = attemptNonce(forumId, JSON.stringify(payload));
    try {
      const { post, viewer } = await createForumPost(forumId, { ...payload, nonce });
      pendingAttempts.delete(forumId);
      clearComposerDraft(forumId);
      clearBodyOnClose.current = true;
      clearDraft(forumId);
      onPublished(post, viewer);
    } catch (error) {
      const reason = readForumPublishError(error);
      setPublishError(reason);
      if (reason.kind === "paused" || reason.kind === "tag-required") {
        onRefused?.(reason.kind);
      }
      if (reason.kind === "slow-mode" && reason.retryAfterMs > 0) {
        setHeldUntil(Date.now() + reason.retryAfterMs);
        setNow(Date.now());
      }
      // A refusal is an answer: nothing was created, the next attempt is new.
      // Only an unanswered failure keeps its nonce for a retry of the same
      // payload (`attemptNonce`).
      if (reason.kind !== "failed") {
        pendingAttempts.delete(forumId);
      }
      setBusy(false);
    }
  }, [
    busy,
    titleMissing,
    tagMissing,
    heldSeconds,
    forumId,
    trimmedTitle,
    tagIds,
    onPublished,
    onRefused,
  ]);
  const publishRef = useRef(publish);
  publishRef.current = publish;

  const onBodyChange = useCallback((state: EmbeddedComposerState) => {
    bodyRef.current = state;
    setBodyState(state);
  }, []);
  const embedded = useMemo(
    () => ({
      onChange: onBodyChange,
      onSubmit: () => void publishRef.current(),
      minHeight: 112,
      trailing: (
        <span className="pr-1.5 text-[11px] text-text-tertiary">
          {t("forum.composer.markdown")}
        </span>
      ),
    }),
    [onBodyChange, t],
  );

  /** Closing never asks: whatever is typed is the draft, written now. */
  function close() {
    if (!busy) {
      writeComposerDraft(forumId, { title, tagIds });
    }
    onClose();
  }

  function openSimilar(postId: string) {
    writeComposerDraft(forumId, { title, tagIds });
    onOpenPost(postId);
  }

  function discard() {
    clearComposerDraft(forumId);
    // The body draft lives with the composer; the next open starts empty.
    setTitle("");
    setTagIds([]);
    setDraftNote(null);
    clearBodyOnClose.current = true;
    clearDraft(forumId);
    onClose();
  }

  function toggleTag(tagId: string) {
    setTagIds((current) => {
      if (current.includes(tagId)) {
        return current.filter((one) => one !== tagId);
      }
      if (current.length >= FORUM_MAX_TAGS_PER_POST) {
        return current;
      }
      return [...current, tagId];
    });
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void publish();
      return;
    }
    if (similar.length === 0) {
      if (event.key === "Enter") {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSimilar((index) => Math.min(similar.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSimilar((index) => Math.max(-1, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = similar[activeSimilar];
      if (chosen && !similarLoading) {
        openSimilar(chosen.id);
      }
    } else if (event.key === "Escape" && activeSimilar >= 0) {
      event.preventDefault();
      event.stopPropagation();
      setActiveSimilar(-1);
    }
  }

  // Tags: one tab stop, arrows between chips, Space toggles.
  const tagRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tagFocus, setTagFocus] = useState(0);
  function onTagKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = visibleTags.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    if (next >= 0) {
      event.preventDefault();
      setTagFocus(next);
      tagRefs.current[next]?.focus();
    }
  }

  const modKey = isApplePlatform() ? "⌘" : "Ctrl";
  const showSimilar = similar.length > 0 && trimmedTitle.length >= SIMILAR_MIN_CHARS;
  const atMax = tagIds.length >= FORUM_MAX_TAGS_PER_POST;

  const errorLine = (() => {
    if (!publishError) {
      return null;
    }
    switch (publishError.kind) {
      case "slow-mode":
        return {
          icon: <Clock className="h-4 w-4 shrink-0" aria-hidden />,
          text: t("forum.composer.slowMode", { seconds: Math.max(heldSeconds, 1) }),
          tone: "warning" as const,
        };
      case "rate-limited":
        return {
          icon: <Clock className="h-4 w-4 shrink-0" aria-hidden />,
          text: t("forum.composer.rateLimited", {
            minutes: Math.max(1, Math.ceil((publishError.retryAfterMs ?? 60_000) / 60_000)),
          }),
          tone: "warning" as const,
        };
      case "automod":
        return {
          icon: <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />,
          text: [
            publishError.field === "title"
              ? t("forum.composer.automodTitle")
              : publishError.field === "body"
                ? t("forum.composer.automodBody")
                : t("forum.composer.automodPost"),
            publishError.message,
          ]
            .filter(Boolean)
            .join(" "),
          tone: "danger" as const,
        };
      case "tag-required":
        return null;
      case "paused":
        return {
          icon: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
          text: t("forum.paused"),
          tone: "warning" as const,
        };
      case "cannot-send":
        return {
          icon: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
          text: t("forum.composer.cannotSend"),
          tone: "danger" as const,
        };
      default:
        return {
          icon: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
          text: t("forum.composer.failed"),
          tone: "danger" as const,
        };
    }
  })();

  const tagRequiredShown =
    (showErrors && tagMissing) || publishError?.kind === "tag-required";

  const footer = (
    <div className="flex w-full items-center gap-2">
      <span
        className={cn(
          "mr-auto inline-flex min-w-0 items-center gap-1 text-xs text-text-tertiary transition-opacity duration-[var(--duration-base)]",
          draftNote ? "opacity-100" : "opacity-0",
        )}
        aria-live="polite"
      >
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {draftNote === "restored"
            ? t("forum.composer.draftRestored")
            : t("forum.composer.draftSaved")}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        onClick={discard}
        disabled={busy}
        className="max-sm:h-11"
      >
        {t("forum.composer.discard")}
      </Button>
      <Button
        type="button"
        onClick={() => void publish()}
        disabled={busy || heldSeconds > 0}
        // A phone draws Publicar in the sheet's title band instead.
        data-publish-placement="footer"
        aria-disabled={blocked || undefined}
        aria-describedby={showErrors && titleMissing ? titleErrorId : undefined}
        className={cn(
          "gap-2 tabular-nums max-sm:hidden",
          blocked && !busy && "opacity-60",
        )}
      >
        {busy ? (
          t("forum.composer.publishing")
        ) : heldSeconds > 0 ? (
          <>
            <Clock className="h-4 w-4" aria-hidden />
            {`${heldSeconds}s`}
          </>
        ) : (
          t("forum.composer.publish")
        )}
        {!busy && heldSeconds === 0 && (
          <kbd className="hidden items-center gap-0.5 rounded-[var(--radius-tick)] bg-on-accent/15 px-1 py-px font-sans text-[10px] font-semibold sm:inline-flex">
            {modKey}
            <CornerDownLeft className="h-2.5 w-2.5" aria-hidden />
          </kbd>
        )}
      </Button>
    </div>
  );

  // Phone: Publicar in the title band, top right, where the mock puts it and
  // where the keyboard never covers it.
  const headerPublish = (
    <Button
      type="button"
      size="sm"
      onClick={() => void publish()}
      disabled={busy || heldSeconds > 0}
      data-publish-placement="header"
      className={cn(
        "h-11 gap-1.5 px-4 tabular-nums sm:hidden",
        blocked && !busy && "opacity-60",
      )}
    >
      {busy ? (
        t("forum.composer.publishing")
      ) : heldSeconds > 0 ? (
        <>
          <Clock className="h-4 w-4" aria-hidden />
          {`${heldSeconds}s`}
        </>
      ) : (
        t("forum.composer.publish")
      )}
    </Button>
  );

  return (
    <Dialog
      open={open}
      eyebrow={forumName}
      title={t("forum.composer.heading")}
      size="lg"
      onClose={close}
      footer={footer}
      headerAction={headerPublish}
      // A phone writes a post on the whole screen, X on the left and
      // Publicar on the right, like the apps (UX #30, forum QA P16).
      phoneFullScreen
    >
      <div
        className="flex flex-col gap-5 px-5 py-4"
        ref={formRef}
        data-forum-composer=""
        // Mod+Enter publishes from anywhere in the form (a tag chip, the
        // similar list); the title and the body handle it themselves first.
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.defaultPrevented
          ) {
            event.preventDefault();
            void publish();
          }
        }}
      >
        {/* ------------------------------------------------------- title */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor={titleId} className="text-xs font-semibold text-text-secondary">
              {t("forum.composer.title")}
            </label>
            <span
              className={cn(
                "text-[11px] tabular-nums",
                title.length >= FORUM_TITLE_MAX ? "text-warning" : "text-text-tertiary",
              )}
            >
              {t("forum.composer.titleCount", {
                count: title.length,
                max: FORUM_TITLE_MAX,
              })}
            </span>
          </div>
          <Input
            id={titleId}
            ref={titleRef}
            autoFocus
            // Fixed while a publish is in flight: what is retried must be
            // what was sent.
            readOnly={busy}
            value={title}
            maxLength={FORUM_TITLE_MAX}
            placeholder={t("forum.composer.titlePlaceholder")}
            onChange={(event) => {
              setTitle(event.target.value.replace(/\n/g, " "));
              if (publishError?.kind === "automod") {
                setPublishError(null);
              }
            }}
            onKeyDown={onTitleKeyDown}
            role="combobox"
            aria-expanded={showSimilar}
            aria-controls={showSimilar ? similarId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              showSimilar && activeSimilar >= 0
                ? `${similarId}-${activeSimilar}`
                : undefined
            }
            aria-invalid={showErrors && titleMissing ? true : undefined}
            aria-describedby={showErrors && titleMissing ? titleErrorId : undefined}
            className={cn(
              "text-[15px]",
              showErrors && titleMissing && "border-danger",
            )}
          />
          {showErrors && titleMissing && (
            <FieldError id={titleErrorId}>{t("forum.composer.titleRequired")}</FieldError>
          )}

          {/* -------------------------------------------------- similar */}
          {showSimilar && (
            <div
              className={cn(
                "mt-2 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1 animate-door-reveal transition-opacity duration-[var(--duration-fast)]",
                similarLoading && "opacity-60",
              )}
            >
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary">
                <Lightbulb className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-semibold text-text max-sm:hidden">
                    {t("forum.composer.similar.title")}
                  </span>
                  <span className="font-semibold text-text sm:hidden">
                    {t("forum.composer.similar.titleShort")}
                  </span>{" "}
                  <span className="max-sm:hidden">{t("forum.composer.similar.body")}</span>
                </span>
              </p>
              <ul
                id={similarId}
                role="listbox"
                aria-label={t("forum.composer.similar.sr", { count: similar.length })}
                className="border-t border-border"
              >
                {similar.map((one, index) => (
                  <li
                    key={one.id}
                    id={`${similarId}-${index}`}
                    role="option"
                    aria-selected={index === activeSimilar}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!similarLoading) {
                        openSimilar(one.id);
                      }
                    }}
                    onMouseEnter={() => setActiveSimilar(index)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 py-2 text-[13px] text-text-secondary transition-colors duration-[var(--duration-fast)] last:border-b-0",
                      index === activeSimilar ? "bg-surface-2" : "hover:bg-surface-2",
                    )}
                  >
                    {one.resolvedAt ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label={t("forum.badge.resolved")} />
                    ) : (
                      <Circle className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <HighlightedTitle title={one.title} query={similarFor} />
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">
                      {one.resolvedAt
                        ? `${t("forum.badge.resolved")} · ${t("forum.replies", { count: one.replyCount })}`
                        : t("forum.replies", { count: one.replyCount })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-3 py-2 text-xs text-text-tertiary">
                {t("forum.composer.similar.footer")}
              </p>
            </div>
          )}
        </div>

        {/* -------------------------------------------------------- body */}
        <div>
          <p className="mb-1.5 text-xs font-semibold text-text-secondary">
            {t("forum.composer.body")}
          </p>
          <div className="[&_form]:p-0" data-forum-composer-body="">
            <MessageComposer
              key={forumId}
              channelId={forumId}
              voiceNotesServerId={serverId}
              onSend={() => void publish()}
              mentionCandidates={mentionCandidates}
              placeholder={t("forum.composer.bodyPlaceholder")}
              disabled={busy}
              embedded={embedded}
              droppedItems={droppedItems}
              onDroppedItemsConsumed={onDroppedItemsConsumed}
            />
          </div>
          {showErrors && bodyMissing && !bodyState.uploading && (
            <FieldError id={`${titleErrorId}-body`}>
              {t("forum.composer.bodyRequired")}
            </FieldError>
          )}
          {showErrors && bodyState.uploading && (
            <p className="mt-1.5 text-xs text-text-tertiary">{t("forum.composer.uploading")}</p>
          )}
        </div>

        {/* -------------------------------------------------------- tags */}
        {visibleTags.length > 0 && (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <p id={tagsLabelId} className="text-xs font-semibold text-text-secondary">
                {t("forum.composer.tags")}
                {requireTag && (
                  <span
                    className={cn(
                      "ml-2 font-semibold",
                      tagRequiredShown ? "text-danger" : "text-warning",
                    )}
                  >
                    {t("forum.composer.tagsRequired")}
                  </span>
                )}
              </p>
              <span
                className={cn(
                  "text-[11px] tabular-nums",
                  atMax ? "text-text-secondary" : "text-text-tertiary",
                )}
              >
                {t("forum.composer.tagsCount", {
                  count: tagIds.length,
                  max: FORUM_MAX_TAGS_PER_POST,
                })}
              </span>
            </div>
            <div
              role="group"
              aria-labelledby={tagsLabelId}
              aria-describedby={tagRequiredShown ? tagsErrorId : undefined}
              className="flex flex-wrap gap-1.5"
            >
              {visibleTags.map((tag, index) => {
                const on = tagIds.includes(tag.id);
                const disabled = busy || (!on && atMax);
                return (
                  <button
                    key={tag.id}
                    ref={(node) => {
                      tagRefs.current[index] = node;
                    }}
                    type="button"
                    aria-pressed={on}
                    aria-disabled={disabled || undefined}
                    tabIndex={index === tagFocus ? 0 : -1}
                    title={
                      tag.moderated
                        ? t("forum.tags.moderatedHint")
                        : disabled
                          ? t("forum.composer.tagsMax", { max: FORUM_MAX_TAGS_PER_POST })
                          : undefined
                    }
                    onFocus={() => setTagFocus(index)}
                    onKeyDown={(event) => onTagKeyDown(event, index)}
                    onClick={() => {
                      if (!disabled) {
                        toggleTag(tag.id);
                      }
                    }}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-[background-color,border-color,color,transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-11",
                      on
                        ? "border-transparent bg-accent-soft font-semibold text-on-accent-soft"
                        : "border-border text-text-secondary hover:bg-surface-2 hover:text-text",
                      disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <ForumTagIcon tag={tag} className="h-3.5 w-3.5" />
                    {tagLabel(tag)}
                    {tag.moderated && (
                      <ShieldCheck className="h-3.5 w-3.5 opacity-70" aria-label={t("forum.tags.moderatedHint")} />
                    )}
                    {on && <Check className="h-3.5 w-3.5 animate-icon-swap" aria-hidden />}
                  </button>
                );
              })}
            </div>
            {tagRequiredShown && (
              <FieldError id={tagsErrorId}>{t("forum.composer.tagsRequiredError")}</FieldError>
            )}
            {atMax && (
              <p className="mt-1.5 text-xs text-text-tertiary">
                {t("forum.composer.tagsMax", { max: FORUM_MAX_TAGS_PER_POST })}
              </p>
            )}
          </div>
        )}

        {tagsNotice && (
          <div
            data-forum-tags-notice={tagsNotice}
            role={tagsNotice === "error" ? "alert" : "status"}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-card)] bg-surface-2 px-3 py-2.5 text-sm text-text-secondary"
          >
            <Tag className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
            <span className="min-w-0 flex-1">
              {tagsNotice === "error"
                ? t("forum.composer.tagsLoadError")
                : t("forum.composer.tagsNoneToPick")}
            </span>
            {tagsNotice === "error" && onRetryTags && (
              <Button size="sm" variant="ghost" onClick={onRetryTags}>
                {t("forum.retry")}
              </Button>
            )}
            {tagsNotice === "none" && canManageTags && onOpenTagSettings && (
              <Button size="sm" variant="ghost" onClick={onOpenTagSettings}>
                {t("forum.empty.setupTags")}
              </Button>
            )}
          </div>
        )}

        {errorLine && (
          <div
            role="alert"
            className={cn(
              "flex items-start gap-2 rounded-[var(--radius-card)] px-3 py-2.5 text-sm animate-door-reveal",
              errorLine.tone === "warning"
                ? "bg-warning-soft text-on-warning-soft"
                : "bg-danger-soft text-on-danger-soft",
            )}
          >
            {errorLine.icon}
            <span>{errorLine.text}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
