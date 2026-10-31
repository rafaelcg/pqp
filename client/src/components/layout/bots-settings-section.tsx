import {
  BOT_BASE_FACES,
  BOT_COLORS,
  SERVER_BOT_KNOWLEDGE_MAX,
  SERVER_BOT_NAME_MAX,
  SERVER_BOT_PERSONA_MAX,
  SERVER_BOT_WELCOME_DEFAULT,
  SERVER_BOT_WELCOME_MAX,
  parsePermissions,
  type Channel,
  type ServerBotDto,
  type ServerBotModelChoice,
  type ServerBotOverview,
} from "@pqp/shared";
import { CARD_SURFACE } from "@/components/ui/card";
import { useEffect, useId, useRef, useState } from "react";
import { AtSign, ListChecks, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import {
  At,
  ListChecks as ListChecksGlyph,
  ShieldCheck as ShieldCheckGlyph,
  Sparkle,
  Trash,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import { BotFace } from "@/components/bots/bot-face";
import { RadioChoices } from "@/components/bots/radio-choices";
import {
  EMPTY_BOT_DRAFT,
  PERSONA_PRESETS,
  ToolPicker,
  channelIcon,
  type BotDraft,
} from "@/components/bots/bot-wizard";
import { BotOverviewPanel, BotTabs, type BotTab } from "@/components/bots/bot-overview";
import { ServerBotTags } from "@/components/bots/server-bot-tags";
import { SettingsGroup, SettingsNotice, UnsavedChangesBar } from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import {
  ApiError,
  deleteServerBot,
  fetchBotOverview,
  fetchBotsConfig,
  fetchChannels,
  fetchServerBots,
  updateServerBot,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import {
  BOT_CARD_CHOSEN_REDESIGN,
  BOT_CARD_REDESIGN,
  BOT_CHOICE_FOCUS_REDESIGN,
  BOT_SWATCH_CHOSEN_REDESIGN,
  BOT_SWATCH_REDESIGN,
  BOT_RING_OFFSET_PANE_REDESIGN,
  ChosenCheck,
} from "@/components/bots/bot-choice";

/** The channels a bot can be put in: the ones people chat in. A forum covers its posts. */
function chatChannels(channels: Channel[]): Channel[] {
  return channels.filter(
    (c) => c.type === "text" || c.type === "voice" || c.type === "watch_party" || c.type === "forum",
  );
}

function formatDay(iso: string, locale: Parameters<typeof intlLocale>[0]): string {
  return new Date(iso).toLocaleDateString(intlLocale(locale), { day: "numeric", month: "long" });
}

function errorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.message.includes("name")) return "serverSettings.bots.error.name";
    if (err.status === 409) return "serverSettings.bots.error.limit";
    if (err.status === 403) return "serverSettings.bots.error.disabled";
  }
  return "serverSettings.bots.error.generic";
}

interface Draft extends BotDraft {
  /** Empty string is "the default model". */
  model: string;
  welcomeEnabled: boolean;
  /** Empty string is "no channel picked". */
  welcomeChannelId: string;
  /** Empty string is the default text. */
  welcomeMessage: string;
}

const EMPTY_DRAFT: Draft = {
  ...EMPTY_BOT_DRAFT,
  model: "",
  welcomeEnabled: false,
  welcomeChannelId: "",
  welcomeMessage: "",
};

function draftOf(bot: ServerBotDto): Draft {
  return {
    name: bot.name,
    color: bot.color,
    face: bot.face,
    tagline: bot.tagline ?? "",
    persona: bot.persona,
    knowledge: bot.knowledge,
    channelIds: bot.channelIds,
    answerToName: bot.answerToName,
    model: bot.model ?? "",
    tools: bot.tools,
    welcomeEnabled: bot.welcomeEnabled,
    welcomeChannelId: bot.welcomeChannelId ?? "",
    welcomeMessage: bot.welcomeMessage ?? "",
  };
}

/** Order-free comparison: the switches can be flipped in any order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * Server settings → Bots. One bot per server for now. With none, the page is
 * an invitation and the wizard makes it; once it exists, the page edits it
 * group by group, with the bot itself at the top.
 */
