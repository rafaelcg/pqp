import {
  ATTACHMENT_MIME_ALLOWLIST,
  isImageContentType,
  MESSAGE_MAX_LENGTH,
  type AttachmentContentType,
  type Gif,
} from "@pqp/shared";
import {
  AlertCircle,
  CornerUpLeft,
  ImagePlay,
  Paperclip,
  Smile,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AutocompleteMenu,
  type AutocompleteOption,
} from "@/components/chat/autocomplete-menu";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { GifPickerPanel } from "@/components/chat/gif-picker";
import { Button } from "@/components/ui/button";
import {
  AttachmentAbortError,
  createPreviewUrl,
  filesFromDataTransfer,
  formatByteSize,
  loadAttachmentConfig,
  revokePreviewUrl,
  selectAttachments,
  uploadAttachment,
  type AcceptedFile,
  type OutgoingAttachment,
} from "@/lib/attachments";
import { createGifAttachment } from "@/lib/api";
import { expandEmojiShortcodes } from "@/lib/emoji-shortcodes";
import { loadGifSearchEnabled } from "@/lib/gifs";
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
} from "@/lib/mention-autocomplete";
import {
  executeSlashCommand,
  filterSlashCommands,
  getSlashQuery,
  isSlashMenuOpen,
  type SlashCommandMeta,
  type SlashFeedback,
} from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

export interface ComposerSlashContext {
  updateDisplayName: (name: string) => Promise<void>;
  openInvite: (mode: "create" | "join") => void;
  joinByCode: (code: string) => Promise<void>;
  setMuted: (muted: boolean) => void;
  isInVoice: boolean;
  isMuted: boolean;
}

export interface ComposerReplyTarget {
  id: string;
  authorName: string;
}

interface MessageComposerProps {
  onSend: (body: string, attachments?: OutgoingAttachment[]) => void;
  onTyping?: () => void;
  slashContext?: ComposerSlashContext;
  insertText?: string | null;
  onInsertConsumed?: () => void;
  /** Where uploads are minted. Null disables the paperclip along with the send. */
  channelId?: string | null;
  /**
   * Files dropped on the message pane. The drop target is the whole
   * conversation rather than the textarea, so it lives in the shell and arrives
   * here the same way `insertText` does.
   */
  droppedFiles?: File[] | null;
  onDroppedFilesConsumed?: () => void;
  replyTarget?: ComposerReplyTarget | null;
  onCancelReply?: () => void;
  mentionCandidates?: MentionCandidate[];
  disabled?: boolean;
  placeholder?: string;
}

/** Grow with the content, but never take over the whole pane. */
const MAX_COMPOSER_HEIGHT_PX = 200;

const MENU_ID = "composer-autocomplete";

/** One chip in the tray above the textarea, from pick to send. */
interface PendingAttachment {
  /** Client-side only: a chip exists before the server has minted an id. */
  localId: string;
  filename: string;
  contentType: AttachmentContentType;
  byteSize: number;
  /** Object URL of the local file; this component owns revoking it. */
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  /** 0..1, from the XHR upload progress event. */
  progress: number;
  attachmentId: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
}

let localIdCounter = 0;
function nextLocalId(): string {
  localIdCounter += 1;
  return `attachment-${localIdCounter}`;
}

