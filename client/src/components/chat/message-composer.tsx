import { Smile } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { SlashCommandMenu } from "@/components/chat/slash-command-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { expandEmojiShortcodes } from "@/lib/emoji-shortcodes";
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

interface MessageComposerProps {
  onSend: (body: string) => void;
  slashContext?: ComposerSlashContext;
  insertText?: string | null;
  onInsertConsumed?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageComposer({
  onSend,
  slashContext,
  insertText,
  onInsertConsumed,
  disabled,
  placeholder = "Message channel",
}: MessageComposerProps) {
  const [body, setBody] = useState("");
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState<SlashFeedback | null>(null);
  const [isRunningSlash, setIsRunningSlash] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const menuOpen =
    Boolean(slashContext) && isSlashMenuOpen(body) && !menuDismissed;
  const slashMatches = useMemo(
    () => (menuOpen ? filterSlashCommands(getSlashQuery(body)) : []),
    [body, menuOpen],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [body]);

  useEffect(() => {
    if (!insertText) {
      return;
    }
    setBody((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(" ");
      return `${prev}${needsSpace ? " " : ""}${insertText} `;
    });
    onInsertConsumed?.();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [insertText, onInsertConsumed]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    if (!input) {
      setBody((prev) => prev + emoji);
      return;
    }

    const start = input.selectionStart ?? body.length;
    const end = input.selectionEnd ?? body.length;
    const next = body.slice(0, start) + emoji + body.slice(end);
    setBody(next);

    requestAnimationFrame(() => {
      input.focus();
      const cursor = start + emoji.length;
      input.setSelectionRange(cursor, cursor);
    });
  }

  function applySlashSelection(command: SlashCommandMeta) {
    if (command.takesArgs) {
      setBody(`/${command.name} `);
    } else {
      setBody(`/${command.name}`);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
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
      }
    } finally {
      setIsRunningSlash(false);
      setIsPickerOpen(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
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
    setIsPickerOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (menuOpen || isPickerOpen || feedback) {
        event.preventDefault();
        setIsPickerOpen(false);
        setFeedback(null);
        if (menuOpen) {
          setMenuDismissed(true);
        }
      }
      return;
    }

    if (!menuOpen || slashMatches.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % slashMatches.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(
        (index) => (index - 1 + slashMatches.length) % slashMatches.length,
      );
      return;
    }

    if (event.key === "Tab") {
      const selected = slashMatches[selectedIndex];
      if (!selected) {
        return;
      }
      event.preventDefault();
      applySlashSelection(selected);
      return;
    }

    if (event.key === "Enter" && !event.metaKey) {
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
      className="safe-pb relative border-t border-ink-4/60 px-3 py-3 sm:px-4"
    >
      {menuOpen && (
        <SlashCommandMenu
          id="slash-command-menu"
          commands={slashMatches}
          selectedIndex={selectedIndex}
          onSelect={(command) => {
            if (command.takesArgs) {
              applySlashSelection(command);
              return;
            }
            void runSlash(`/${command.name}`);
          }}
          onHover={setSelectedIndex}
        />
      )}
      {isPickerOpen && !menuOpen && (
        <EmojiPickerPanel
          className="absolute bottom-[calc(100%-0.25rem)] left-3 sm:left-4"
          onSelect={insertEmoji}
          onClose={() => setIsPickerOpen(false)}
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
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label="Add emoji"
          aria-expanded={isPickerOpen}
          onClick={() => {
            setIsPickerOpen((open) => !open);
          }}
          onMouseDown={(event) => {
            if (menuOpen) {
              event.preventDefault();
            }
          }}
          className="shrink-0 text-paper-muted hover:text-signal"
        >
          <Smile className="h-5 w-5" />
        </Button>
        <Input
          ref={inputRef}
          value={body}
          onChange={(e) => {
            setMenuDismissed(false);
            setBody(e.target.value);
          }}
          placeholder={placeholder}
          disabled={disabled || isRunningSlash}
          className="flex-1"
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "slash-command-menu" : undefined}
          aria-autocomplete="list"
          onKeyDown={handleKeyDown}
        />
        <Button
          type="submit"
          disabled={disabled || !body.trim() || isRunningSlash}
        >
          Send
        </Button>
      </div>
    </form>
  );
}
