import { MESSAGE_MAX_LENGTH, type Gif } from "@pqp/shared";
import { CornerUpLeft, ImagePlay, Smile, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AutocompleteMenu,
  type AutocompleteOption,
} from "@/components/chat/autocomplete-menu";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { GifPickerPanel } from "@/components/chat/gif-picker";
import { Button } from "@/components/ui/button";
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
  onSend: (body: string) => void;
  onTyping?: () => void;
  slashContext?: ComposerSlashContext;
  insertText?: string | null;
  onInsertConsumed?: () => void;
  replyTarget?: ComposerReplyTarget | null;
  onCancelReply?: () => void;
  mentionCandidates?: MentionCandidate[];
  disabled?: boolean;
  placeholder?: string;
}

/** Grow with the content, but never take over the whole pane. */
const MAX_COMPOSER_HEIGHT_PX = 200;

const MENU_ID = "composer-autocomplete";

export function MessageComposer({
  onSend,
  onTyping,
  slashContext,
  insertText,
  onInsertConsumed,
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
  const [isGifSearchEnabled, setIsGifSearchEnabled] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState<SlashFeedback | null>(null);
  const [isRunningSlash, setIsRunningSlash] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Lets the insert effect append without listing the draft as a dependency. */
  const bodyRef = useRef(body);
  bodyRef.current = body;

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
   * A GIF is a whole message, not text to keep editing — inserting the URL into
   * the draft would only ever be followed by pressing Enter, and would mix it
   * with whatever else is half-typed there.
   */
  function sendGif(gif: Gif) {
    setIsGifPickerOpen(false);
    onSend(gif.url);
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
      setIsGifPickerOpen(false);
    }
  }

  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || isRunningSlash) {
      return;
    }

    if (slashContext && trimmed.startsWith("/")) {
      await runSlash(trimmed);
      return;
    }

    onSend(expandEmojiShortcodes(trimmed));
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
      const query = getSlashQuery(body).toLowerCase();
      if (selected.takesArgs && query !== selected.name) {
        event.preventDefault();
        applySlashSelection(selected);
      }
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
          onSelect={sendGif}
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
      <div className="flex gap-2">
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
          disabled={disabled || !body.trim() || isRunningSlash}
        >
          Send
        </Button>
      </div>
    </form>
  );
}
