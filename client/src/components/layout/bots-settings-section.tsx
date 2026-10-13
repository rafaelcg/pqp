import {
  SERVER_BOT_DEFAULT_TOOLS,
  SERVER_BOT_KNOWLEDGE_MAX,
  SERVER_BOT_NAME_MAX,
  SERVER_BOT_PERSONA_MAX,
  SERVER_BOT_TOOL_GROUPS,
  type Channel,
  type ServerBotTool,
  type ServerBotToolGroup,
  type ServerBotDto,
  type ServerBotModelChoice,
} from "@pqp/shared";
import { useEffect, useId, useState } from "react";
import { Bot, Hash, MessagesSquare, Trash2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  createServerBot,
  deleteServerBot,
  fetchBotsConfig,
  fetchChannels,
  fetchServerBots,
  updateServerBot,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";

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

interface Draft {
  name: string;
  persona: string;
  knowledge: string;
  channelIds: string[];
  answerToName: boolean;
  /** Empty string is "the default model". */
  model: string;
  tools: ServerBotTool[];
}

/** Starting points for the persona. The text is per language, in the locales. */
const PERSONA_PRESETS = ["friendly", "playful", "support", "moderator", "gamer", "narrator"] as const;

const TOOL_GROUPS = Object.entries(SERVER_BOT_TOOL_GROUPS) as Array<
  [ServerBotToolGroup, readonly ServerBotTool[]]
>;

const EMPTY: Draft = {
  name: "",
  persona: "",
  knowledge: "",
  channelIds: [],
  answerToName: false,
  model: "",
  tools: [...SERVER_BOT_DEFAULT_TOOLS],
};

function draftOf(bot: ServerBotDto): Draft {
  return {
    name: bot.name,
    persona: bot.persona,
    knowledge: bot.knowledge,
    channelIds: bot.channelIds,
    answerToName: bot.answerToName,
    model: bot.model ?? "",
    tools: bot.tools,
  };
}

/** Order-free comparison: the switches can be flipped in any order. */
function sameTools(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tool) => b.includes(tool));
}

/**
 * Server settings → Bots. One bot per server for now: an empty page offers to
 * create it, and once it exists the same form edits it. Mentioning the bot,
 * or replying to it, in a ticked channel is what makes it answer.
 */
