import { useEffect, useState, type FormEvent } from "react";
import type { Channel } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const CHANNEL_ICON_PRESETS = ["📡", "💬", "🔊", "🎮", "☕", "🛠️", "🎵", "📌"];

interface ChannelMetaDialogProps {
  open: boolean;
  channel: Channel | null;
  onClose: () => void;
  onSave: (updates: {
    topic: string | null;
    imageUrl: string | null;
  }) => Promise<void> | void;
}

export function ChannelMetaDialog({
  open,
  channel,
  onClose,
  onSave,
}: ChannelMetaDialogProps) {
  const [topic, setTopic] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && channel) {
      setTopic(channel.topic ?? "");
      setImageUrl(channel.imageUrl ?? "");
      setError(null);
    }
  }, [open, channel]);

  if (!open || !channel) {
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        topic: topic.trim() || null,
        imageUrl: imageUrl.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/80 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="animate-rise w-full rounded-t-2xl border border-ink-4 bg-ink-2 p-5 shadow-2xl sm:max-w-md sm:rounded-2xl"
      >
        <p className="text-xs uppercase tracking-[0.18em] text-signal">
          Channel
        </p>
        <h2 className="mb-1 font-display text-2xl font-bold">
          Edit #{channel.name}
        </h2>
        <p className="mb-4 text-sm text-paper-muted">
          Topic shows in the channel header. Icon can be an emoji or image URL.
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            Topic
          </span>
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What is this channel about?"
            maxLength={200}
            autoFocus
          />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            Icon (emoji or image URL)
          </span>
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="📡 or https://…"
            maxLength={500}
          />
        </label>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {CHANNEL_ICON_PRESETS.map((icon) => (
            <button
              key={icon}
              type="button"
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-base ${
                imageUrl === icon
                  ? "border-signal bg-signal/10"
                  : "border-ink-4 bg-ink hover:border-signal/50"
              }`}
              onClick={() => setImageUrl(icon)}
            >
              {icon}
            </button>
          ))}
          <button
            type="button"
            className="rounded-md border border-ink-4 px-2 text-xs text-paper-muted hover:border-signal/50"
            onClick={() => setImageUrl("")}
          >
            Clear
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 safe-pb">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
