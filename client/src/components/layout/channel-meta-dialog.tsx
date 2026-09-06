import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  SLOWMODE_SECONDS_PRESETS,
  type Channel,
  type VoiceRoomTransport,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
 * The voice room size control, as the `<select>` sees it. The wire value is
 * `null | "mesh" | "livekit"`; a `<select>` only speaks strings, so "auto" is
 * the form's spelling of null. Exported for the test, with `showsVoiceRoomSize`.
 */
export const VOICE_ROOM_SIZE_OPTIONS = ["auto", "mesh", "livekit"] as const;
export type VoiceRoomSizeOption = (typeof VOICE_ROOM_SIZE_OPTIONS)[number];

const VOICE_ROOM_SIZE_KEYS: Record<VoiceRoomSizeOption, MessageKey> = {
  auto: "channelMeta.voiceRoomSize.auto",
  mesh: "channelMeta.voiceRoomSize.small",
  livekit: "channelMeta.voiceRoomSize.large",
};

export function toVoiceRoomSizeOption(
  transport: VoiceRoomTransport | null | undefined,
): VoiceRoomSizeOption {
  return transport ?? "auto";
}

export function fromVoiceRoomSizeOption(
  option: VoiceRoomSizeOption,
): VoiceRoomTransport | null {
  return option === "auto" ? null : option;
}

/** Only a server voice channel has a room to size; conversations are always small. */
export function showsVoiceRoomSize(channel: Pick<Channel, "kind" | "type"> | null): boolean {
  return channel?.kind === "server" && channel.type === "voice";
}

const fieldClass =
  "h-11 rounded-xl border-ink-4/70 bg-ink text-[15px] focus-visible:ring-signal/40";

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

