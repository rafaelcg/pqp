import type { Message, MessageReaction } from "@pqp/shared";
import { SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { QUICK_REACTIONS } from "@/lib/emoji-shortcodes";
import { cn, formatTime } from "@/lib/utils";
import { MessageListSkeleton } from "@/components/ui/skeleton";

interface MessageListProps {
  messages: Message[];
  currentUserId: string | null;
  channelId?: string | null;
  isLoading?: boolean;
  canManage?: boolean;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onDeleteMessage?: (messageId: string) => void;
}

export function MessageList({
  messages,
  currentUserId,
  channelId = null,
  isLoading = false,
  canManage = false,
  onToggleReaction,
  onDeleteMessage,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pickerMessageId, setPickerMessageId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (isLoading) {
    return <MessageListSkeleton />;
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="font-display text-xl font-bold text-paper">
          Start the thread
        </p>
        <p className="max-w-xs text-sm text-paper-muted">
          Messages persist. Use **bold**, *italic*, `code`, and links. React
          with emoji from the context menu.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-5">
      {messages.map((message) => {
        const items: ContextMenuItemDef[] = [
          {
            id: "copy-text",
            label: "Copy text",
            onSelect: () => void navigator.clipboard.writeText(message.body),
          },
          {
            id: "copy-id",
            label: "Copy message ID",
            onSelect: () => void navigator.clipboard.writeText(message.id),
          },
          {
            id: "copy-link",
            label: "Copy message link",
            onSelect: () => {
              const link = `${window.location.origin}/channels/${channelId ?? message.channelId}/${message.id}`;
              void navigator.clipboard.writeText(link);
            },
          },
          { id: "sep-copy", label: "", separator: true },
          {
            id: "add-reaction",
            label: "Add reaction",
            onSelect: () => setPickerMessageId(message.id),
          },
          { id: "sep-quick", label: "", separator: true },
          ...QUICK_REACTIONS.map((emoji) => ({
            id: `react-${emoji}`,
            label: emoji,
            onSelect: () => onToggleReaction(message.id, emoji),
          })),
        ];

        const canDelete =
          !!onDeleteMessage &&
          (message.authorId === currentUserId || canManage);
        if (canDelete) {
          items.push(
            { id: "sep-delete", label: "", separator: true },
            {
              id: "delete",
              label: "Delete message",
              danger: true,
              onSelect: () => {
                if (window.confirm("Delete this message?")) {
                  onDeleteMessage?.(message.id);
                }
              },
            },
          );
        }

        return (
          <ContextMenu key={message.id} items={items}>
            <article className="group flex gap-3 rounded-md px-1 py-0.5 hover:bg-ink-3/40">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-3 text-sm font-semibold">
                {message.authorAvatarUrl ? (
                  <img
                    src={message.authorAvatarUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  message.authorName.slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={`font-semibold ${
                      message.authorId === currentUserId
                        ? "text-signal"
                        : "text-paper"
                    }`}
                  >
                    {message.authorName}
                  </span>
                  {message.authorTag && (
                    <span className="font-mono text-[11px] text-paper-muted">
                      {message.authorTag}
                    </span>
                  )}
                  <time className="text-[11px] text-paper-muted">
                    {formatTime(message.createdAt)}
                  </time>
                </div>
                <div className="markdown-body text-[15px] leading-relaxed text-paper/90">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    allowedElements={[
                      "p",
                      "strong",
                      "em",
                      "code",
                      "pre",
                      "a",
                      "br",
                    ]}
                    unwrapDisallowed
                  >
                    {message.body}
                  </ReactMarkdown>
                </div>
                <ReactionBar
                  reactions={message.reactions ?? []}
                  isPickerOpen={pickerMessageId === message.id}
                  onToggle={(emoji) => onToggleReaction(message.id, emoji)}
                  onOpenPicker={() => setPickerMessageId(message.id)}
                  onClosePicker={() => setPickerMessageId(null)}
                />
              </div>
            </article>
          </ContextMenu>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

interface ReactionBarProps {
  reactions: MessageReaction[];
  isPickerOpen: boolean;
  onToggle: (emoji: string) => void;
  onOpenPicker: () => void;
  onClosePicker: () => void;
}

function ReactionBar({
  reactions,
  isPickerOpen,
  onToggle,
  onOpenPicker,
  onClosePicker,
}: ReactionBarProps) {
  const hasReactions = reactions.length > 0;
  const isVisible = hasReactions || isPickerOpen;

  return (
    <div
      className={cn(
        "relative mt-1.5 flex w-fit max-w-full flex-wrap items-center gap-1",
        !isVisible &&
          "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => onToggle(reaction.emoji)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
            reaction.me
              ? "border-signal/50 bg-signal/15 text-signal"
              : "border-ink-4 bg-ink-3/80 text-paper-muted hover:border-ink-4 hover:text-paper",
          )}
        >
          <span className="text-sm leading-none">{reaction.emoji}</span>
          <span className="font-medium tabular-nums">{reaction.count}</span>
        </button>
      ))}
      <button
        type="button"
        aria-label="Add reaction"
        onClick={onOpenPicker}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-4 text-paper-muted hover:border-signal/50 hover:text-signal"
      >
        <SmilePlus className="h-3 w-3" />
      </button>
      {isPickerOpen && (
        <EmojiPickerPanel
          className="absolute bottom-full left-0 mb-2"
          onSelect={(emoji) => {
            onToggle(emoji);
            onClosePicker();
          }}
          onClose={onClosePicker}
        />
      )}
    </div>
  );
}
