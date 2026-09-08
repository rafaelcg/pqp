import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { Channel, VoiceRoomTransport } from "@pqp/shared";
import {
  isVoiceRoomChannelType,
  SLOWMODE_SECONDS_PRESETS,
} from "@pqp/shared";
import { Input } from "@/components/ui/input";
import { ChannelIcon } from "@/components/layout/channel-icon";
import {
  fetchChannelVoiceTransport,
  type ChannelVoiceTransport,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  CHANNEL_ICON_PRESETS,
  VOICE_ROOM_SIZE_OPTIONS,
  showsVoiceRoomSize,
  type VoiceRoomSizeOption,
} from "@/lib/channel-meta";
import { cn } from "@/lib/utils";
import type { RecipeKind } from "@/lib/speak-recipe";

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

const VOICE_ROOM_SIZE_KEYS: Record<VoiceRoomSizeOption, MessageKey> = {
  auto: "channelMeta.voiceRoomSize.auto",
  mesh: "channelMeta.voiceRoomSize.small",
  livekit: "channelMeta.voiceRoomSize.large",
};

function slowModeOptionKey(seconds: number): MessageKey {
  return SLOWMODE_PRESET_KEYS[seconds] ?? "channelMeta.slowMode.custom";
}

const VOICE_ROUTE_NAME_KEYS: Record<VoiceRoomTransport, MessageKey> = {
  mesh: "channelMeta.voiceRoute.mesh",
  livekit: "channelMeta.voiceRoute.livekit",
};

const VOICE_ROUTE_HINT_KEYS: Record<VoiceRoomTransport, MessageKey> = {
  mesh: "channelMeta.voiceRoute.mesh.hint",
  livekit: "channelMeta.voiceRoute.livekit.hint",
};

// A Map, not an object literal, because the lookup key arrives off the wire:
// `reasons["constructor"]` on a literal answers with something truthy.
const VOICE_ROUTE_REASON_KEYS = new Map<string, MessageKey>([
  ["unconfigured", "channelMeta.voiceRoute.reason.unconfigured"],
  ["dm", "channelMeta.voiceRoute.reason.dm"],
  ["small", "channelMeta.voiceRoute.reason.small"],
  ["large", "channelMeta.voiceRoute.reason.large"],
  ["community", "channelMeta.voiceRoute.reason.community"],
  ["override", "channelMeta.voiceRoute.reason.override"],
  ["hls", "channelMeta.voiceRoute.reason.hls"],
  ["default", "channelMeta.voiceRoute.reason.default"],
]);

/**
 * The reason string comes off the wire, so a server newer than this build can
 * send one this catalogue has never heard of. That returns null and the line
 * is dropped, rather than printing a raw key at a moderator.
 */
export function voiceRouteReasonKey(reason: string): MessageKey | null {
  return VOICE_ROUTE_REASON_KEYS.get(reason) ?? null;
}

const fieldClass =
  "h-11 rounded-xl border-ink-4/70 bg-ink text-[15px] focus-visible:ring-signal/40";

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

export interface ChannelOverviewDraft {
  name: string;
  topic: string;
  imageUrl: string;
  slowmodeSeconds: number;
  voiceRoomSize: VoiceRoomSizeOption;
}