function SettingsGroup({
  title,
  hint,
  hintId,
  action,
  children,
}: {
  title: string;
  hint?: string;
  hintId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-ink-3/70 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-tight tracking-tight text-paper">
            {title}
          </h3>
          {hint && (
            <p
              id={hintId}
              className="mt-0.5 text-[13px] leading-snug text-paper-muted"
            >
              {hint}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

interface ChannelMetaDialogProps {
  open: boolean;
  channel: Channel | null;
  onClose: () => void;
  onSave: (updates: {
    topic: string | null;
    imageUrl: string | null;
    slowmodeSeconds?: number;
    voiceTransport?: VoiceRoomTransport | null;
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
  const [voiceRoomSize, setVoiceRoomSize] =
    useState<VoiceRoomSizeOption>("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const showSlowMode = channel?.kind === "server" && channel.type === "text";
  const showVoiceRoomSize = showsVoiceRoomSize(channel);
  const slowModeHintId = `${formId}-slow-mode-hint`;
  const voiceRoomSizeHintId = `${formId}-voice-room-size-hint`;
  const topicHintId = `${formId}-topic-hint`;
  const iconHintId = `${formId}-icon-hint`;

  const previewChannel = useMemo(() => {
    if (!channel) {
      return null;
    }
    return {
      ...channel,
      topic: topic.trim() || null,
      imageUrl: imageUrl.trim() || null,
    };
  }, [channel, topic, imageUrl]);

  useEffect(() => {
    if (open && channel) {
      setTopic(channel.topic ?? "");
      setImageUrl(channel.imageUrl ?? "");
      setSlowmodeSeconds(channel.slowmodeSeconds ?? 0);
      setVoiceRoomSize(toVoiceRoomSizeOption(channel.voiceTransport));
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
        ...(showVoiceRoomSize
          ? { voiceTransport: fromVoiceRoomSizeOption(voiceRoomSize) }
          : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channel.meta.error.generic"));
    } finally {
      setSaving(false);
    }
  }

  const slowModeOptions = SLOWMODE_SECONDS_PRESETS.includes(
    slowmodeSeconds as (typeof SLOWMODE_SECONDS_PRESETS)[number],
  )
    ? SLOWMODE_SECONDS_PRESETS
    : [slowmodeSeconds, ...SLOWMODE_SECONDS_PRESETS];

  return (
    <Dialog
      open={open && channel !== null}
      title={t("channelMeta.title")}
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
        className="space-y-3.5 px-5 py-5"
      >
        {previewChannel && (
          <div className="flex items-center gap-3 px-0.5 pb-1">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-ink-3 text-lg">
              <ChannelIcon channel={previewChannel} className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-tight">
                {t("channelMeta.channelName", { name: previewChannel.name })}
              </p>
              <p className="text-[13px] text-paper-muted">
                {previewChannel.type === "voice"
                  ? t("channelMeta.kind.voice")
                  : t("channelMeta.kind.text")}
              </p>
            </div>
          </div>
        )}

        <SettingsGroup
          title={t("channelMeta.topic")}
          hint={t("channelMeta.topicHint")}
          hintId={topicHintId}
        >
          <Input
            value={topic}
            aria-describedby={topicHintId}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t("channelMeta.topicPlaceholder")}
            maxLength={200}
            autoFocus
            className={fieldClass}
          />
        </SettingsGroup>

        {showSlowMode && (
          <SettingsGroup
            title={t("channelMeta.slowMode")}
            hint={t("channelMeta.slowMode.hint")}
            hintId={slowModeHintId}
          >
            <select
              value={String(slowmodeSeconds)}
              aria-describedby={slowModeHintId}
              className={cn(
                "w-full border px-3 text-paper outline-none focus-visible:ring-2",
                fieldClass,
              )}
              onChange={(e) => setSlowmodeSeconds(Number(e.target.value))}
            >
              {slowModeOptions.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t(slowModeOptionKey(seconds), { seconds })}
                </option>
              ))}
            </select>
          </SettingsGroup>
        )}

        {showVoiceRoomSize && (
          <SettingsGroup
            title={t("channelMeta.voiceRoomSize")}
            hint={t("channelMeta.voiceRoomSize.hint")}
            hintId={voiceRoomSizeHintId}
          >
            <select
              value={voiceRoomSize}
              aria-label={t("channelMeta.voiceRoomSize")}
              aria-describedby={voiceRoomSizeHintId}
              className={cn(
                "w-full border px-3 text-paper outline-none focus-visible:ring-2",
                fieldClass,
              )}
              onChange={(e) =>
                setVoiceRoomSize(e.target.value as VoiceRoomSizeOption)
              }
            >
              {VOICE_ROOM_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(VOICE_ROOM_SIZE_KEYS[option])}
                </option>
              ))}
            </select>
          </SettingsGroup>
        )}

        <SettingsGroup
          title={t("channelMeta.icon")}
          hint={t("channelMeta.iconHint")}
          hintId={iconHintId}
          action={
            imageUrl ? (
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-signal hover:text-signal-dim"
                onClick={() => {
                  setImageUrl("");
                  setError(null);
                }}
              >
                {t("channelMeta.iconClear")}
              </button>
            ) : null
          }
        >
          <div className="flex flex-wrap gap-1.5" aria-describedby={iconHintId}>
            {CHANNEL_ICON_PRESETS.map((icon) => (
              <button
                key={icon}
                type="button"
                aria-label={t("channelMeta.iconPreset", { icon })}
                aria-pressed={imageUrl === icon}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-lg transition-shadow",
                  imageUrl === icon
                    ? "ring-2 ring-signal"
                    : "hover:ring-1 hover:ring-ink-4",
                )}
                onClick={() => {
                  setImageUrl(icon);
                  setError(null);
                }}
              >
                {icon}
              </button>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="mb-1.5 block text-[13px] text-paper-muted">
              {t("channelMeta.iconUrl")}
            </span>
            <Input
              value={
                CHANNEL_ICON_PRESETS.includes(imageUrl) ? "" : imageUrl
              }
              onChange={(e) => {
                setImageUrl(e.target.value);
                setError(null);
              }}
              placeholder={t("channelMeta.iconPlaceholder")}
              maxLength={500}
              className={fieldClass}
            />
          </label>
        </SettingsGroup>

        {error && (
          <p className="px-1 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