export function BotsSettingsSection({ serverId, onCreate }: { serverId: string; onCreate: () => void }) {
  const { t, locale } = useTranslation();
  const ids = { name: useId(), tagline: useId(), persona: useId(), knowledge: useId(), model: useId() };
  const [models, setModels] = useState<ServerBotModelChoice[]>([]);
  const [bot, setBot] = useState<ServerBotDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  // One switch request at a time, so two quick flips cannot land out of order.
  const [toggling, setToggling] = useState(false);
  // The draft as it was sent: an edit made while the save is in flight is kept.
  const sentDraft = useRef<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [missing, setMissing] = useState(0n);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<BotTab>("overview");
  const [overview, setOverview] = useState<ServerBotOverview | null>(null);
  const botId = bot?.id ?? null;

  useEffect(() => {
    if (!botId) return;
    let live = true;
    void fetchBotOverview(serverId, botId)
      .then((next) => {
        if (live) setOverview(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [serverId, botId, saved]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setBot(null);
    setError(null);
    void Promise.all([
      fetchServerBots(serverId),
      fetchChannels(serverId),
      fetchBotsConfig(serverId).catch(() => null),
    ])
      .then(([bots, list, config]) => {
        if (!live) return;
        setModels(config?.models ?? []);
        const first = bots.bots[0] ?? null;
        setBot(first);
        if (first) setDraft(draftOf(first));
        setChannels(chatChannels(list.channels));
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(errorKey(err));
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [serverId]);

  const dirty =
    !!bot &&
    (draft.name !== bot.name ||
      draft.color !== bot.color ||
      draft.face !== bot.face ||
      draft.tagline !== (bot.tagline ?? "") ||
      draft.persona !== bot.persona ||
      draft.knowledge !== bot.knowledge ||
      !sameSet(draft.channelIds, bot.channelIds) ||
      draft.answerToName !== bot.answerToName ||
      draft.model !== (bot.model ?? "") ||
      !sameSet(draft.tools, bot.tools) ||
      draft.welcomeEnabled !== bot.welcomeEnabled ||
      draft.welcomeChannelId !== (bot.welcomeChannelId ?? "") ||
      draft.welcomeMessage !== (bot.welcomeMessage ?? ""));
  const nameOk = draft.name.trim().length >= 2;
  const textChannels = channels.filter((channel) => channel.type === "text");

  const draftNow = useRef(draft);
  draftNow.current = draft;

  function edit(patch: Partial<Draft>) {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function save() {
    if (!bot) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    sentDraft.current = draft;
    try {
      const result = await updateServerBot(serverId, bot.id, {
        name: draft.name.trim(),
        color: draft.color,
        face: draft.face,
        tagline: draft.tagline.trim() || null,
        persona: draft.persona,
        knowledge: draft.knowledge,
        channelIds: draft.channelIds,
        answerToName: draft.answerToName,
        model: draft.model || null,
        tools: draft.tools,
        welcomeEnabled: draft.welcomeEnabled,
        welcomeChannelId: draft.welcomeChannelId || null,
        welcomeMessage: draft.welcomeMessage.trim() || null,
      });
      setBot(result.bot);
      // Untouched since Save: take the server's copy. Edited meanwhile: keep
      // the edit, which then reads as unsaved against the new bot.
      const untouched = draftNow.current === sentDraft.current;
      if (untouched) setDraft(draftOf(result.bot));
      setMissing(parsePermissions(result.missingPermissions ?? "0"));
      setSaved(untouched);
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!bot || toggling) return;
    setError(null);
    setToggling(true);
    try {
      const result = await updateServerBot(serverId, bot.id, { enabled });
      setBot(result.bot);
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setToggling(false);
    }
  }

  async function remove() {
    if (!bot) return;
    setError(null);
    try {
      await deleteServerBot(serverId, bot.id);
      setBot(null);
      setDraft(EMPTY_DRAFT);
    } catch (err) {
      setError(errorKey(err));
    }
  }

  if (!loaded) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label={t("serverSettings.bots.loading")}>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!bot && error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {t(error)}
      </p>
    );
  }

  if (!bot) {
    return (
      <>
        <BotInvite onCreate={onCreate} />
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {t(error)}
          </p>
        )}
      </>
    );
  }

  const off = !bot.enabled;
  return (
    <div className="space-y-6 pb-4">
      <header className="flex flex-wrap items-start gap-4">
        <span className="relative shrink-0">
          <BotFace
            color={draft.color}
            face={off ? "dormindo" : draft.face}
            variant="full"
            title={bot.name}
            className="h-16 w-16"
          />
          {!off && (
            <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-success ring-2 ring-[var(--color-surface-1)] redesign:bottom-1 redesign:right-1 redesign:ring-[color:var(--settings-pane-bg)]" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate font-display text-2xl font-extrabold text-text">
            {bot.name}
            <ServerBotTags />
          </p>
          <p className="truncate text-sm text-text-tertiary">
            @{bot.username}
            {overview?.creatorName
              ? ` · ${t("bots.settings.createdBy", { name: overview.creatorName, date: formatDay(bot.createdAt, locale) })}`
              : ""}
          </p>
          <button
            type="button"
            className="mt-1 text-sm font-semibold text-accent hover:underline"
            onClick={() => setTab("voice")}
          >
            {t("bots.settings.editFace")}
          </button>
        </div>
        <div className={cn(CARD_SURFACE, "flex shrink-0 items-center gap-4 px-4 py-3")}>
          <div>
            <p className="text-sm font-semibold text-text">
              {off ? t("bots.settings.asleep") : t("bots.settings.awake")}
            </p>
            <p className="whitespace-nowrap text-xs text-text-tertiary redesign:text-text-secondary">
              {off ? t("bots.settings.asleepHint") : t("bots.settings.awakeHint")}
            </p>
          </div>
          <Switch
            checked={bot.enabled}
            disabled={toggling}
            onCheckedChange={(on) => void setEnabled(on)}
            label={t("serverSettings.bots.enabled")}
            hideLabel
          />
        </div>
      </header>

      {missing !== 0n && (
        <SettingsNotice tone="warning" title={t("bots.settings.missingTitle")}>
          {t("bots.settings.missingBody", { name: bot.name })}
        </SettingsNotice>
      )}

      <BotTabs value={tab} onChange={setTab} />

      {tab === "overview" && <BotOverviewPanel bot={bot} overview={overview} channels={channels} onOpenPowers={() => setTab("powers")} />}

      {tab === "voice" && (
        <>

      <SettingsGroup title={t("bots.settings.group.face")}>
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <label htmlFor={ids.name} className="text-sm font-medium text-text">
              {t("serverSettings.bots.name")}
            </label>
            <Input
              id={ids.name}
              value={draft.name}
              maxLength={SERVER_BOT_NAME_MAX}
              onChange={(e) => edit({ name: e.target.value })}
            />
          </div>
          <RadioChoices
            label={t("bots.wizard.face.color")}
            values={BOT_COLORS}
            value={draft.color}
            onChange={(color) => edit({ color })}
            itemLabel={(color) => t(`bots.color.${color}`)}
            itemClassName={(selected) =>
              cn(
                "grid h-10 w-10 place-items-center rounded-full border-2 bg-surface-2",
                selected ? "border-text" : "border-transparent",
                BOT_SWATCH_REDESIGN,
                selected && BOT_SWATCH_CHOSEN_REDESIGN,
                BOT_CHOICE_FOCUS_REDESIGN,
                BOT_RING_OFFSET_PANE_REDESIGN,
              )
            }
            renderItem={(color, selected) => (
              <>
                <BotFace color={color} face="oi" live={false} className="h-7 w-7" />
                {selected && <ChosenCheck corner="bottom" />}
              </>
            )}
          />
          <RadioChoices
            label={t("bots.wizard.face.face")}
            values={BOT_BASE_FACES}
            value={draft.face}
            onChange={(face) => edit({ face })}
            itemClassName={(selected) =>
              cn(
                "flex w-16 flex-col items-center gap-1 rounded-[var(--radius-card)] border px-1 py-1.5 text-xs font-semibold",
                selected
                  ? "border-accent bg-accent-soft text-on-accent-soft"
                  : "border-border bg-surface-2 text-text-secondary",
                selected ? BOT_CARD_CHOSEN_REDESIGN : BOT_CARD_REDESIGN,
                BOT_CHOICE_FOCUS_REDESIGN,
                BOT_RING_OFFSET_PANE_REDESIGN,
              )
            }
            renderItem={(face, selected) => (
              <>
                <BotFace color={draft.color} face={face} live={false} className="h-8 w-8" />
                {t(`bots.face.${face}`)}
                {selected && <ChosenCheck />}
              </>
            )}
          />
          <div className="space-y-2">
            <label htmlFor={ids.tagline} className="text-sm font-medium text-text">
              {t("bots.wizard.face.tagline")}
            </label>
            <Input
              id={ids.tagline}
              value={draft.tagline}
              maxLength={80}
              placeholder={t("bots.wizard.face.taglinePlaceholder")}
              onChange={(e) => edit({ tagline: e.target.value })}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("bots.settings.group.voice")} description={t("serverSettings.bots.personaHint")}>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("serverSettings.bots.presets")}>
            {PERSONA_PRESETS.map((preset) => {
              const text = t(`serverSettings.bots.preset.${preset}.text`);
              const active = draft.persona === text;
              return (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-pressed={active}
                  className={cn(
                    active && "border-accent text-accent",
                    // Under the redesign a chosen preset is the selected pill, not accent text.
                    active && "redesign:border-transparent redesign:bg-[color:var(--list-row-selected)] redesign:text-text",
                  )}
                  onClick={() => edit({ persona: text })}
                >
                  {t(`serverSettings.bots.preset.${preset}.name`)}
                </Button>
              );
            })}
          </div>
          <Textarea
            id={ids.persona}
            aria-label={t("serverSettings.bots.persona")}
            value={draft.persona}
            maxLength={SERVER_BOT_PERSONA_MAX}
            placeholder={t("serverSettings.bots.personaPlaceholder")}
            onChange={(e) => edit({ persona: e.target.value })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("bots.settings.group.knows")} description={t("serverSettings.bots.knowledgeHint")}>
        <div className="space-y-2 p-4">
          <Textarea
            id={ids.knowledge}
            aria-label={t("serverSettings.bots.knowledge")}
            className="min-h-40"
            value={draft.knowledge}
            maxLength={SERVER_BOT_KNOWLEDGE_MAX}
            placeholder={t("serverSettings.bots.knowledgePlaceholder")}
            onChange={(e) => edit({ knowledge: e.target.value })}
          />
          <p className="text-right text-xs text-text-tertiary">
            {draft.knowledge.length.toLocaleString(intlLocale(locale))} /{" "}
            {SERVER_BOT_KNOWLEDGE_MAX.toLocaleString(intlLocale(locale))}
          </p>
        </div>
      </SettingsGroup>

        </>
      )}

      {tab === "powers" && (
        <>
      <SettingsGroup title={t("bots.settings.group.lives")} description={t("serverSettings.bots.channelsHint")}>
        <div className="space-y-3 p-2">
          <div className="max-h-64 overflow-y-auto">
            {channels.map((channel) => (
              <CheckRow
                key={channel.id}
                checked={draft.channelIds.includes(channel.id)}
                onCheckedChange={(on) =>
                  edit({
                    channelIds: on
                      ? [...draft.channelIds, channel.id]
                      : draft.channelIds.filter((id) => id !== channel.id),
                  })
                }
                label={channel.name}
                icon={channelIcon(channel)}
              />
            ))}
          </div>
          <div className="px-2 pb-2">
            <Switch
              checked={draft.answerToName}
              onCheckedChange={(on) => edit({ answerToName: on })}
              label={t("serverSettings.bots.answerToName")}
              description={t("serverSettings.bots.answerToNameHint", {
                name: draft.name.trim() || t("serverSettings.bots.namePlaceholderShort"),
              })}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("bots.welcome.title")} description={t("bots.welcome.hint")}>
        <div className="space-y-3 p-4">
          <Switch
            checked={draft.welcomeEnabled}
            onCheckedChange={(on) =>
              edit({
                welcomeEnabled: on,
                // Turning it on picks a channel, so it is never on and silent.
                ...(on && !draft.welcomeChannelId
                  ? { welcomeChannelId: textChannels.find((channel) => channel.id === draft.channelIds[0])?.id ?? textChannels[0]?.id ?? "" }
                  : {}),
              })
            }
            label={t("bots.welcome.toggle")}
            description={t("bots.welcome.free")}
          />
          {draft.welcomeEnabled && (
            <>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-text-secondary">{t("bots.welcome.channel")}</span>
                <Select
                  value={draft.welcomeChannelId}
                  raised
                  className="h-[var(--input-h,var(--control-md))]"
                  onChange={(e) => edit({ welcomeChannelId: e.target.value })}
                >
                  {textChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-text-secondary">{t("bots.welcome.message")}</span>
                <Textarea
                  value={draft.welcomeMessage}
                  maxLength={SERVER_BOT_WELCOME_MAX}
                  placeholder={SERVER_BOT_WELCOME_DEFAULT}
                  onChange={(e) => edit({ welcomeMessage: e.target.value })}
                />
                <span className="block text-xs text-text-tertiary">{t("bots.welcome.slots", { membro: "{membro}", servidor: "{servidor}" })}</span>
              </label>
            </>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("bots.settings.group.powers")} description={t("serverSettings.bots.toolsHint")} surface="plain">
        <ToolPicker tools={draft.tools} onChange={(tools) => edit({ tools })} />
      </SettingsGroup>

      {models.length > 1 && (
        <SettingsGroup title={t("serverSettings.bots.model")}>
          <div className="p-4">
            <Select
              id={ids.model}
              aria-label={t("serverSettings.bots.model")}
              value={draft.model}
              raised
              className="h-[var(--input-h,var(--control-md))]"
              onChange={(e) => edit({ model: e.target.value })}
            >
              <option value="">{t("serverSettings.bots.modelDefault", { model: models[0]!.label })}</option>
              {models.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("bots.settings.danger")}>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-text-secondary">
            {t("bots.settings.dangerBody", { name: bot.name })}
          </p>
          <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
            <IconSwap off={Trash2} on={Trash} offClassName="mr-2 h-4 w-4" />
            {t("serverSettings.bots.delete")}
          </Button>
        </div>
      </SettingsGroup>
        </>
      )}

      <p className="text-xs text-text-tertiary">{t("serverSettings.bots.howTo", { handle: `@${bot.username}` })}</p>

      <div className="sticky bottom-0">
        <UnsavedChangesBar
          visible={dirty || saving || saved}
          saving={saving}
          saved={saved && !dirty}
          error={error ? t(error) : null}
          onDiscard={() => setDraft(draftOf(bot))}
          onSave={() => {
            if (nameOk) void save();
          }}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t("serverSettings.bots.deleteTitle", { name: bot.name })}
        description={t("serverSettings.bots.deleteBody")}
        confirmLabel={t("serverSettings.bots.deleteConfirm")}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** No bot yet: what one is, why you would want it, and the door to the wizard. */
function BotInvite({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const cast: Array<[(typeof BOT_COLORS)[number], "dormindo" | "curioso" | "oi" | "kkkk" | "focado", string]> = [
    ["coral", "dormindo", "h-12 w-12"],
    ["mint", "curioso", "h-14 w-14"],
    ["lime", "oi", "h-24 w-24"],
    ["grape", "kkkk", "h-14 w-14"],
    ["sun", "focado", "h-12 w-12"],
  ];
  const features: Array<[typeof AtSign, PhosphorIcon, MessageKey, MessageKey]> = [
    [AtSign, At, "bots.invite.answers", "bots.invite.answersBody"],
    [ListChecks, ListChecksGlyph, "bots.invite.work", "bots.invite.workBody"],
    [ShieldCheck, ShieldCheckGlyph, "bots.invite.asks", "bots.invite.asksBody"],
  ];
  return (
    <section
      className={cn(
        CARD_SURFACE,
        "px-6 py-8 text-center",
        // Under the redesign the invite sits on the pane, like a page empty state.
        "redesign:border-0 redesign:bg-transparent redesign:shadow-none redesign:px-0",
      )}
    >
      <div className="flex items-end justify-center gap-3" aria-hidden="true">
        {cast.map(([color, face, size]) => (
          <BotFace key={color} color={color} face={face} variant="full" className={size} />
        ))}
      </div>
      <h2 className="mt-6 font-display text-3xl font-extrabold text-text">{t("bots.invite.title")}</h2>
      <p className="mx-auto mt-2 max-w-md text-text-secondary">{t("bots.invite.description")}</p>
      <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
        {features.map(([Icon, glyph, title, body]) => (
          <div
            key={title}
            className={cn(
              "rounded-[var(--radius-card)] border border-border bg-surface-2 p-3",
              // The invite has no frame under the redesign, so these are plain cards on the pane.
              "redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)]",
            )}
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-text redesign:items-start">
              <IconSwap off={Icon} on={glyph} offClassName="h-4 w-4 shrink-0 text-accent" className="mt-0.5 text-accent-text" />
              {t(title)}
            </p>
            <p className="mt-1 text-xs text-text-secondary redesign:pl-6">{t(body)}</p>
          </div>
        ))}
      </div>
      <Button type="button" className="mt-6" onClick={onCreate}>
        <IconSwap off={Sparkles} on={Sparkle} offClassName="mr-2 h-4 w-4" />
        {t("bots.invite.create")}
      </Button>
      <p className="mt-3 text-xs text-text-tertiary">{t("bots.invite.cost")}</p>
      <p className="mt-1 text-xs text-warning">{t("bots.beta.note")}</p>
    </section>
  );
}