export function ChannelOverviewSection({
  channel,
  draft,
  onDraftChange,
  iconOpen,
  onIconOpenChange,
  showPrivateBridge,
  showRecipeBridge,
  isPrivate,
  recipeKind,
  recipeRoleNames,
  onJumpPrivate,
  onJumpRecipe,
}: {
  channel: Channel;
  draft: ChannelOverviewDraft;
  onDraftChange: (next: ChannelOverviewDraft) => void;
  iconOpen: boolean;
  onIconOpenChange: (open: boolean) => void;
  showPrivateBridge: boolean;
  showRecipeBridge: boolean;
  isPrivate: boolean;
  recipeKind: RecipeKind;
  recipeRoleNames: string[];
  onJumpPrivate: () => void;
  onJumpRecipe: () => void;
}) {
  const { t, locale } = useTranslation();
  // A voice channel has a chat of its own, beside the call, and during a busy
  // call that chat is exactly where the flooding happens. Only a category is
  // excluded, because nothing is ever posted into one. A watch party is a
  // voice room with a screen on it, and the server has always enforced the
  // wait there -- it just had no control, so the one channel type built for
  // an audience of hundreds was the one you could not slow down.
  const showSlowMode =
    channel.kind === "server" &&
    (channel.type === "text" || isVoiceRoomChannelType(channel.type));
  const showVoice = showsVoiceRoomSize(channel);
  // Read-only, one call when the sheet opens, never polled. It is decoration
  // under the size control: if it fails, or has not landed yet, the block is
  // simply absent. Nothing here is worth an error toast on a settings sheet.
  const [voiceRoute, setVoiceRoute] = useState<ChannelVoiceTransport | null>(
    null,
  );

  useEffect(() => {
    if (!showVoice) {
      setVoiceRoute(null);
      return;
    }
    let current = true;
    setVoiceRoute(null);
    void fetchChannelVoiceTransport(channel.id)
      .then((route) => {
        if (current) {
          setVoiceRoute(route);
        }
      })
      .catch(() => {
        // Silent on purpose. See above.
      });
    return () => {
      current = false;
    };
  }, [channel.id, showVoice]);

  const preview = {
    ...channel,
    name: draft.name.trim() || channel.name,
    topic: draft.topic.trim() || null,
    imageUrl: draft.imageUrl.trim() || null,
  };
  const slowModeOptions = SLOWMODE_SECONDS_PRESETS.includes(
    draft.slowmodeSeconds as (typeof SLOWMODE_SECONDS_PRESETS)[number],
  )
    ? SLOWMODE_SECONDS_PRESETS
    : [draft.slowmodeSeconds, ...SLOWMODE_SECONDS_PRESETS];

  const recipeValue =
    recipeKind === "everyone"
      ? t("channelSettings.recipe.everyone")
      : recipeKind === "custom"
        ? t("channelSettings.recipe.custom")
        : recipeRoleNames.length > 0
          ? t("channelSettings.recipe.onlyRoles", {
              roles: joinRoleNames(recipeRoleNames, locale),
            })
          : t("channelSettings.recipe.roles");

  const resolvedReasonKey = voiceRoute
    ? voiceRouteReasonKey(voiceRoute.resolved.reason)
    : null;

  return (
    <div className="space-y-3.5">
      <SettingsGroup title={t("channelSettings.name")}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-ink text-lg ring-1 ring-ink-4 hover:ring-signal/50"
            aria-expanded={iconOpen}
            aria-label={t("channelSettings.changeIcon")}
            onClick={() => onIconOpenChange(!iconOpen)}
          >
            <ChannelIcon channel={preview} className="h-6 w-6" />
          </button>
          <Input
            value={draft.name}
            onChange={(event) =>
              onDraftChange({ ...draft, name: event.target.value })
            }
            maxLength={32}
            aria-label={t("channelSettings.name")}
            className={fieldClass}
          />
        </div>
        {iconOpen && (
          <div className="mt-3 animate-fade-in">
            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_ICON_PRESETS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  aria-label={t("channelMeta.iconPreset", { icon })}
                  aria-pressed={draft.imageUrl === icon}
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-lg transition-shadow",
                    draft.imageUrl === icon
                      ? "ring-2 ring-signal"
                      : "hover:ring-1 hover:ring-ink-4",
                  )}
                  onClick={() => onDraftChange({ ...draft, imageUrl: icon })}
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
                  CHANNEL_ICON_PRESETS.includes(draft.imageUrl)
                    ? ""
                    : draft.imageUrl
                }
                onChange={(event) =>
                  onDraftChange({ ...draft, imageUrl: event.target.value })
                }
                placeholder={t("channelMeta.iconPlaceholder")}
                maxLength={500}
                className={fieldClass}
              />
            </label>
            {draft.imageUrl ? (
              <button
                type="button"
                className="mt-2 text-[13px] font-medium text-signal hover:text-signal-dim"
                onClick={() => onDraftChange({ ...draft, imageUrl: "" })}
              >
                {t("channelMeta.iconClear")}
              </button>
            ) : null}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("channelMeta.topic")}
        hint={t("channelMeta.topicHint")}
      >
        <Input
          value={draft.topic}
          onChange={(event) =>
            onDraftChange({ ...draft, topic: event.target.value })
          }
          placeholder={t("channelMeta.topicPlaceholder")}
          maxLength={200}
          className={fieldClass}
        />
      </SettingsGroup>

      {showSlowMode && (
        <SettingsGroup
          title={t("channelMeta.slowMode")}
          hint={
            isVoiceRoomChannelType(channel.type)
              ? t("channelMeta.slowMode.hintVoice")
              : t("channelMeta.slowMode.hint")
          }
        >
          <select
            value={String(draft.slowmodeSeconds)}
            className={cn(
              "w-full border px-3 text-paper outline-none focus-visible:ring-2",
              fieldClass,
            )}
            onChange={(event) =>
              onDraftChange({
                ...draft,
                slowmodeSeconds: Number(event.target.value),
              })
            }
          >
            {slowModeOptions.map((seconds) => (
              <option key={seconds} value={seconds}>
                {t(slowModeOptionKey(seconds), { seconds })}
              </option>
            ))}
          </select>
        </SettingsGroup>
      )}

      {showVoice && (
        <SettingsGroup
          title={t("channelMeta.voiceRoomSize")}
          hint={t("channelMeta.voiceRoomSize.hint")}
        >
          <select
            value={draft.voiceRoomSize}
            aria-label={t("channelMeta.voiceRoomSize")}
            className={cn(
              "w-full border px-3 text-paper outline-none focus-visible:ring-2",
              fieldClass,
            )}
            onChange={(event) =>
              onDraftChange({
                ...draft,
                voiceRoomSize: event.target.value as VoiceRoomSizeOption,
              })
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

      {showVoice && voiceRoute && (
        <SettingsGroup title={t("channelMeta.voiceRoute")}>
          <div className="space-y-3">
            <div>
              <VoiceRouteRow
                label={t("channelMeta.voiceRoute.idleLabel")}
                value={t(
                  VOICE_ROUTE_NAME_KEYS[voiceRoute.resolved.transport],
                )}
              />
              <p className="mt-0.5 text-[13px] leading-snug text-paper-muted">
                {t(VOICE_ROUTE_HINT_KEYS[voiceRoute.resolved.transport])}
                {resolvedReasonKey && (
                  <span className="block">{t(resolvedReasonKey)}</span>
                )}
              </p>
            </div>
            {voiceRoute.live ? (
              <div>
                <VoiceRouteRow
                  label={t("channelMeta.voiceRoute.liveLabel", {
                    count: voiceRoute.live.participants,
                  })}
                  value={t(VOICE_ROUTE_NAME_KEYS[voiceRoute.live.transport])}
                />
                {voiceRoute.live.transport !==
                  voiceRoute.resolved.transport && (
                  <p className="mt-0.5 text-[13px] leading-snug text-paper-muted">
                    {t("channelMeta.voiceRoute.pinned")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[13px] leading-snug text-paper-muted">
                {t("channelMeta.voiceRoute.empty")}
              </p>
            )}
          </div>
        </SettingsGroup>
      )}

      {(showPrivateBridge || showRecipeBridge) && (
        <div className="overflow-hidden rounded-2xl bg-ink-3/70">
          {showPrivateBridge && (
            <BridgeRow
              label={t("channelSettings.bridge.private")}
              value={
                isPrivate ? t("channelSettings.yes") : t("channelSettings.no")
              }
              onClick={onJumpPrivate}
            />
          )}
          {showRecipeBridge && (
            <BridgeRow
              label={
                channel.type === "voice"
                  ? t("channelSettings.bridge.speak")
                  : t("channelSettings.bridge.post")
              }
              value={recipeValue}
              onClick={onJumpRecipe}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One fact, stated. Same shape as `BridgeRow` without the affordance: this
 * block reports, it does not lead anywhere.
 */
function VoiceRouteRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 flex-1 text-[13px] text-paper-muted">
        {label}
      </span>
      <span className="text-[13px] font-medium text-paper">{value}</span>
    </div>
  );
}

function BridgeRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink-3/80"
    >
      <span className="min-w-0 flex-1 text-[15px] text-paper">{label}</span>
      <span className="max-w-[45%] truncate text-[13px] text-paper-muted">
        {value}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
    </button>
  );
}

export function joinRoleNames(names: string[], locale: string): string {
  if (names.length === 0) {
    return "";
  }
  try {
    return new Intl.ListFormat(locale, {
      style: "long",
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}