export function BotsSettingsSection({ serverId }: { serverId: string }) {
  const { t, locale } = useTranslation();
  const ids = { name: useId(), persona: useId(), knowledge: useId(), model: useId() };
  const [models, setModels] = useState<ServerBotModelChoice[]>([]);
  const [bot, setBot] = useState<ServerBotDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setBot(null);
    setDraft(EMPTY);
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
        setDraft(first ? draftOf(first) : EMPTY);
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
    !bot ||
    draft.name !== bot.name ||
    draft.persona !== bot.persona ||
    draft.knowledge !== bot.knowledge ||
    draft.channelIds.join() !== bot.channelIds.join() ||
    draft.answerToName !== bot.answerToName ||
    draft.model !== (bot.model ?? "") ||
    !sameTools(draft.tools, bot.tools);
  const nameOk = draft.name.trim().length >= 2;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body = {
        name: draft.name.trim(),
        persona: draft.persona,
        knowledge: draft.knowledge,
        channelIds: draft.channelIds,
        answerToName: draft.answerToName,
        model: draft.model || null,
        tools: draft.tools,
      };
      const result = bot
        ? await updateServerBot(serverId, bot.id, body)
        : await createServerBot(serverId, body);
      setBot(result.bot);
      setDraft(draftOf(result.bot));
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
      setDraft(EMPTY);
    } catch (err) {
      setError(errorKey(err));
    }
  }

  function toggleChannel(channelId: string, on: boolean) {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      channelIds: on
        ? [...d.channelIds, channelId]
        : d.channelIds.filter((id) => id !== channelId),
    }));
  }

  function toggleTool(tool: ServerBotTool, on: boolean) {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      tools: on ? [...d.tools, tool] : d.tools.filter((name) => name !== tool),
    }));
  }

  if (!loaded) {
    return <p className="text-sm text-text-tertiary">{t("serverSettings.bots.loading")}</p>;
  }

  return (
    <div className="space-y-6">
      {bot ? (
        <section className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2">
            <Bot className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-text">{bot.name}</p>
            <p className="truncate text-sm text-text-tertiary">
              {t("serverSettings.bots.usage", {
                handle: `@${bot.username}`,
                used: bot.repliesToday,
                max: bot.repliesPerDay,
              })}
            </p>
          </div>
          <Switch
            checked={bot.enabled}
            onCheckedChange={(on) => void setEnabled(on)}
            label={t("serverSettings.bots.enabled")}
            hideLabel
          />
        </section>
      ) : (
        <p className="text-sm text-text-secondary">{t("serverSettings.bots.intro")}</p>
      )}

      <div className="space-y-2">
        <label htmlFor={ids.name} className="text-sm font-medium text-text">
          {t("serverSettings.bots.name")}
        </label>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={SERVER_BOT_NAME_MAX}
          placeholder={t("serverSettings.bots.namePlaceholder")}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, name: e.target.value }));
          }}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor={ids.persona} className="text-sm font-medium text-text">
          {t("serverSettings.bots.persona")}
        </label>
        <p className="text-xs text-text-tertiary">{t("serverSettings.bots.personaHint")}</p>
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
                onClick={() => {
                  setSaved(false);
                  setDraft((d) => ({ ...d, persona: text }));
                }}
              >
                {t(`serverSettings.bots.preset.${preset}.name`)}
              </Button>
            );
          })}
        </div>
        <Textarea
          id={ids.persona}
          value={draft.persona}
          maxLength={SERVER_BOT_PERSONA_MAX}
          placeholder={t("serverSettings.bots.personaPlaceholder")}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, persona: e.target.value }));
          }}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor={ids.knowledge} className="text-sm font-medium text-text">
          {t("serverSettings.bots.knowledge")}
        </label>
        <p className="text-xs text-text-tertiary">{t("serverSettings.bots.knowledgeHint")}</p>
        <Textarea
          id={ids.knowledge}
          className="min-h-40"
          value={draft.knowledge}
          maxLength={SERVER_BOT_KNOWLEDGE_MAX}
          placeholder={t("serverSettings.bots.knowledgePlaceholder")}
          onChange={(e) => {
            setSaved(false);
            setDraft((d) => ({ ...d, knowledge: e.target.value }));
          }}
        />
        <p className="text-right text-xs text-text-tertiary">
          {draft.knowledge.length.toLocaleString(intlLocale(locale))} /{" "}
          {SERVER_BOT_KNOWLEDGE_MAX.toLocaleString(intlLocale(locale))}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-text">{t("serverSettings.bots.channels")}</p>
        <p className="text-xs text-text-tertiary">{t("serverSettings.bots.channelsHint")}</p>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-1">
          {channels.map((channel) => (
            <CheckRow
              key={channel.id}
              checked={draft.channelIds.includes(channel.id)}
              onCheckedChange={(on) => toggleChannel(channel.id, on)}
              label={channel.name}
              icon={
                channel.type === "text" ? (
                  <Hash className="h-4 w-4" aria-hidden />
                ) : channel.type === "forum" ? (
                  <MessagesSquare className="h-4 w-4" aria-hidden />
                ) : (
                  <Volume2 className="h-4 w-4" aria-hidden />
                )
              }
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-text">{t("serverSettings.bots.tools")}</p>
        <p className="text-xs text-text-tertiary">{t("serverSettings.bots.toolsHint")}</p>
        <div className="space-y-3 rounded-lg border border-border p-2">
          {TOOL_GROUPS.map(([group, tools]) => (
            <div key={group}>
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                {t(`serverSettings.bots.toolGroup.${group}`)}
              </p>
              {tools.map((tool) => (
                <CheckRow
                  key={tool}
                  checked={draft.tools.includes(tool)}
                  onCheckedChange={(on) => toggleTool(tool, on)}
                  label={t(`serverSettings.bots.tool.${tool}`)}
                />
              ))}
              {group === "lookup" && (
                <CheckRow
                  checked={false}
                  disabled
                  onCheckedChange={() => {}}
                  label={t("serverSettings.bots.tool.webSearch")}
                  description={t("serverSettings.bots.comingSoon")}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {models.length > 1 && (
        <div className="space-y-2">
          <label htmlFor={ids.model} className="text-sm font-medium text-text">
            {t("serverSettings.bots.model")}
          </label>
          <select
            id={ids.model}
            value={draft.model}
            className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50"
            onChange={(e) => {
              setSaved(false);
              const model = e.target.value;
              setDraft((d) => ({ ...d, model }));
            }}
          >
            <option value="">
              {t("serverSettings.bots.modelDefault", { model: models[0]!.label })}
            </option>
            {models.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <Switch
        checked={draft.answerToName}
        onCheckedChange={(on) => {
          setSaved(false);
          setDraft((d) => ({ ...d, answerToName: on }));
        }}
        label={t("serverSettings.bots.answerToName")}
        description={t("serverSettings.bots.answerToNameHint", {
          name: draft.name.trim() || t("serverSettings.bots.namePlaceholderShort"),
        })}
      />

      {error && (
        <p role="alert" className="text-sm text-danger">
          {t(error)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={!nameOk || !dirty || saving} onClick={() => void save()}>
          {bot ? t("serverSettings.bots.save") : t("serverSettings.bots.create")}
        </Button>
        {saved && !dirty && (
          <span className="text-sm text-text-tertiary">{t("serverSettings.bots.saved")}</span>
        )}
        {bot && (
          <Button
            type="button"
            variant="danger"
            className="ml-auto"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            {t("serverSettings.bots.delete")}
          </Button>
        )}
      </div>

      {bot && (
        <p className="text-xs text-text-tertiary">
          {t("serverSettings.bots.howTo", { handle: `@${bot.username}` })}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t("serverSettings.bots.deleteTitle", { name: bot?.name ?? "" })}
        description={t("serverSettings.bots.deleteBody")}
        confirmLabel={t("serverSettings.bots.deleteConfirm")}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
