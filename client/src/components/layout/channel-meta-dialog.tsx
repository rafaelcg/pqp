import { useEffect, useId, useState, type FormEvent } from "react";
import {
  SLOWMODE_SECONDS_PRESETS,
  type Channel,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const SLOWMODE_PRESET_KEYS: Record<number, MessageKey> = {
  0: "channelMeta.slowMode.off",
  5: "channelMeta.slowMode.5s",
  10: "channelMeta.slowMode.10s",
  15: "channelMeta.slowMode.15s",
  30: "channelMeta.slowMode.30s",
  60: "channelMeta.slowMode.1m",
  120: "channelMeta.slowMode.2m",
  300: "channelMeta.slowMode.5m",
  600: "channelMeta.slowMode.10m",
  900: "channelMeta.slowMode.15m",
  3600: "channelMeta.slowMode.1h",
  21600: "channelMeta.slowMode.6h",
};

function slowModeOptionKey(seconds: number): MessageKey {
  return SLOWMODE_PRESET_KEYS[seconds] ?? "channelMeta.slowMode.custom";
}

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
    slowmodeSeconds?: number;
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
  const [slowmodeSeconds, setSlowmodeSeconds] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const showSlowMode = channel?.kind === "server" && channel.type === "text";
  const slowModeHintId = `${formId}-slow-mode-hint`;

  useEffect(() => {
    if (open && channel) {
      setTopic(channel.topic ?? "");
      setImageUrl(channel.imageUrl ?? "");
      setSlowmodeSeconds(channel.slowmodeSeconds ?? 0);
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
        ...(showSlowMode ? { slowmodeSeconds } : {}),
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
      title={t("channelMeta.title")}
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

        {showSlowMode && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
              {t("channelMeta.slowMode")}
            </span>
            <select
              value={String(slowmodeSeconds)}
              aria-describedby={slowModeHintId}
              className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper outline-none focus:border-signal"
              onChange={(e) => setSlowmodeSeconds(Number(e.target.value))}
            >
              {(SLOWMODE_SECONDS_PRESETS.includes(
                slowmodeSeconds as (typeof SLOWMODE_SECONDS_PRESETS)[number],
              )
                ? SLOWMODE_SECONDS_PRESETS
                : [slowmodeSeconds, ...SLOWMODE_SECONDS_PRESETS]
              ).map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t(slowModeOptionKey(seconds), { seconds })}
                </option>
              ))}
            </select>
            <span
              id={slowModeHintId}
              className="mt-1 block text-xs text-paper-muted"
            >
              {t("channelMeta.slowMode.hint")}
            </span>
          </label>
        )}

        <label className="mb-2 block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("channelMeta.icon")}
          </span>
          <Input
            value={imageUrl}
            onChange={(e) => {
              setImageUrl(e.target.value);
              setError(null);
            }}
            placeholder={t("channelMeta.iconPlaceholder")}
            maxLength={500}
          />
        </label>

        <div className="flex flex-wrap gap-1.5">
          {CHANNEL_ICON_PRESETS.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={t("channelMeta.iconPreset", { icon })}
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
            {t("channelMeta.iconClear")}
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
