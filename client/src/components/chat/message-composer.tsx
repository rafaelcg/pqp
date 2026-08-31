import {
  ATTACHMENT_MIME_ALLOWLIST,
  extractMentions,
  isImageContentType,
  MESSAGE_MAX_LENGTH,
  type AttachmentContentType,
  type ChanceRequest,
  type Gif,
  type PollRequest,
} from "@pqp/shared";
import {
  AlertCircle,
  Angry,
  BarChart3,
  CheckCircle2,
  Coins,
  CornerUpLeft,
  Dices,
  Eraser,
  HelpCircle,
  ImagePlay,
  Info,
  LogIn,
  Meh,
  Mic,
  MicOff,
  Paperclip,
  Pencil,
  Plus,
  Shuffle,
  Smile,
  Spade,
  Terminal,
  User,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { PollComposer } from "@/components/chat/poll-composer";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AUTOCOMPLETE_GRID_COLUMNS,
  AutocompleteMenu,
  type AutocompleteOption,
} from "@/components/chat/autocomplete-menu";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { GifPickerPanel } from "@/components/chat/gif-picker";
import { UserAvatar } from "@/components/user/user-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
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
import {
  applyEmojiShortcode,
  expandClosedShortcodeAtCaret,
  expandEmojiShortcodes,
  filterEmojiShortcodes,
  findEmojiQuery,
} from "@/lib/emoji-shortcodes";
import { loadGifSearchEnabled } from "@/lib/gifs";
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
} from "@/lib/mention-autocomplete";
import {
  executeSlashCommand,
  filterRollPresets,
  filterSlashCommands,
  getSlashQuery,
  isRollPresetMenu,
  isSlashMenuOpen,
  parseSlashInput,
  type SlashCommandMeta,
  type SlashFeedback,
} from "@/lib/slash-commands";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface ComposerSlashContext {
  updateDisplayName: (name: string) => Promise<void>;
  openInvite: (mode: "create" | "join") => void;
  joinByCode: (code: string) => Promise<void>;
  setMuted: (muted: boolean) => void;
  isInVoice: boolean;
  isMuted: boolean;
  sendChance: (request: ChanceRequest) => void;
  sendPoll: (request: PollRequest) => void;
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
  /**
   * ArrowUp with an empty composer: edit the reader's last message.
   * Return true when a message was opened so the key is consumed.
   */
  onEditLastOwn?: () => boolean;
}

/**
 * Resting height of the field, the send pill, and the icon buttons.
 * They have to be the same number: a 36px icon next to a 42px field is
 * the "a bit shorter" the composer used to show. `h-10` is 40px.
 */
const COMPOSER_CONTROL_PX = 40;
const COMPOSER_ICON_BUTTON =
  "h-10 w-10 shrink-0 text-paper-muted hover:text-signal";

/** Grow with the content, but never take over the whole pane. */
const MAX_COMPOSER_HEIGHT_PX = 200;
/** Line box used once the draft wraps. Resting uses the full 40px instead. */
const COMPOSER_LINE_PX = 20;
const COMPOSER_PAD_Y_PX = 8;

const MENU_ID = "composer-autocomplete";

/**
 * One glance-able mark per slash command in the autocomplete menu. Purely
 * visual; the command list itself lives in `@/lib/slash-commands`.
 */
const SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  help: HelpCircle,
  shrug: Meh,
  tableflip: Angry,
  me: User,
  nick: Pencil,
  invite: UserPlus,
  join: LogIn,
  mute: MicOff,
  unmute: Mic,
  gif: ImagePlay,
  roll: Dices,
  flip: Coins,
  choose: Shuffle,
  draw: Spade,
  poll: BarChart3,
  clear: Eraser,
};

const FEEDBACK_ICONS = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
} as const;

/** Pip cells for a 6 on a 3×3 face. Same layout the roll card uses. */
const D6_PREVIEW_PIPS = [0, 2, 3, 5, 6, 8];

function parseRollPresetShape(notation: string): { count: number; sides: number } {
  const match = /^(\d+)d(\d+)$/i.exec(notation);
  return {
    count: match ? Number(match[1]) : 1,
    sides: match ? Number(match[2]) : 20,
  };
}

/**
 * What the preset will roll: a cube with pips for d6, the face count otherwise.
 *
 * 28px rather than 32: `2d6` draws two of these side by side, and four cells of
 * that have to fit the composer's width on the narrowest phone still in use.
 */
