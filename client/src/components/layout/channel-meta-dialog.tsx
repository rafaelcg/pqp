import { useEffect, useId, useState, type FormEvent } from "react";
import type { Channel } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const CHANNEL_ICON_PRESETS = ["📡", "💬", "🔊", "🎮", "☕", "🛠️", "🎵", "📌"];

/**
 * `null` means the field is fine as it stands — either empty, an emoji/short
 * label (the pre-existing icon shorthand, untouched by this check), or an
 * `https://` URL. Anything else that is shaped like a URL (has a `scheme://`)
 * is rejected: a channel image is rendered to everyone in the server, and
 * `http://` both fails to load for anyone visiting over https and — unlike
 * https — never encrypts the request, so a CDN or MITM on the path can see
 * and rewrite exactly which server member is fetching which pixel and when.
 * Kept a pure function (no component state) so it is unit-testable on its
 * own, same as `handleErrorMessage` in `lib/onboarding.ts`.
 */
export function validateChannelIconInput(value: string): MessageKey | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "channel.meta.image.error.invalid";
  }
  if (parsed.protocol !== "https:") {
    return "channel.meta.image.error.httpsOnly";
  }
  return null;
}

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
  const { t } = useTranslation();
  const [topic, setTopic] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    if (open && channel) {
      setTopic(channel.topic ?? "");
      setImageUrl(channel.imageUrl ?? "");
      setError(null);
    }
  }, [open, channel]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const iconError = validateChannelIconInput(imageUrl);
    if (iconError) {
      setError(t(iconError));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        topic: topic.trim() || null,
        imageUrl: imageUrl.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channel.meta.error.generic"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open && channel !== null}
      eyebrow={t("channelMeta.eyebrow")}
      title={t("channelMeta.title", {
        name: channel?.name ?? t("channelMeta.titleFallback"),
      })}
      description={t("channelMeta.description")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => void handleSubmit(e)}
        className="px-5 py-4"
      >
        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("channelMeta.topic")}
          </span>
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t("channelMeta.topicPlaceholder")}
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
            onChange={(e) => {
              setImageUrl(e.target.value);
              setError(null);
            }}
            placeholder="📡 or https://…"
            maxLength={500}
          />
        </label>

        <div className="flex flex-wrap gap-1.5">
          {CHANNEL_ICON_PRESETS.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={`Use ${icon} as the channel icon`}
              aria-pressed={imageUrl === icon}
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

        {error && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