export function MessageComposer({
  onSend,
  onTyping,
  slashContext,
  insertText,
  onInsertConsumed,
  channelId = null,
  droppedFiles = null,
  onDroppedFilesConsumed,
  replyTarget = null,
  onCancelReply,
  mentionCandidates = [],
  disabled,
  placeholder = "Message channel",
}: MessageComposerProps) {
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState("");
  const [isGifSearchEnabled, setIsGifSearchEnabled] = useState(false);
  const [attachmentLimits, setAttachmentLimits] = useState<{
    enabled: boolean;
    maxBytes: number;
  } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState<SlashFeedback | null>(null);
  const [isRunningSlash, setIsRunningSlash] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Lets the insert effect append without listing the draft as a dependency. */
  const bodyRef = useRef(body);
  bodyRef.current = body;
  /** Read by handlers and by the unmount cleanup, neither of which may re-run. */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const uploadsRef = useRef(new Map<string, AbortController>());

  const slashOpen =
    Boolean(slashContext) && isSlashMenuOpen(body) && !menuDismissed;
  const slashMatches = useMemo(
    () => (slashOpen ? filterSlashCommands(getSlashQuery(body)) : []),
    [body, slashOpen],
  );

  // Slash wins when both could apply: a command can only start at position 0,
  // where an `@` can never be preceded by whitespace anyway.
  const mentionQuery = useMemo(
    () => (slashOpen || menuDismissed ? null : findMentionQuery(body, caret)),
    [body, caret, menuDismissed, slashOpen],
  );
  const mentionMatches = useMemo(
    () =>
      mentionQuery
        ? filterMentionCandidates(mentionCandidates, mentionQuery.query)
        : [],
    [mentionCandidates, mentionQuery],
  );

  const isUploading = pending.some((item) => item.status === "uploading");
  const readyCount = pending.filter((item) => item.status === "ready").length;
  const isAttachmentsEnabled = Boolean(attachmentLimits?.enabled && channelId);

  const menuKind: "slash" | "mention" | null = slashOpen
    ? "slash"
    : mentionMatches.length > 0
      ? "mention"
      : null;
  const menuCount =
    menuKind === "slash" ? slashMatches.length : mentionMatches.length;

  const options: AutocompleteOption[] = useMemo(() => {
    if (menuKind === "slash") {
      return slashMatches.map((command) => ({
        id: command.name,
        primary: <span className="font-mono">/{command.name}</span>,
        secondary: command.description,
      }));
    }
    if (menuKind === "mention") {
      return mentionMatches.map((member) => ({
        id: member.id,
        primary: `@${member.username}`,
        secondary: member.displayName,
        leading: (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-[10px] font-semibold text-text">
            {member.avatarUrl ? (
              <img
                src={member.avatarUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            ) : (
              member.displayName.slice(0, 1).toUpperCase()
            )}
          </span>
        ),
      }));
    }
    return [];
  }, [menuKind, mentionMatches, slashMatches]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [body, caret]);

  // Offering a GIF button on a deployment with no provider key would only ever
  // open a panel that errors, so the answer is awaited before it appears.
  useEffect(() => {
    let active = true;
    void loadGifSearchEnabled().then((enabled) => {
      if (active) {
        setIsGifSearchEnabled(enabled);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Same shape, same reason: with no bucket configured there is nothing to
  // upload to, so the paperclip never appears rather than failing on use.
  useEffect(() => {
    let active = true;
    void loadAttachmentConfig().then((config) => {
      if (active) {
        setAttachmentLimits(config);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // The composer is remounted per channel, so unmount is also "you switched
  // channels": every in-flight upload is abandoned and every object URL still
  // owned here is released. Anything already sent has left this list.
  useEffect(() => {
    const uploads = uploadsRef.current;
    return () => {
      for (const controller of uploads.values()) {
        controller.abort();
      }
      uploads.clear();
      for (const item of pendingRef.current) {
        revokePreviewUrl(item.previewUrl);
      }
    };
  }, []);

  // Auto-size the textarea so multi-line drafts are visible while typing.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
  }, [body]);

  useEffect(() => {
    if (!insertText) {
      return;
    }
    const prev = bodyRef.current;
    const needsSpace = prev.length > 0 && !prev.endsWith(" ");
    const next = `${prev}${needsSpace ? " " : ""}${insertText} `;
    setBody(next);
    setCaret(next.length);
    onInsertConsumed?.();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [insertText, onInsertConsumed]);

  // Picking a reply from the message list should leave the user typing, not
  // hunting for the box they are meant to type in.
  useEffect(() => {
    if (replyTarget) {
      inputRef.current?.focus();
    }
  }, [replyTarget]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function syncCaret(input: HTMLTextAreaElement) {
    setCaret(input.selectionStart ?? input.value.length);
  }

  /** Put the caret back where the edit left it, after React repaints. */
  function restoreCaret(position: number) {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    if (!input) {
      setBody((prev) => prev + emoji);
      return;
    }

    const start = input.selectionStart ?? body.length;
    const end = input.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + emoji + body.slice(end));
    restoreCaret(start + emoji.length);
  }

  /**
   * A picked GIF is staged like any other attachment rather than sent on the
   * spot. Sending immediately meant the pick was final — no way to see what you
   * actually chose at full size, no way to say anything alongside it, and a
   * misclick was a message. Staging also puts the GIF on the attachment path,
   * which is what lets it carry a caption and be edited later without the URL
   * ever being the message.
   */
  async function stageGif(gif: Gif) {
    setIsGifPickerOpen(false);
    if (!channelId) {
      return;
    }
    const localId = nextLocalId();
    setPending((list) => [
      ...list,
      {
        localId,
        filename: gif.title || "GIF",
        contentType: "image/gif",
        // Not our bytes and never counted against the cap; the chip shows a
        // dimension rather than a size for these.
        byteSize: 0,
        previewUrl: gif.previewUrl,
        status: "uploading",
        progress: 0,
        attachmentId: null,
        width: gif.width,
        height: gif.height,
        error: null,
      },
    ]);

    try {
      const { attachment } = await createGifAttachment(channelId, {
        url: gif.url,
        width: gif.width,
        height: gif.height,
        title: gif.title,
      });
      updatePending(localId, {
        status: "ready",
        progress: 1,
        attachmentId: attachment.id,
      });
    } catch (error) {
      updatePending(localId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Could not add that GIF",
      });
    }
  }

  function updatePending(
    localId: string,
    patch: Partial<PendingAttachment>,
  ) {
    setPending((list) =>
      list.map((item) =>
        item.localId === localId ? { ...item, ...patch } : item,
      ),
    );
  }

  function startUpload(targetChannelId: string, selected: AcceptedFile) {
    const localId = nextLocalId();
    const controller = new AbortController();
    uploadsRef.current.set(localId, controller);
    // Created up front, not on completion: the thumbnail is the confirmation
    // that the right file was picked, and it has to be there before the upload
    // finishes rather than after.
    const previewUrl = createPreviewUrl(selected.file);

    setPending((list) => [
      ...list,
      {
        localId,
        filename: selected.filename,
        contentType: selected.contentType,
        byteSize: selected.file.size,
        previewUrl,
        status: "uploading",
        progress: 0,
        attachmentId: null,
        width: null,
        height: null,
        error: null,
      },
    ]);

    void uploadAttachment(targetChannelId, selected, {
      signal: controller.signal,
      onProgress: (fraction) => updatePending(localId, { progress: fraction }),
    })
      .then((uploaded) =>
        updatePending(localId, {
          status: "ready",
          progress: 1,
          attachmentId: uploaded.attachmentId,
          width: uploaded.width,
          height: uploaded.height,
        }),
      )
      .catch((error: unknown) => {
        // A cancel already removed the chip and revoked its URL; re-adding an
        // error to a row that is gone would resurrect it.
        if (error instanceof AttachmentAbortError) {
          return;
        }
        updatePending(localId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed",
        });
      })
      .finally(() => uploadsRef.current.delete(localId));
  }

  function addFiles(files: File[]) {
    if (!channelId || !attachmentLimits?.enabled || files.length === 0) {
      return;
    }
    const { accepted, rejected } = selectAttachments(files, {
      existingCount: pendingRef.current.length,
      maxBytes: attachmentLimits.maxBytes,
    });
    if (rejected.length > 0) {
      // Reuses the slash-command feedback strip: it already self-clears, and a
      // second error surface in the same three inches of screen helps nobody.
      setFeedback({
        tone: "error",
        message: rejected
          .map((item) => `${item.filename}: ${item.reason}`)
          .join("\n"),
      });
    }
    for (const selected of accepted) {
      startUpload(channelId, selected);
    }
  }

  /**
   * `addFiles` closes over state and so has a new identity every render. Listing
   * it in the drop effect's deps would re-run that effect constantly — the same
   * remount-storm shape the Clerk token getter caused.
   */
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useEffect(() => {
    if (!droppedFiles?.length) {
      return;
    }
    addFilesRef.current(droppedFiles);
    onDroppedFilesConsumed?.();
  }, [droppedFiles, onDroppedFilesConsumed]);

  function removeAttachment(localId: string) {
    const target = pendingRef.current.find((item) => item.localId === localId);
    uploadsRef.current.get(localId)?.abort();
    uploadsRef.current.delete(localId);
    if (target) {
      revokePreviewUrl(target.previewUrl);
    }
    setPending((list) => list.filter((item) => item.localId !== localId));
  }

  /**
   * Screenshot paste — the single action this whole feature exists for.
   *
   * The default has to be prevented: the clipboard carries the image *and* an
   * HTML fragment wrapping it, so letting the paste through would drop markup
   * into the textarea alongside the upload.
   */
  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!channelId || !attachmentLimits?.enabled) {
      return;
    }
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    addFiles(files);
  }

  function applySlashSelection(command: SlashCommandMeta) {
    const next = command.takesArgs ? `/${command.name} ` : `/${command.name}`;
    setBody(next);
    restoreCaret(next.length);
  }

  function applyMentionSelection(index: number) {
    const member = mentionMatches[index];
    if (!member?.username || !mentionQuery) {
      return;
    }
    const next = applyMention(body, mentionQuery, member.username);
    setBody(next.value);
    restoreCaret(next.caret);
  }

  function applySelection(index: number) {
    if (menuKind === "mention") {
      applyMentionSelection(index);
      return;
    }
    const command = slashMatches[index];
    if (!command) {
      return;
    }
    if (command.takesArgs) {
      applySlashSelection(command);
      return;
    }
    void runSlash(`/${command.name}`);
  }

  async function runSlash(value: string) {
    if (!slashContext || isRunningSlash) {
      return;
    }
    setIsRunningSlash(true);
    try {
      const result = await executeSlashCommand(value, {
        sendMessage: (messageBody) => {
          onSend(expandEmojiShortcodes(messageBody).trim());
        },
        openGifPicker: (query) => {
          setGifQuery(query);
          setIsGifPickerOpen(true);
        },
        isGifSearchEnabled,
        ...slashContext,
      });
      if (result.feedback) {
        setFeedback(result.feedback);
      }
      if (result.kind === "ok" && result.clearComposer !== false) {
        setBody("");
        setCaret(0);
      }
    } finally {
      setIsRunningSlash(false);
      setIsPickerOpen(false);
    }
  }

  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const trimmed = body.trim();
    const ready = pending.filter(
      (item) => item.status === "ready" && item.attachmentId,
    );
    // Sending mid-upload would silently drop whatever had not finished, so the
    // send waits rather than sending a message the user did not compose.
    if (isRunningSlash || isUploading) {
      return;
    }
    if (!trimmed && ready.length === 0) {
      return;
    }

    if (slashContext && trimmed.startsWith("/")) {
      await runSlash(trimmed);
      return;
    }

    onSend(
      trimmed ? expandEmojiShortcodes(trimmed) : "",
      ready.map((item) => ({
        attachmentId: item.attachmentId!,
        filename: item.filename,
        contentType: item.contentType,
        byteSize: item.byteSize,
        width: item.width,
        height: item.height,
        previewUrl: item.previewUrl,
      })),
    );
    // The object URLs of everything just sent now belong to the chat
    // controller, which revokes them when the real message replaces the
    // optimistic one — revoking here would blank the image it is showing.
    // Failed chips keep theirs, and stay put so the upload can be retried.
    setPending((list) => list.filter((item) => item.status === "failed"));
    setBody("");
    setCaret(0);
    setIsPickerOpen(false);
    setIsGifPickerOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      if (menuKind || isPickerOpen || isGifPickerOpen || feedback) {
        event.preventDefault();
        setIsPickerOpen(false);
        setIsGifPickerOpen(false);
        setFeedback(null);
        if (menuKind) {
          setMenuDismissed(true);
        }
        return;
      }
      // Only once nothing is layered on top: Escape backing out of the reply
      // should not also close a menu the user opened over it.
      if (replyTarget && onCancelReply) {
        event.preventDefault();
        onCancelReply();
      }
      return;
    }

    // Enter sends; Shift+Enter (and the menus, handled below) inserts a
    // newline. Without this a textarea would only ever add lines.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !(menuKind && menuCount > 0)
    ) {
      event.preventDefault();
      void handleSubmit();
      return;
    }

    if (!menuKind || menuCount === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % menuCount);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + menuCount) % menuCount);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      applySelection(selectedIndex);
      return;
    }

    if (event.key === "Enter" && !event.metaKey) {
      if (menuKind === "mention") {
        event.preventDefault();
        applySelection(selectedIndex);
        return;
      }
      const selected = slashMatches[selectedIndex];
      if (!selected) {
        return;
      }
      // Every path here must consume the Enter. The earlier send branch is
      // skipped while this menu is open, so falling through lands in the
      // textarea's default and types a newline — which is what `/help` plus
      // Enter used to do: the menu was open, the name was already complete, no
      // branch matched, and the command silently became a blank line.
      event.preventDefault();
      const query = getSlashQuery(body).toLowerCase();
      if (query !== selected.name) {
        // Half-typed: complete it. applySelection runs no-argument commands
        // outright, matching what clicking the row does.
        applySelection(selectedIndex);
        return;
      }
      if (selected.takesArgs) {
        // Fully typed and takes arguments, but none were given. Run it anyway:
        // the ones with optional arguments are valid bare, and the ones that
        // require them answer with their own usage line, which is more useful
        // than swallowing the keystroke.
        void handleSubmit();
        return;
      }
      void runSlash(`/${selected.name}`);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="safe-pb relative border-t border-border/60 px-3 py-3 sm:px-4"
    >
      {menuKind && (
        <AutocompleteMenu
          id={MENU_ID}
          label={menuKind === "mention" ? "Members" : "Slash commands"}
          heading={menuKind === "mention" ? "Members" : "Commands"}
          emptyLabel="No matching commands"
          options={options}
          selectedIndex={selectedIndex}
          onSelect={applySelection}
          onHover={setSelectedIndex}
        />
      )}
      {isPickerOpen && !menuKind && (
        <EmojiPickerPanel
          className="absolute bottom-[calc(100%-0.25rem)] left-3 sm:left-4"
          onSelect={insertEmoji}
          onClose={() => setIsPickerOpen(false)}
        />
      )}
      {isGifPickerOpen && !menuKind && (
        <GifPickerPanel
          className="absolute bottom-[calc(100%-0.25rem)] left-3 sm:left-4"
          initialQuery={gifQuery}
          onSelect={stageGif}
          onClose={() => setIsGifPickerOpen(false)}
        />
      )}
      {feedback && (
        <p
          className={cn(
            "mb-2 whitespace-pre-wrap rounded-md border px-2.5 py-1.5 text-xs",
            feedback.tone === "error" &&
              "border-danger/40 bg-danger/10 text-danger",
            feedback.tone === "success" &&
              "border-signal/40 bg-signal/10 text-signal",
            feedback.tone === "info" &&
              "border-ink-4 bg-ink-3 text-paper-muted",
          )}
          role="status"
        >
          {feedback.message}
        </p>
      )}
      {replyTarget && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-muted">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            Replying to{" "}
            <span className="font-medium text-text">
              {replyTarget.authorName}
            </span>
          </span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={() => onCancelReply?.()}
            className="shrink-0 rounded p-0.5 hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <ul
          aria-label="Attachments to send"
          className="mb-2 flex flex-wrap gap-2"
        >
          {pending.map((item) => (
            <AttachmentChip
              key={item.localId}
              attachment={item}
              onRemove={() => removeAttachment(item.localId)}
            />
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {isAttachmentsEnabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              // Greys out everything that would only be rejected on the way
              // back. It is a filter in the OS picker and nothing more — a drop
              // or a paste bypasses it entirely, so `selectAttachments` is
              // still the check that counts.
              accept={ATTACHMENT_MIME_ALLOWLIST.join(",")}
              className="hidden"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                // Cleared so that picking the same file twice in a row still
                // fires a change event the second time.
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="Attach a file"
              onClick={() => fileInputRef.current?.click()}
              onMouseDown={(event) => {
                if (menuKind) {
                  event.preventDefault();
                }
              }}
              className="shrink-0 text-paper-muted hover:text-signal"
            >
              <Paperclip className="h-5 w-5" />
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label="Add emoji"
          aria-expanded={isPickerOpen}
          onClick={() => {
            setIsGifPickerOpen(false);
            setIsPickerOpen((open) => !open);
          }}
          onMouseDown={(event) => {
            if (menuKind) {
              event.preventDefault();
            }
          }}
          className="shrink-0 text-paper-muted hover:text-signal"
        >
          <Smile className="h-5 w-5" />
        </Button>
        {isGifSearchEnabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label="Add GIF"
            aria-expanded={isGifPickerOpen}
            onClick={() => {
              setIsPickerOpen(false);
              // The button always opens on trending. Without this it would
              // reopen on whatever a previous `/gif <query>` had seeded.
              setGifQuery("");
              setIsGifPickerOpen((open) => !open);
            }}
            onMouseDown={(event) => {
              if (menuKind) {
                event.preventDefault();
              }
            }}
            className="shrink-0 text-paper-muted hover:text-signal"
          >
            <ImagePlay className="h-5 w-5" />
          </Button>
        )}
        <textarea
          ref={inputRef}
          value={body}
          rows={1}
          onChange={(e) => {
            setMenuDismissed(false);
            setBody(e.target.value);
            syncCaret(e.target);
            if (e.target.value.trim() && !e.target.value.startsWith("/")) {
              onTyping?.();
            }
          }}
          // Arrow keys and clicks move the caret without changing the value, and
          // the active `@token` is defined by where the caret is.
          onSelect={(e) => syncCaret(e.currentTarget)}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled || isRunningSlash}
          maxLength={MESSAGE_MAX_LENGTH}
          className="flex-1 resize-none self-center rounded-md border border-ink-4 bg-ink-3 px-3 py-2 text-sm leading-6 text-paper placeholder:text-paper-muted focus-visible:border-signal/60 focus-visible:outline-none disabled:opacity-50"
          role="combobox"
          aria-expanded={Boolean(menuKind)}
          aria-controls={menuKind ? MENU_ID : undefined}
          aria-autocomplete="list"
          aria-label={placeholder}
          onKeyDown={handleKeyDown}
        />
        <Button
          type="submit"
          className="self-end"
          // An attachment is a message on its own, so an empty body is only a
          // reason to stay disabled when nothing is attached either.
          disabled={
            disabled ||
            isRunningSlash ||
            isUploading ||
            (!body.trim() && readyCount === 0)
          }
        >
          Send
        </Button>
      </div>
    </form>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = isImageContentType(attachment.contentType);
  const percent = Math.round(attachment.progress * 100);

  return (
    <li className="relative flex w-44 items-center gap-2 rounded-md border border-ink-4 bg-ink-3/60 p-1.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-ink-4/60">
        {isImage ? (
          <img
            src={attachment.previewUrl}
            alt={attachment.filename}
            className="h-full w-full object-cover"
          />
        ) : (
          <Paperclip className="h-4 w-4 text-paper-muted" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-paper" title={attachment.filename}>
          {attachment.filename}
        </span>
        {attachment.status === "failed" ? (
          <span className="flex items-center gap-1 text-[11px] text-danger">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{attachment.error ?? "Failed"}</span>
          </span>
        ) : (
          <span className="block text-[11px] text-paper-muted">
            {/* A GIF's bytes are the provider's, never measured here, so the
                row would read "0 B" — the dimensions are the honest thing to
                show for one. */}
            {attachment.byteSize > 0
              ? formatByteSize(attachment.byteSize)
              : attachment.width && attachment.height
                ? `${attachment.width}×${attachment.height}`
                : "GIF"}
          </span>
        )}
        {attachment.status === "uploading" && (
          <span
            role="progressbar"
            aria-label={`Uploading ${attachment.filename}`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-ink-4"
          >
            <span
              className="block h-full rounded-full bg-signal transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </span>
        )}
      </span>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.filename}`}
        className="shrink-0 self-start rounded p-0.5 text-paper-muted hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