function RollDiePreview({ notation }: { notation: string }) {
  const { count, sides } = parseRollPresetShape(notation);
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {Array.from({ length: Math.min(count, 2) }, (_, index) => (
        <span
          key={index}
          className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink-2 ring-1 ring-ink-4 shadow-[0_2px_0_0_var(--color-ink-4)]"
        >
          {sides === 6 ? (
            <span className="grid h-4 w-4 grid-cols-3 grid-rows-3 place-items-center">
              {Array.from({ length: 9 }, (_, cell) => (
                <span
                  key={cell}
                  className={cn(
                    "h-1 w-1 rounded-full",
                    D6_PREVIEW_PIPS.includes(cell) ? "bg-paper" : "bg-transparent",
                  )}
                />
              ))}
            </span>
          ) : (
            <span className="font-display text-[11px] font-bold leading-none tabular-nums text-paper">
              {sides}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

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
  placeholder,
  onEditLastOwn,
}: MessageComposerProps) {
  const { t } = useTranslation();
  const inputPlaceholder = placeholder ?? t("composer.placeholderFallback");
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [composerBox, setComposerBox] = useState({
    height: COMPOSER_CONTROL_PX,
    lineHeight: COMPOSER_CONTROL_PX,
    paddingY: 0,
    overflowY: "hidden" as "hidden" | "auto",
    multiline: false,
  });
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false);
  const [isPollComposerOpen, setIsPollComposerOpen] = useState(false);
  const [isInsertMenuOpen, setIsInsertMenuOpen] = useState(false);
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
  const insertMenuRef = useRef<HTMLDivElement>(null);
  /** Lets the insert effect append without listing the draft as a dependency. */
  const bodyRef = useRef(body);
  bodyRef.current = body;
  /** Read by handlers and by the unmount cleanup, neither of which may re-run. */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const uploadsRef = useRef(new Map<string, AbortController>());

  const rollPresets = useMemo(() => {
    if (!isRollPresetMenu(body)) {
      return [];
    }
    return filterRollPresets((parseSlashInput(body)?.args ?? "").trim());
  }, [body]);
  const rollArg = isRollPresetMenu(body)
    ? (parseSlashInput(body)?.args ?? "").trim()
    : "";
  const rollPresetOpen =
    Boolean(slashContext) &&
    !menuDismissed &&
    isRollPresetMenu(body) &&
    (rollArg === "" || rollPresets.length > 0);
  const slashOpen =
    Boolean(slashContext) &&
    !menuDismissed &&
    (rollPresetOpen || (isSlashMenuOpen(body) && !isRollPresetMenu(body)));
  const slashMatches = useMemo(
    () =>
      slashOpen && !rollPresetOpen
        ? filterSlashCommands(getSlashQuery(body))
        : [],
    [body, rollPresetOpen, slashOpen],
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

  const emojiQuery = useMemo(
    () =>
      slashOpen || menuDismissed || mentionQuery
        ? null
        : findEmojiQuery(body, caret),
    [body, caret, menuDismissed, mentionQuery, slashOpen],
  );
  const emojiMatches = useMemo(
    () => (emojiQuery ? filterEmojiShortcodes(emojiQuery.query) : []),
    [emojiQuery],
  );

  const isUploading = pending.some((item) => item.status === "uploading");
  const readyCount = pending.filter((item) => item.status === "ready").length;
  const isAttachmentsEnabled = Boolean(attachmentLimits?.enabled && channelId);

  const menuKind: "slash" | "mention" | "emoji" | null = slashOpen
    ? "slash"
    : mentionMatches.length > 0
      ? "mention"
      : emojiMatches.length > 0
        ? "emoji"
        : null;
  const menuCount =
    menuKind === "slash"
      ? rollPresetOpen
        ? rollPresets.length
        : slashMatches.length
      : menuKind === "mention"
        ? mentionMatches.length
        : emojiMatches.length;

  const FeedbackIcon = feedback ? FEEDBACK_ICONS[feedback.tone] : null;

  const options: AutocompleteOption[] = useMemo(() => {
    if (menuKind === "slash" && rollPresetOpen) {
      return rollPresets.map((preset) => {
        const hint =
          "hintKey" in preset && preset.hintKey ? t(preset.hintKey) : null;
        const name = t(preset.labelKey);
        return {
          id: preset.notation,
          leading: <RollDiePreview notation={preset.notation} />,
          // The die and its notation are the cell; "20-sided die" is the
          // accessible name and the tooltip. Printing that sentence on eight
          // full-width rows is what made this menu taller than the pane it
          // opens in, and the drawing says the same thing faster.
          primary: preset.notation,
          label: hint ? `${name} · ${hint}` : name,
        };
      });
    }
    if (menuKind === "slash") {
      return slashMatches.map((command) => {
        const Icon = SLASH_COMMAND_ICONS[command.name] ?? Terminal;
        // "/roll [2d6+3]" → "[2d6+3]": the name is already the primary label,
        // so only the argument shape is worth repeating.
        const argsHint = command.usage.replace(`/${command.name}`, "").trim();
        return {
          id: command.name,
          leading: (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-3 text-text-muted">
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>
          ),
          primary: (
            <span className="font-mono">
              /{command.name}
              {argsHint && (
                <span className="ml-1.5 font-normal text-text-muted">
                  {argsHint}
                </span>
              )}
            </span>
          ),
          secondary: command.description,
        };
      });
    }
    if (menuKind === "mention") {
      return mentionMatches.map((member) => ({
        id: member.id,
        primary: `@${member.username}`,
        secondary: member.displayName,
        leading: (
          <UserAvatar
            name={member.displayName}
            avatarUrl={member.avatarUrl}
            className="h-5 w-5"
            fallbackClassName="bg-surface-3 text-[10px] text-text"
            rounded="full"
          />
        ),
      }));
    }
    if (menuKind === "emoji") {
      return emojiMatches.map((entry) => ({
        id: entry.name,
        primary: entry.emoji,
        secondary: `:${entry.name}:`,
      }));
    }
    return [];
  }, [emojiMatches, menuKind, mentionMatches, rollPresetOpen, rollPresets, slashMatches, t]);

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

  // Gecko ignores `line-height` on a padded textarea the way Chromium does:
  // the placeholder sits on the top padding and the rest of the 40px box is
  // empty, which is the "misaligned" composer in Zen. Resting metrics use a
  // 40px line box and no vertical padding so one line is centered. Wrapped
  // drafts switch to 8px + 20px lines. Empty always stays 40px so a large
  // Gecko scrollHeight (or a user drag if resize leaks) cannot stick.
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) {
      return;
    }
    node.style.resize = "none";
    node.style.minHeight = `${COMPOSER_CONTROL_PX}px`;
    node.style.overflowY = "hidden";

    const applyResting = () => {
      node.style.lineHeight = `${COMPOSER_CONTROL_PX}px`;
      node.style.paddingTop = "0px";
      node.style.paddingBottom = "0px";
      node.style.height = `${COMPOSER_CONTROL_PX}px`;
    };

    if (!body) {
      applyResting();
      setComposerBox({
        height: COMPOSER_CONTROL_PX,
        lineHeight: COMPOSER_CONTROL_PX,
        paddingY: 0,
        overflowY: "hidden",
        multiline: false,
      });
      return;
    }

    node.style.lineHeight = `${COMPOSER_LINE_PX}px`;
    node.style.paddingTop = `${COMPOSER_PAD_Y_PX}px`;
    node.style.paddingBottom = `${COMPOSER_PAD_Y_PX}px`;
    node.style.height = "0px";
    const hasBreak = body.includes("\n");
    const minHeight = hasBreak
      ? COMPOSER_PAD_Y_PX * 2 + COMPOSER_LINE_PX * 2
      : COMPOSER_CONTROL_PX;
    const next = Math.min(
      Math.max(node.scrollHeight, minHeight),
      MAX_COMPOSER_HEIGHT_PX,
    );
    if (next <= COMPOSER_CONTROL_PX && !hasBreak) {
      applyResting();
      setComposerBox({
        height: COMPOSER_CONTROL_PX,
        lineHeight: COMPOSER_CONTROL_PX,
        paddingY: 0,
        overflowY: "hidden",
        multiline: false,
      });
      return;
    }
    node.style.height = `${next}px`;
    const overflowY = next >= MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
    node.style.overflowY = overflowY;
    setComposerBox({
      height: next,
      lineHeight: COMPOSER_LINE_PX,
      paddingY: COMPOSER_PAD_Y_PX,
      overflowY,
      multiline: true,
    });
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

  useEffect(() => {
    if (!isInsertMenuOpen) {
      return;
    }
    function closeIfOutside(event: PointerEvent) {
      if (insertMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsInsertMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsInsertMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isInsertMenuOpen]);

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
        error: error instanceof Error ? error.message : t("composer.gifFailed"),
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
          error: error instanceof Error ? error.message : t("composer.uploadFailed"),
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

  function applyEmojiSelection(index: number) {
    const entry = emojiMatches[index];
    if (!entry || !emojiQuery) {
      return;
    }
    const next = applyEmojiShortcode(body, emojiQuery, entry.emoji);
    setBody(next.value);
    restoreCaret(next.caret);
  }

  /** Wraps in both directions, whatever the step. */
  function moveSelection(delta: number) {
    setSelectedIndex(
      (index) => (((index + delta) % menuCount) + menuCount) % menuCount,
    );
  }

  function applySelection(index: number) {
    if (menuKind === "mention") {
      applyMentionSelection(index);
      return;
    }
    if (menuKind === "emoji") {
      applyEmojiSelection(index);
      return;
    }
    if (rollPresetOpen) {
      const preset = rollPresets[index];
      if (!preset) {
        return;
      }
      void runSlash(`/roll ${preset.notation}`);
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
        openPollComposer: () => {
          setIsPickerOpen(false);
          setIsGifPickerOpen(false);
          setIsPollComposerOpen(true);
        },
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
      setIsInsertMenuOpen(false);
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

    if (trimmed) {
      const mentions = extractMentions(trimmed);
      if (mentions.everyone || mentions.here) {
        const key =
          mentions.everyone && mentions.here
            ? "composer.confirmEveryoneHere"
            : mentions.everyone
              ? "composer.confirmEveryone"
              : "composer.confirmHere";
        if (!window.confirm(t(key))) {
          return;
        }
      }
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
    setIsInsertMenuOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      if (menuKind || isPickerOpen || isGifPickerOpen || isInsertMenuOpen || feedback) {
        event.preventDefault();
        setIsPickerOpen(false);
        setIsGifPickerOpen(false);
        setIsInsertMenuOpen(false);
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

    if (
      event.key === "ArrowUp" &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !menuKind &&
      !isPickerOpen &&
      !isGifPickerOpen &&
      body === "" &&
      pending.length === 0
    ) {
      if (onEditLastOwn?.()) {
        event.preventDefault();
      }
      return;
    }

    if (!menuKind || menuCount === 0) {
      return;
    }

    // A list has one option per row, so down is the next option. The dice grid
    // has four, so down is the option below rather than the one beside — unless
    // a filter has left fewer dice than that, when there is no second row and
    // stepping by four would move nothing.
    const verticalStep =
      rollPresetOpen && menuCount > AUTOCOMPLETE_GRID_COLUMNS
        ? AUTOCOMPLETE_GRID_COLUMNS
        : 1;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(verticalStep);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-verticalStep);
      return;
    }

    // Left and right belong to the caret, and only the grid has any use for
    // them — then only once the caret has run out of text to walk through, so
    // fixing a typo in `/roll 2d` still works. Escape closes the menu and gives
    // the keys back unconditionally.
    if (rollPresetOpen && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const input = event.currentTarget;
      const atEnd =
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
      if (atEnd) {
        event.preventDefault();
        moveSelection(event.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      applySelection(selectedIndex);
      return;
    }

    if (event.key === "Enter" && !event.metaKey) {
      if (menuKind === "mention" || menuKind === "emoji") {
        event.preventDefault();
        applySelection(selectedIndex);
        return;
      }
      if (rollPresetOpen) {
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

  function keepComposerFocused(event: { preventDefault: () => void }) {
    if (menuKind) {
      event.preventDefault();
    }
  }

  const insertItems = [
    isAttachmentsEnabled
      ? {
          id: "attach",
          label: t("composer.attach"),
          icon: Paperclip,
          onSelect: () => {
            setIsInsertMenuOpen(false);
            fileInputRef.current?.click();
          },
        }
      : null,
    {
      id: "emoji",
      label: t("composer.addEmoji"),
      icon: Smile,
      onSelect: () => {
        setIsInsertMenuOpen(false);
        setIsGifPickerOpen(false);
        setIsPollComposerOpen(false);
        setIsPickerOpen(true);
      },
    },
    slashContext
      ? {
          id: "poll",
          label: t("composer.addPoll"),
          icon: BarChart3,
          onSelect: () => {
            setIsInsertMenuOpen(false);
            setIsPickerOpen(false);
            setIsGifPickerOpen(false);
            setIsPollComposerOpen(true);
          },
        }
      : null,
    isGifSearchEnabled
      ? {
          id: "gif",
          label: t("composer.addGif"),
          icon: ImagePlay,
          onSelect: () => {
            setIsInsertMenuOpen(false);
            setIsPickerOpen(false);
            setGifQuery("");
            setIsGifPickerOpen(true);
          },
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="safe-pb relative border-t border-border/60 px-3 py-3 sm:px-4"
    >
      {menuKind && (
        <AutocompleteMenu
          id={MENU_ID}
          label={
            menuKind === "mention"
              ? t("composer.members")
              : menuKind === "emoji"
                ? t("composer.emoji")
                : rollPresetOpen
                  ? t("composer.dice")
                  : t("composer.slashCommands")
          }
          heading={
            menuKind === "mention"
              ? t("composer.members")
              : menuKind === "emoji"
                ? t("composer.emoji")
                : rollPresetOpen
                  ? t("composer.dice")
                  : t("composer.commands")
          }
          emptyLabel={
            menuKind === "emoji" ? t("composer.noEmoji") : t("composer.noCommands")
          }
          options={options}
          selectedIndex={selectedIndex}
          layout={rollPresetOpen ? "grid" : "list"}
          onSelect={applySelection}
          onHover={setSelectedIndex}
        />
      )}
      {isPickerOpen && !menuKind && (
        <EmojiPickerPanel
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
      {/*
        Out of flow on purpose. An in-flow strip (the old "Coin flipped"
        banner) shoved the composer down for five seconds, then jumped it
        back. Errors and /help still need a place to land; they overlay the
        last messages instead of moving the input.
      */}
      {feedback && FeedbackIcon && (
        <div
          className={cn(
            "absolute bottom-full left-3 right-3 z-20 mb-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs shadow-[var(--shadow-popover)] sm:left-4 sm:right-4",
            feedback.tone === "error" &&
              "border-danger/40 bg-ink-2 text-danger",
            feedback.tone === "success" &&
              "border-signal/40 bg-ink-2 text-signal",
            feedback.tone === "info" &&
              "border-ink-4 bg-ink-2 text-paper-muted",
          )}
          role="status"
        >
          <FeedbackIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">
            {feedback.message}
          </span>
        </div>
      )}
      {replyTarget && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-muted">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {t("composer.replying", { name: replyTarget.authorName })}
          </span>
          <button
            type="button"
            aria-label={t("composer.cancelReply")}
            onClick={() => onCancelReply?.()}
            className="shrink-0 rounded p-0.5 hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {isPollComposerOpen && slashContext && (
        <PollComposer
          onSubmit={(request) => {
            slashContext.sendPoll(request);
            setIsPollComposerOpen(false);
          }}
          onClose={() => setIsPollComposerOpen(false)}
        />
      )}
      {pending.length > 0 && (
        <ul
          aria-label={t("composer.attachments")}
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
      <div
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2",
          composerBox.multiline ? "items-end" : "items-center",
        )}
      >
        {isAttachmentsEnabled && (
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
        )}
        <div className="relative flex items-center">
          <div ref={insertMenuRef} className="relative sm:hidden">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              id="composer-insert"
              aria-label={t("composer.insert")}
              aria-haspopup="menu"
              aria-expanded={isInsertMenuOpen}
              onClick={() => {
                setIsPickerOpen(false);
                setIsGifPickerOpen(false);
                setIsPollComposerOpen(false);
                setIsInsertMenuOpen((open) => !open);
              }}
              onMouseDown={keepComposerFocused}
              className={COMPOSER_ICON_BUTTON}
            >
              <Plus className="h-5 w-5" />
            </Button>
            {isInsertMenuOpen && (
              <ComposerInsertMenu
                labelledBy="composer-insert"
                items={insertItems}
              />
            )}
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {isAttachmentsEnabled && (
              <Tooltip label={t("composer.attach")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => fileInputRef.current?.click()}
                  onMouseDown={keepComposerFocused}
                  className={COMPOSER_ICON_BUTTON}
                >
                  <Paperclip className="h-5 w-5" />
                </Button>
              </Tooltip>
            )}
            <Tooltip label={t("composer.addEmoji")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-expanded={isPickerOpen}
                onClick={() => {
                  setIsGifPickerOpen(false);
                  setIsPickerOpen((open) => !open);
                }}
                onMouseDown={keepComposerFocused}
                className={COMPOSER_ICON_BUTTON}
              >
                <Smile className="h-5 w-5" />
              </Button>
            </Tooltip>
            {slashContext && (
              <Tooltip label={t("composer.addPoll")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-expanded={isPollComposerOpen}
                  onClick={() => {
                    setIsPickerOpen(false);
                    setIsGifPickerOpen(false);
                    setIsPollComposerOpen((open) => !open);
                  }}
                  onMouseDown={keepComposerFocused}
                  className={COMPOSER_ICON_BUTTON}
                >
                  <BarChart3 className="h-5 w-5" />
                </Button>
              </Tooltip>
            )}
            {isGifSearchEnabled && (
              <Tooltip label={t("composer.addGif")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-expanded={isGifPickerOpen}
                  onClick={() => {
                    setIsPickerOpen(false);
                    // The button always opens on trending. Without this it would
                    // reopen on whatever a previous `/gif <query>` had seeded.
                    setGifQuery("");
                    setIsGifPickerOpen((open) => !open);
                  }}
                  onMouseDown={keepComposerFocused}
                  className={COMPOSER_ICON_BUTTON}
                >
                  <ImagePlay className="h-5 w-5" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="relative min-h-10 min-w-0">
          {body.length === 0 && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 z-[1] flex items-center overflow-hidden px-3 text-base leading-10 text-paper-muted sm:text-sm",
                (disabled || isRunningSlash) && "opacity-50",
              )}
            >
              <span className="min-w-0 truncate">{inputPlaceholder}</span>
            </span>
          )}
          <textarea
            ref={inputRef}
            value={body}
            rows={1}
            onChange={(e) => {
              setMenuDismissed(false);
              const nextValue = e.target.value;
              const nextCaret = e.target.selectionStart ?? nextValue.length;
              const expanded = expandClosedShortcodeAtCaret(nextValue, nextCaret);
              if (expanded) {
                setBody(expanded.value);
                restoreCaret(expanded.caret);
              } else {
                setBody(nextValue);
                setCaret(nextCaret);
              }
              const typingFrom = expanded?.value ?? nextValue;
              if (typingFrom.trim() && !typingFrom.startsWith("/")) {
                onTyping?.();
              }
            }}
            // Arrow keys and clicks move the caret without changing the value, and
            // the active `@token` is defined by where the caret is.
            onSelect={(e) => syncCaret(e.currentTarget)}
            onPaste={handlePaste}
            disabled={disabled || isRunningSlash}
            maxLength={MESSAGE_MAX_LENGTH}
            placeholder={inputPlaceholder}
            style={{
              resize: "none",
              height: composerBox.height,
              minHeight: COMPOSER_CONTROL_PX,
              lineHeight: `${composerBox.lineHeight}px`,
              paddingTop: composerBox.paddingY,
              paddingBottom: composerBox.paddingY,
              overflowY: composerBox.overflowY,
            }}
            className="block h-10 min-h-10 w-full resize-none overflow-hidden rounded-md border border-ink-4 bg-ink-3 px-3 py-0 text-sm text-paper placeholder:text-transparent focus-visible:border-signal/60 focus-visible:outline-none disabled:opacity-50"
            role="combobox"
            aria-expanded={Boolean(menuKind)}
            aria-controls={menuKind ? MENU_ID : undefined}
            aria-autocomplete="list"
            aria-label={inputPlaceholder}
            onKeyDown={handleKeyDown}
          />
        </div>
        <Button
          type="submit"
          className="h-10 shrink-0"
          // An attachment is a message on its own, so an empty body is only a
          // reason to stay disabled when nothing is attached either.
          disabled={
            disabled ||
            isRunningSlash ||
            isUploading ||
            (!body.trim() && readyCount === 0)
          }
        >
          {t("composer.send")}
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
  const { t } = useTranslation();
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
            <span className="truncate">{attachment.error ?? t("common.failed")}</span>
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
            aria-label={t("composer.uploading", { name: attachment.filename })}
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
        aria-label={t("composer.remove", { name: attachment.filename })}
        className="shrink-0 self-start rounded p-0.5 text-paper-muted hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function ComposerInsertMenu({
  labelledBy,
  items,
}: {
  labelledBy: string;
  items: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
  }>;
}) {
  return (
    <div
      role="menu"
      aria-labelledby={labelledBy}
      className="absolute bottom-full left-0 z-30 mb-1 min-w-52 rounded-md border border-ink-4 bg-ink-2 py-1 shadow-[var(--shadow-popover)]"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            onClick={item.onSelect}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-paper hover:bg-ink-3"
          >
            <Icon className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
