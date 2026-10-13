import {
  BOT_BASE_FACES,
  BOT_COLORS,
  SERVER_BOT_KNOWLEDGE_MAX,
  SERVER_BOT_NAME_MAX,
  SERVER_BOT_PERSONA_MAX,
  parsePermissions,
  type Channel,
  type ServerBotDto,
  type ServerBotModelChoice,
} from "@pqp/shared";
import { useEffect, useId, useState } from "react";
import { AtSign, ListChecks, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { BotFace } from "@/components/bots/bot-face";
import {
  EMPTY_BOT_DRAFT,
  PERSONA_PRESETS,
  ToolPicker,
  channelIcon,
  type BotDraft,
} from "@/components/bots/bot-wizard";
import { SettingsGroup, SettingsNotice } from "@/components/settings/kit";
import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  deleteServerBot,
  fetchBotsConfig,
  fetchChannels,
  fetchServerBots,
  updateServerBot,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/** The channels a bot can be put in: the ones people chat in. A forum covers its posts. */
function chatChannels(channels: Channel[]): Channel[] {
  return channels.filter(
    (c) => c.type === "text" || c.type === "voice" || c.type === "watch_party" || c.type === "forum",
  );
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
}

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
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_BOT_DRAFT, model: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [missing, setMissing] = useState(0n);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      !sameSet(draft.tools, bot.tools));
  const nameOk = draft.name.trim().length >= 2;

  function edit(patch: Partial<Draft>) {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function save() {
    if (!bot) return;
    setSaving(true);
    setError(null);
    setSaved(false);
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
      });
      setBot(result.bot);
      setDraft(draftOf(result.bot));
      setMissing(parsePermissions(result.missingPermissions ?? "0"));
      setSaved(true);
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!bot) return;
    setError(null);
    try {
      const result = await updateServerBot(serverId, bot.id, { enabled });
      setBot(result.bot);
    } catch (err) {
      setError(errorKey(err));
    }
  }

  async function remove() {
    if (!bot) return;
    setError(null);
    try {
      await deleteServerBot(serverId, bot.id);
      setBot(null);
      setDraft({ ...EMPTY_BOT_DRAFT, model: "" });
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
      <section className="flex items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface-card p-4">
        <BotFace
          color={draft.color}
          face={off ? "dormindo" : draft.face}
          variant="full"
          title={bot.name}
          className="h-16 w-16"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate font-semibold text-text">
            {bot.name}
            <BetaTag />
          </p>
          <p className="truncate text-sm text-text-tertiary">
            @{bot.username}
            {bot.tagline ? ` · ${bot.tagline}` : ""}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {off
              ? t("bots.settings.sleeping", { name: bot.name })
              : t("bots.settings.usage", { used: bot.repliesToday, max: bot.repliesPerDay })}
          </p>
        </div>
        <div className="shrink-0">
          <Switch
            checked={bot.enabled}
            onCheckedChange={(on) => void setEnabled(on)}
            label={t("serverSettings.bots.enabled")}
            hideLabel
          />
        </div>
      </section>

      {missing !== 0n && (
        <SettingsNotice tone="warning" title={t("bots.settings.missingTitle")}>
          {t("bots.settings.missingBody", { name: bot.name })}
        </SettingsNotice>
      )}

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
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("bots.wizard.face.color")}>
            {BOT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={draft.color === color}
                aria-label={t(`bots.color.${color}`)}
                onClick={() => edit({ color })}
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]",
                  draft.color === color ? "border-text" : "border-transparent",
                )}
              >
                <BotFace color={color} face="oi" live={false} className="h-7 w-7" />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("bots.wizard.face.face")}>
            {BOT_BASE_FACES.map((face) => (
              <button
                key={face}
                type="button"
                role="radio"
                aria-checked={draft.face === face}
                onClick={() => edit({ face })}
                className={cn(
                  "flex w-16 flex-col items-center gap-1 rounded-[var(--radius-card)] border px-1 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]",
                  draft.face === face
                    ? "border-accent bg-accent-soft text-on-accent-soft"
                    : "border-border bg-surface-2 text-text-secondary",
                )}
              >
                <BotFace color={draft.color} face={face} live={false} className="h-8 w-8" />
                {t(`bots.face.${face}`)}
              </button>
            ))}
          </div>
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
                  className={active ? "border-accent text-accent" : undefined}
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

      <SettingsGroup title={t("bots.settings.group.powers")} description={t("serverSettings.bots.toolsHint")} surface="plain">
        <ToolPicker tools={draft.tools} onChange={(tools) => edit({ tools })} />
      </SettingsGroup>

      {models.length > 1 && (
        <SettingsGroup title={t("serverSettings.bots.model")}>
          <div className="p-4">
            <select
              id={ids.model}
              aria-label={t("serverSettings.bots.model")}
              value={draft.model}
              className="h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
              onChange={(e) => edit({ model: e.target.value })}
            >
              <option value="">{t("serverSettings.bots.modelDefault", { model: models[0]!.label })}</option>
              {models.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        </SettingsGroup>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {t(error)}
        </p>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-surface-1 py-3">
        <Button type="button" disabled={!nameOk || !dirty || saving} onClick={() => void save()}>
          {t("serverSettings.bots.save")}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => setDraft(draftOf(bot))}>
            {t("bots.settings.discard")}
          </Button>
        )}
        {saved && !dirty && <span className="text-sm text-text-tertiary">{t("serverSettings.bots.saved")}</span>}
        <Button type="button" variant="danger" className="ml-auto" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="mr-2 h-4 w-4" aria-hidden />
          {t("serverSettings.bots.delete")}
        </Button>
      </div>

      <p className="text-xs text-text-tertiary">{t("serverSettings.bots.howTo", { handle: `@${bot.username}` })}</p>

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
  const features: Array<[typeof AtSign, MessageKey, MessageKey]> = [
    [AtSign, "bots.invite.answers", "bots.invite.answersBody"],
    [ListChecks, "bots.invite.work", "bots.invite.workBody"],
    [ShieldCheck, "bots.invite.asks", "bots.invite.asksBody"],
  ];
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface-card px-6 py-8 text-center">
      <div className="flex items-end justify-center gap-3" aria-hidden="true">
        {cast.map(([color, face, size]) => (
          <BotFace key={color} color={color} face={face} variant="full" className={size} />
        ))}
      </div>
      <h2 className="mt-6 font-display text-3xl font-extrabold text-text">{t("bots.invite.title")}</h2>
      <p className="mx-auto mt-2 max-w-md text-text-secondary">{t("bots.invite.description")}</p>
      <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
        {features.map(([Icon, title, body]) => (
          <div key={title} className="rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-text">
              <Icon className="h-4 w-4 text-accent" aria-hidden />
              {t(title)}
            </p>
            <p className="mt-1 text-xs text-text-secondary">{t(body)}</p>
          </div>
        ))}
      </div>
      <Button type="button" className="mt-6" onClick={onCreate}>
        <Sparkles className="mr-2 h-4 w-4" aria-hidden />
        {t("bots.invite.create")}
      </Button>
      <p className="mt-3 text-xs text-text-tertiary">{t("bots.invite.cost")}</p>
      <p className="mt-1 text-xs text-warning">{t("bots.beta.note")}</p>
    </section>
  );
}
