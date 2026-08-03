import { buildReplyExcerpt, type Message } from "@pqp/shared";
import { Pin } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { fetchPinnedMessages, unpinMessage } from "@/lib/api";

interface PinnedMessagesPanelProps {
  open: boolean;
  channelId: string | null;
  channelName: string | null;
  /** Same gate the row's own context menu uses: a server channel needs
   * manage permission, a conversation lets any participant unpin. */
  canUnpin: boolean;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}

/** What to show when a pin has no text of its own — an image-only or
 * GIF-only message — rather than rendering an empty line. */
function describeBody(message: Message): string {
  if (message.body.trim()) {
    return buildReplyExcerpt(message.body);
  }
  if (message.attachments.length > 0) {
    const first = message.attachments[0]!;
    return message.attachments.length > 1
      ? `${first.filename} + ${message.attachments.length - 1} more`
      : first.filename;
  }
  return "(empty message)";
}

export function PinnedMessagesPanel({
  open,
  channelId,
  channelName,
  canUnpin,
  onClose,
  onJumpToMessage,
}: PinnedMessagesPanelProps) {
  const [pins, setPins] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !channelId) {
      return;
    }
    let cancelled = false;
    setError(null);
    setPins([]);
    setLoading(true);
    fetchPinnedMessages(channelId)
      .then((res) => {
        if (!cancelled) {
          setPins(res.messages);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load pins");
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
  }, [open, channelId]);

  async function unpin(messageId: string) {
    setBusyId(messageId);
    setError(null);
    try {
      await unpinMessage(messageId);
      // No broadcast reconciliation to wait for here — the panel is its own
      // read, not the message list, so it drops the row itself.
      setPins((prev) => prev.filter((message) => message.id !== messageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unpin");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow="Pinned messages"
      title={`#${channelName ?? "channel"}`}
      description="Messages the channel has agreed are worth finding again."
      onClose={onClose}
    >
      <div className="space-y-3 p-4">
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {loading && (
          <p className="text-sm text-paper-muted" role="status">
            Loading pins…
          </p>
        )}
        {!loading && pins.length === 0 && !error && (
          <p className="text-sm text-paper-muted">
            Nothing pinned yet. Right-click a message to pin it.
          </p>
        )}
        <ul className="space-y-2">
          {pins.map((message) => (
            <li
              key={message.id}
              className="rounded-md border border-ink-4 bg-ink-3/40 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    onJumpToMessage(message.id);
                    onClose();
                  }}
                >
                  <p className="flex items-center gap-1.5 text-xs text-paper-muted">
                    <span className="font-semibold text-paper">
                      {message.authorName}
                    </span>
                    <span>·</span>
                    <span>{new Date(message.createdAt).toLocaleString()}</span>
                  </p>
                  <p className="mt-0.5 truncate text-sm text-paper">
                    {describeBody(message)}
                  </p>
                  {message.pinnedBy && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-paper-muted">
                      <Pin className="h-3 w-3 text-signal" aria-hidden />
                      Pinned by {message.pinnedBy.displayName}
                    </p>
                  )}
                </button>
                {canUnpin && (
                  <button
                    type="button"
                    disabled={busyId === message.id}
                    onClick={() => void unpin(message.id)}
                    className="shrink-0 rounded px-2 py-1 text-xs text-paper-muted hover:bg-ink-4 hover:text-paper disabled:opacity-50"
                  >
                    Unpin
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
