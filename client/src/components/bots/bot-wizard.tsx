import {
  BOT_BASE_FACES,
  BOT_COLORS,
  BOT_DEFAULT_COLOR,
  BOT_DEFAULT_FACE,
  SERVER_BOT_DEFAULT_TOOLS,
  SERVER_BOT_KNOWLEDGE_MAX,
  SERVER_BOT_NAME_MAX,
  SERVER_BOT_PERSONA_MAX,
  SERVER_BOT_TOOL_GROUPS,
  botActionCardSchema,
  parsePermissions,
  type BotBaseFace,
  type BotColor,
  type Channel,
  type ServerBotDto,
  type ServerBotTool,
  type ServerBotToolGroup,
} from "@pqp/shared";
import { useEffect, useId, useRef, useState } from "react";
import {
  AlarmClock,
  ArrowLeft,
  ArrowRight,
  Ban,
  ChevronDown,
  Hash,
  Image as ImageIcon,
  MessagesSquare,
  Search,
  Send,
  ShieldCheck,
  Shuffle,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { BotFace } from "@/components/bots/bot-face";
import { BotActionCard } from "@/components/chat/bot-action-card";
import { ServerBotTags } from "@/components/bots/server-bot-tags";
import { RadioChoices } from "@/components/bots/radio-choices";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Confetti } from "@/components/onboarding/confetti";
import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, createServerBot, fetchBotsConfig, fetchChannels, postBotIntro, testServerBot } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/**
 * Creating a server bot, one question at a time, with the bot on stage the
 * whole way: it takes its name, colour and face first, so every later answer
 * is given to somebody. The card under it fills in as the steps do. The last
 * step is the bot arriving, and saying how to call it.
 */

const STEPS = ["face", "voice", "knows", "lives", "powers"] as const;
/** The practice chat, when the server has it (flag `bot_test_chat`). */
type FlowStep = (typeof STEPS)[number] | "test";
type Step = FlowStep | "born";

export const PERSONA_PRESETS = ["friendly", "playful", "support", "moderator", "gamer", "narrator"] as const;
const NAME_IDEAS = ["Tico", "Bolota", "Pixel", "Faísca", "Madruga"] as const;

const TOOL_GROUPS = Object.entries(SERVER_BOT_TOOL_GROUPS) as Array<
  [ServerBotToolGroup, readonly ServerBotTool[]]
>;

export interface BotDraft {
  name: string;
  color: BotColor;
  face: BotBaseFace;
  tagline: string;
  persona: string;
  knowledge: string;
  channelIds: string[];
  answerToName: boolean;
  tools: ServerBotTool[];
}

export const EMPTY_BOT_DRAFT: BotDraft = {
  name: "",
  color: BOT_DEFAULT_COLOR,
  face: BOT_DEFAULT_FACE,
  tagline: "",
  persona: "",
  knowledge: "",
  channelIds: [],
  answerToName: false,
  tools: [...SERVER_BOT_DEFAULT_TOOLS],
};

export function channelIcon(channel: Channel) {
  if (channel.type === "text") return <Hash className="h-4 w-4" aria-hidden />;
  if (channel.type === "forum") return <MessagesSquare className="h-4 w-4" aria-hidden />;
  return <Volume2 className="h-4 w-4" aria-hidden />;
}

interface BotWizardProps {
  open: boolean;
  serverId: string;
  serverName: string;
  onClose: () => void;
  /** "Ajustar": back to the bot's page in server settings. */
  onAdjust: () => void;
}

/** The channels a bot can live in: the ones people chat in. A forum covers its posts. */
function chatChannels(channels: Channel[]): Channel[] {
  return channels.filter(
    (c) => c.type === "text" || c.type === "voice" || c.type === "watch_party" || c.type === "forum",
  );
}

export function BotWizard({ open, serverId, serverName, onClose, onAdjust }: BotWizardProps) {
  const { t } = useTranslation();
  const ids = { name: useId(), tagline: useId(), persona: useId(), knowledge: useId() };
  const [step, setStep] = useState<Step>("face");
  const [draft, setDraft] = useState<BotDraft>(EMPTY_BOT_DRAFT);
  const [pop, setPop] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [created, setCreated] = useState<ServerBotDto | null>(null);
  const [missing, setMissing] = useState(0n);
  const scroller = useRef<HTMLDivElement>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [testChat, setTestChat] = useState(false);
  const [testTurnsPerDay, setTestTurnsPerDay] = useState(0);
  // A create that answers after the wizard was closed must not reopen it at "born".
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchChannels(serverId)
      .then((list) => {
        if (live) setChannels(chatChannels(list.channels));
      })
      .catch(() => {});
    void fetchBotsConfig(serverId)
      .then((config) => {
        if (!live) return;
        setTestChat(config.testChat);
        setTestTurnsPerDay(config.testTurnsPerDay);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, serverId]);

  // Each step starts at its top, not where the last one was scrolled to.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [step]);

  const steps: readonly FlowStep[] = testChat ? [...STEPS, "test"] : STEPS;
  const lastStep = steps[steps.length - 1]!;
  const index = step === "born" ? steps.length : steps.indexOf(step);
  const name = draft.name.trim();
  const shownName = name || t("bots.wizard.unnamed");
  // Two letters or digits, so an emoji or a pair of spaces is not a name.
  const nameOk = (name.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2;
  const touched =
    draft.name !== EMPTY_BOT_DRAFT.name ||
    draft.persona !== "" ||
    draft.knowledge !== "" ||
    draft.tagline !== "" ||
    draft.channelIds.length > 0;

  function update(patch: Partial<BotDraft>, bounce = false) {
    setDraft((d) => ({ ...d, ...patch }));
    if (bounce) setPop((n) => n + 1);
  }

  /** Escape, X: ask before throwing away answers; never mid-create. */
  function requestClose() {
    if (saving) return;
    if (step !== "born" && touched) {
      setConfirmDiscard(true);
      return;
    }
    close();
  }

  function close() {
    setConfirmDiscard(false);
    onClose();
    // Next time it opens from the start.
    setStep("face");
    setDraft(EMPTY_BOT_DRAFT);
    setCreated(null);
    setError(null);
  }

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const result = await createServerBot(serverId, {
        name,
        color: draft.color,
        face: draft.face,
        tagline: draft.tagline.trim() || null,
        persona: draft.persona,
        knowledge: draft.knowledge,
        channelIds: draft.channelIds,
        answerToName: draft.answerToName,
        tools: draft.tools,
      });
      if (!openRef.current) return;
      const lacking = parsePermissions(result.missingPermissions ?? "0");
      setCreated(result.bot);
      setMissing(lacking);
      setStep("born");
    } catch (err) {
      const nameTaken = err instanceof ApiError && err.status === 409 && err.message.includes("name");
      setError(
        nameTaken
          ? "serverSettings.bots.error.name"
          : err instanceof ApiError && err.status === 409
            ? "serverSettings.bots.error.limit"
            : err instanceof ApiError && err.status === 403
              ? "serverSettings.bots.error.disabled"
              : "serverSettings.bots.error.generic",
      );
      // The name is fixed on the first step, so that is where its error goes.
      if (nameTaken) setStep("face");
    } finally {
      setSaving(false);
    }
  }

  const next = () => {
    if (step === lastStep) {
      void create();
      return;
    }
    const at = steps.indexOf(step as FlowStep);
    setStep(steps[at + 1]!);
  };
  const back = () => {
    const at = steps.indexOf(step as FlowStep);
    if (at > 0) setStep(steps[at - 1]!);
  };
  const canContinue = step === "face" ? nameOk : true;
  const stageFace: BotBaseFace | "kkkk" = step === "born" ? "kkkk" : draft.face;

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      size="full"
      fill
      closeOnBackdrop={false}
      title={
        <span className="flex items-center gap-2">
          {step === "born" ? shownName : t("bots.wizard.title")}
          <BetaTag />
        </span>
      }
      description={t("bots.wizard.subtitle", { server: serverName })}
      footer={
        step === "born" ? (
          <div className="flex w-full flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                close();
                onAdjust();
              }}
            >
              {t("bots.wizard.adjust", { name: shownName })}
            </Button>
            <Button type="button" onClick={close}>
              {t("bots.wizard.done")}
            </Button>
          </div>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-2">
            {error && (
              <p role="alert" className="w-full text-sm text-danger">
                {t(error)}
              </p>
            )}
            {index > 0 ? (
              <Button type="button" variant="ghost" onClick={back}>
                <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
                {t("bots.wizard.back")}
              </Button>
            ) : null}
            <span className="ml-auto hidden text-sm text-text-tertiary sm:inline">
              {t("bots.wizard.changeLater")}
            </span>
            <Button
              type="button"
              disabled={!canContinue || saving}
              onClick={next}
              className="max-sm:ml-auto"
            >
              {step === lastStep ? t("bots.wizard.create", { name: shownName }) : t("bots.wizard.next")}
              {step !== lastStep && <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />}
            </Button>
          </div>
        )
      }
    >
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 sm:px-6">
          {step !== "born" && (
            <ol
              className={cn("mb-6 grid gap-1.5", steps.length === 6 ? "grid-cols-6" : "grid-cols-5")} aria-label={t("bots.wizard.progress")}>
              {steps.map((s, i) => (
                <li key={s} aria-current={s === step ? "step" : undefined}>
                  <span
                    className={cn(
                      "block h-1 rounded-full transition-colors duration-[var(--duration-base)]",
                      i <= index ? "bg-accent" : "bg-surface-3",
                    )}
                  />
                  <span
                    className={cn(
                      "mt-1.5 block truncate text-xs",
                      s === step ? "font-semibold text-text" : "text-text-tertiary",
                    )}
                  >
                    {t(`bots.wizard.step.${s}`)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <div key={step} className="bot-step-in space-y-5">
            {step === "face" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 1, total: steps.length })}
                  title={t("bots.wizard.face.title")}
                  description={t("bots.wizard.face.description")}
                />
                <div className="space-y-2">
                  <label htmlFor={ids.name} className="text-sm font-medium text-text">
                    {t("serverSettings.bots.name")}
                  </label>
                  <Input
                    id={ids.name}
                    autoFocus
                    value={draft.name}
                    maxLength={SERVER_BOT_NAME_MAX}
                    placeholder={t("serverSettings.bots.namePlaceholder")}
                    onChange={(e) => update({ name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && nameOk) next();
                    }}
                  />
                  <p className="text-xs text-text-tertiary">
                    {nameOk
                      ? t("bots.wizard.face.handle", { handle: `@${handlePreview(name)}` })
                      : t("bots.wizard.face.nameHint")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {NAME_IDEAS.map((idea) => (
                      <Button
                        key={idea}
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => update({ name: idea }, true)}
                      >
                        {idea}
                      </Button>
                    ))}
                  </div>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-text">{t("bots.wizard.face.color")}</legend>
                  <RadioChoices
                    label={t("bots.wizard.face.color")}
                    values={BOT_COLORS}
                    value={draft.color}
                    onChange={(color) => update({ color }, true)}
                    itemLabel={(color) => t(`bots.color.${color}`)}
                    itemClassName={(selected) =>
                      cn(
                        "grid h-11 w-11 place-items-center rounded-full border-2 bg-surface-2 transition-transform duration-[var(--duration-fast)] active:scale-95",
                        selected ? "border-text" : "border-transparent",
                      )
                    }
                    renderItem={(color) => <BotFace color={color} face="oi" live={false} className="h-8 w-8" />}
                  />
                </fieldset>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-text">{t("bots.wizard.face.face")}</legend>
                  <div className="flex flex-wrap gap-2">
                    <RadioChoices
                      label={t("bots.wizard.face.face")}
                      values={BOT_BASE_FACES}
                      value={draft.face}
                      onChange={(face) => update({ face }, true)}
                      itemClassName={(selected) =>
                        cn(
                          "flex w-[4.5rem] flex-col items-center gap-1 rounded-[var(--radius-card)] border px-2 py-2 text-xs font-semibold transition-colors duration-[var(--duration-fast)]",
                          selected
                            ? "border-accent bg-accent-soft text-on-accent-soft"
                            : "border-border bg-surface-2 text-text-secondary hover:text-text",
                        )
                      }
                      renderItem={(face) => (
                        <>
                          <BotFace color={draft.color} face={face} live={false} className="h-9 w-9" />
                          {t(`bots.face.${face}`)}
                        </>
                      )}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-auto self-stretch"
                      onClick={() => {
                        const color = BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)]!;
                        const face = BOT_BASE_FACES[Math.floor(Math.random() * BOT_BASE_FACES.length)]!;
                        update({ color, face }, true);
                      }}
                    >
                      <Shuffle className="mr-1.5 h-4 w-4" aria-hidden />
                      {t("bots.wizard.face.surprise")}
                    </Button>
                  </div>
                </fieldset>

                <div className="space-y-2">
                  <label htmlFor={ids.tagline} className="text-sm font-medium text-text">
                    {t("bots.wizard.face.tagline")}
                  </label>
                  <Input
                    id={ids.tagline}
                    value={draft.tagline}
                    maxLength={80}
                    placeholder={t("bots.wizard.face.taglinePlaceholder")}
                    onChange={(e) => update({ tagline: e.target.value })}
                  />
                  <Counter value={draft.tagline.length} max={80} />
                </div>
              </>
            )}

            {step === "voice" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 2, total: steps.length })}
                  title={t("bots.wizard.voice.title", { name: shownName })}
                  description={t("bots.wizard.voice.description")}
                />
                <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t("serverSettings.bots.presets")}>
                  {PERSONA_PRESETS.map((preset) => {
                    const text = t(`serverSettings.bots.preset.${preset}.text`);
                    const active = draft.persona === text;
                    return (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={active}
                        onClick={() => update({ persona: text }, true)}
                        className={cn(
                          "rounded-[var(--radius-card)] border p-3 text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]",
                          active
                            ? "border-accent bg-accent-soft text-on-accent-soft"
                            : "border-border bg-surface-2 hover:border-border-strong",
                        )}
                      >
                        <span className="block text-sm font-semibold">
                          {t(`serverSettings.bots.preset.${preset}.name`)}
                        </span>
                        <span className={cn("mt-0.5 line-clamp-2 text-xs", !active && "text-text-tertiary")}>
                          {text}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-2">
                  <label htmlFor={ids.persona} className="text-sm font-medium text-text">
                    {t("bots.wizard.voice.own")}
                  </label>
                  <Textarea
                    id={ids.persona}
                    value={draft.persona}
                    maxLength={SERVER_BOT_PERSONA_MAX}
                    placeholder={t("serverSettings.bots.personaPlaceholder")}
                    onChange={(e) => update({ persona: e.target.value })}
                  />
                  <Counter value={draft.persona.length} max={SERVER_BOT_PERSONA_MAX} />
                </div>
              </>
            )}

            {step === "knows" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 3, total: steps.length })}
                  title={t("bots.wizard.knows.title", { name: shownName })}
                  description={t("bots.wizard.knows.description")}
                />
                <Textarea
                  id={ids.knowledge}
                  aria-label={t("serverSettings.bots.knowledge")}
                  className="min-h-48"
                  value={draft.knowledge}
                  maxLength={SERVER_BOT_KNOWLEDGE_MAX}
                  placeholder={t("serverSettings.bots.knowledgePlaceholder")}
                  onChange={(e) => update({ knowledge: e.target.value })}
                />
                <div className="flex gap-3">
                  <p className="flex-1 text-xs text-text-tertiary">{t("bots.wizard.knows.hint")}</p>
                  <Counter value={draft.knowledge.length} max={SERVER_BOT_KNOWLEDGE_MAX} />
                </div>
              </>
            )}

            {step === "lives" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 4, total: steps.length })}
                  title={t("bots.wizard.lives.title", { name: shownName })}
                  description={t("bots.wizard.lives.description")}
                />
                <div className="max-h-72 overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface-card p-1">
                  {channels.map((channel) => (
                    <CheckRow
                      key={channel.id}
                      checked={draft.channelIds.includes(channel.id)}
                      onCheckedChange={(on) =>
                        update({
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
                {draft.channelIds.length === 0 && (
                  <p className="rounded-[var(--radius-card)] bg-warning-soft p-3 text-sm text-on-warning-soft">
                    {t("bots.wizard.lives.none", { name: shownName })}
                  </p>
                )}
                <Switch
                  checked={draft.answerToName}
                  onCheckedChange={(on) => update({ answerToName: on })}
                  label={t("serverSettings.bots.answerToName")}
                  description={t("serverSettings.bots.answerToNameHint", { name: shownName })}
                />
              </>
            )}

            {step === "powers" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 5, total: steps.length })}
                  title={t("bots.wizard.powers.title", { name: shownName })}
                  description={t("bots.wizard.powers.description", { name: shownName })}
                />
                <ToolPicker
                  tools={draft.tools}
                  onChange={(tools) => update({ tools })}
                />
              </>
            )}

            {step === "test" && (
              <>
                <StepTitle
                  eyebrow={t("bots.wizard.stepOf", { n: 6, total: steps.length })}
                  title={t("bots.wizard.test.title", { name: shownName })}
                  description={t("bots.wizard.test.description")}
                />
                <TestChat serverId={serverId} draft={draft} name={shownName} perDay={testTurnsPerDay} />
              </>
            )}

            {step === "born" && created && (
              <div className="space-y-4">
                <p className="text-xs font-bold uppercase tracking-wide text-text-tertiary">
                  {t("bots.wizard.born.eyebrow")}
                </p>
                <h2 className="font-display text-3xl font-extrabold text-text">
                  {t("bots.wizard.born.title", { name: created.name })}
                </h2>
                <p className="text-text-secondary">{t("bots.wizard.born.description")}</p>
                <ul className="space-y-2">
                  <HowTo title={t("bots.wizard.born.mention")} body={t("bots.wizard.born.mentionBody", { handle: `@${created.username}` })} />
                  <HowTo title={t("bots.wizard.born.reply")} body={t("bots.wizard.born.replyBody", { name: created.name })} />
                  <HowTo title={t("bots.wizard.born.work")} body={t("bots.wizard.born.workBody")} />
                </ul>
                <IntroPreview
                  bot={created}
                  serverId={serverId}
                  serverName={serverName}
                  channels={channels.filter((channel) => created.channelIds.includes(channel.id))}
                />
                {missing !== 0n && (
                  <p className="rounded-[var(--radius-card)] bg-warning-soft p-3 text-sm text-on-warning-soft">
                    {t("bots.wizard.born.missing", { name: created.name })}
                  </p>
                )}
                <p className="text-sm text-warning">{t("bots.beta.note")}</p>
              </div>
            )}
          </div>
        </div>

        <aside className="relative hidden w-[24rem] shrink-0 flex-col items-center justify-center gap-5 overflow-y-auto overflow-x-hidden border-l border-border bg-surface-0 px-6 py-8 md:flex">
          {step === "born" && <Confetti />}
          {step === "lives" ? (
            <StageChannels draft={draft} channels={channels} name={shownName} serverName={serverName} />
          ) : step === "powers" ? (
            <StagePlan draft={draft} name={shownName} />
          ) : (
            <>
              <p className="max-w-[16rem] rounded-[var(--radius-card)] bg-surface-2 px-3 py-2 text-center text-sm font-medium text-text">
                {step === "born"
                  ? t("bots.wizard.stage.born")
                  : nameOk
                    ? t("bots.wizard.stage.hello", { name })
                    : t("bots.wizard.stage.waiting")}
              </p>
              <BotFace
                key={pop}
                color={draft.color}
                face={stageFace}
                variant="full"
                title={shownName}
                className="bot-face-pop h-48 w-48"
              />
            </>
          )}
          <IdCard draft={draft} name={shownName} />
        </aside>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title={t("bots.wizard.discard.title")}
        description={t("bots.wizard.discard.body", { name: shownName })}
        confirmLabel={t("bots.wizard.discard.confirm")}
        onConfirm={close}
        onClose={() => setConfirmDiscard(false)}
      />
    </Dialog>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  const { locale } = useTranslation();
  return (
    <p className={cn("shrink-0 text-right text-xs", value >= max ? "text-warning" : "text-text-tertiary")}>
      {value.toLocaleString(intlLocale(locale))} / {max.toLocaleString(intlLocale(locale))}
    </p>
  );
}

/** Breu holding on to the top edge of a card, looking at what is in it. */
function Peeker({ color, face }: { color: BotDraft["color"]; face: "focado" | "curioso" | "oi" }) {
  return (
    <BotFace
      color={color}
      face={face}
      variant="full"
      className="pointer-events-none absolute -top-16 right-6 h-20 w-20"
    />
  );
}

/** The "lives" step's stage: the server's channel list, with the bot's marked. */
function StageChannels({
  draft,
  channels,
  name,
  serverName,
}: {
  draft: BotDraft;
  channels: Channel[];
  name: string;
  serverName: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative mt-16 w-full rounded-[var(--radius-card)] border border-border bg-surface-1 p-3">
      <Peeker color={draft.color} face="curioso" />
      <p className="mb-2 px-1 text-sm font-semibold text-text">{serverName}</p>
      <ul className="space-y-0.5">
        {channels.slice(0, 9).map((channel) => {
          const lives = draft.channelIds.includes(channel.id);
          return (
            <li
              key={channel.id}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius-control)] px-1.5 py-1 text-sm",
                lives ? "text-text" : "text-text-tertiary",
              )}
            >
              {channelIcon(channel)}
              <span className="min-w-0 flex-1 truncate">{channel.name}</span>
              {lives && <BotFace color={draft.color} face="oi" live={false} className="h-5 w-5" title={name} />}
            </li>
          );
        })}
      </ul>
      {draft.channelIds.length === 0 && (
        <p className="mt-2 px-1 text-xs text-text-tertiary">{t("bots.wizard.stage.noChannels", { name })}</p>
      )}
    </div>
  );
}

/** The "powers" step's stage: what a plan from this bot will look like. */
function StagePlan({ draft, name }: { draft: BotDraft; name: string }) {
  const { t } = useTranslation();
  const sample = botActionCardSchema.parse({
    kind: "plan",
    confirmBy: "você",
    confirmById: SAMPLE_VIEWER,
    planId: SAMPLE_VIEWER,
    expiresAt: new Date(Date.now() + 252_000).toISOString(),
    items: [
      { tool: "delete_channel", label: "Apagar o canal #memes-antigos", status: "pending", detail: null },
      { tool: "create_channel", label: "Criar #memes na categoria Geral", status: "pending", detail: null },
    ],
  });
  return (
    <div className="w-full space-y-3">
      <p className="text-sm text-text-secondary">{t("bots.wizard.stage.planHint", { name })}</p>
      <div className="relative mt-16" inert>
        <Peeker color={draft.color} face="focado" />
        <BotActionCard card={sample} messageId={SAMPLE_VIEWER} createdAt="2026-01-01T00:00:00Z" currentUserId={SAMPLE_VIEWER} botName={name} />
      </div>
    </div>
  );
}

const SAMPLE_VIEWER = "00000000-0000-4000-8000-000000000001";

/**
 * The bot's first message, shown before it is posted: staff read it, edit it
 * if they like, and post it in one of its channels. Nothing is posted without
 * that click.
 */
function IntroPreview({
  bot,
  serverId,
  serverName,
  channels,
}: {
  bot: ServerBotDto;
  serverId: string;
  serverName: string;
  channels: Channel[];
}) {
  const { t } = useTranslation();
  const home = channels.find((channel) => channel.type === "text") ?? channels[0] ?? null;
  const [text, setText] = useState(() =>
    t("bots.intro.template", {
      name: bot.name,
      server: serverName,
      handle: `@${bot.username}`,
      channels: channels
        .slice(0, 3)
        .map((channel) => `#${channel.name}`)
        .join(", "),
    }),
  );
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<"idle" | "posting" | "posted" | "failed">("idle");
  if (!home) return null;
  async function postIt() {
    setState("posting");
    try {
      await postBotIntro(serverId, bot.id, { channelId: home!.id, body: text });
      setState("posted");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface-card p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-text-tertiary">
        {t("bots.intro.preview", { channel: `#${home.name}` })}
      </p>
      <div className="flex gap-3">
        <BotFace color={bot.color} face={bot.face} className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-bold text-text">
            {bot.name}
            <ServerBotTags />
          </p>
          {editing ? (
            <Textarea
              aria-label={t("bots.intro.edit")}
              className="mt-1"
              value={text}
              maxLength={1900}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-secondary">{text}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {state === "posted" ? (
              <p className="text-sm text-success">{t("bots.intro.posted", { channel: `#${home.name}` })}</p>
            ) : (
              <>
                <Button type="button" size="sm" variant="secondary" onClick={() => setEditing((on) => !on)}>
                  {editing ? t("bots.intro.done") : t("bots.intro.edit")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={state === "posting" || !text.trim()}
                  onClick={() => void postIt()}
                >
                  {t("bots.intro.post", { channel: `#${home.name}` })}
                </Button>
                {state === "failed" && (
                  <span role="alert" className="text-xs text-danger">
                    {t("serverSettings.bots.error.generic")}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The practice chat: real model, the draft's persona and knowledge, no tools. */
function TestChat({
  serverId,
  draft,
  name,
  perDay,
}: {
  serverId: string;
  draft: BotDraft;
  name: string;
  perDay: number;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Array<{ from: "member" | "bot"; text: string }>>([]);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [left, setLeft] = useState(perDay);
  const [error, setError] = useState<MessageKey | null>(null);
  const suggestions: MessageKey[] = ["bots.wizard.test.ask1", "bots.wizard.test.ask2", "bots.wizard.test.ask3"];

  async function send(body: string) {
    const trimmed = body.trim();
    if (!trimmed || waiting || left <= 0) return;
    const history = [...messages, { from: "member" as const, text: trimmed }].slice(-12);
    setMessages(history);
    setText("");
    setWaiting(true);
    setError(null);
    try {
      const result = await testServerBot(serverId, {
        name: draft.name.trim(),
        persona: draft.persona,
        knowledge: draft.knowledge,
        messages: history,
      });
      setMessages((now) => [...now, { from: "bot", text: result.reply || "…" }]);
      setLeft(result.turnsLeft);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "bots.wizard.test.limit" : "serverSettings.bots.error.generic");
      if (err instanceof ApiError && err.status === 429) setLeft(0);
    } finally {
      setWaiting(false);
    }
  }

  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface-card">
      <div className="max-h-72 min-h-40 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-sm text-text-tertiary">{t("bots.wizard.test.empty", { name })}</p>
        )}
        {messages.map((message, index) =>
          message.from === "bot" ? (
            <div key={index} className="flex gap-2.5">
              <BotFace color={draft.color} face={draft.face} className="h-7 w-7" />
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-bold text-text">
                  {name}
                  <ServerBotTags />
                </p>
                <p className="whitespace-pre-wrap text-sm text-text-secondary">{message.text}</p>
              </div>
            </div>
          ) : (
            <p key={index} className="ml-auto w-fit max-w-[80%] rounded-[var(--radius-card)] bg-surface-2 px-3 py-1.5 text-sm text-text">
              {message.text}
            </p>
          ),
        )}
        {waiting && (
          <p className="flex items-center gap-2 text-sm text-text-tertiary">
            <BotFace color={draft.color} face="falando" className="h-7 w-7" />
            <span className="bot-shimmer">{t("chat.botActivity.thinkingPill")}</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 pt-2">
        {suggestions.map((key) => (
          <Button key={key} type="button" size="sm" variant="secondary" disabled={waiting || left <= 0} onClick={() => void send(t(key))}>
            {t(key)}
          </Button>
        ))}
      </div>
      <form
        className="flex items-center gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <Input
          aria-label={t("bots.wizard.test.input", { name })}
          placeholder={t("bots.wizard.test.input", { name })}
          value={text}
          maxLength={500}
          disabled={left <= 0}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={waiting || left <= 0 || !text.trim()}>
          {t("bots.wizard.test.send")}
        </Button>
      </form>
      <p className="px-3 pb-3 text-xs text-text-tertiary">
        {error ? <span className="text-danger">{t(error)}</span> : t("bots.wizard.test.left", { count: left })}
      </p>
    </div>
  );
}

function StepTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-bold uppercase tracking-wide text-text-tertiary">{eyebrow}</p>
      <h2 className="font-display text-2xl font-extrabold text-text">{title}</h2>
      <p className="text-sm text-text-secondary">{description}</p>
    </div>
  );
}

function HowTo({ title, body }: { title: string; body: string }) {
  return (
    <li className="rounded-[var(--radius-card)] border border-border bg-surface-card p-3">
      <p className="text-sm font-semibold text-text">{title}</p>
      <p className="text-sm text-text-secondary">{body}</p>
    </li>
  );
}

/** The bot's "carteirinha": what it is so far, filling in as the steps go. */
function IdCard({ draft, name }: { draft: BotDraft; name: string }) {
  const { t } = useTranslation();
  const personaName = (persona: string): string => {
    const preset = PERSONA_PRESETS.find((p) => t(`serverSettings.bots.preset.${p}.text`) === persona);
    return preset ? t(`serverSettings.bots.preset.${preset}.name`) : t("bots.card.voiceOwn");
  };
  const rows: Array<[string, string | null]> = [
    [t("bots.card.name"), draft.name.trim() ? name : null],
    [t("bots.card.voice"), draft.persona.trim() ? personaName(draft.persona) : null],
    [t("bots.card.tagline"), draft.tagline.trim() || null],
    [t("bots.card.knows"), draft.knowledge.trim() ? t("bots.card.knowsValue", { count: draft.knowledge.trim().length }) : null],
    [t("bots.card.lives"), draft.channelIds.length ? t("bots.card.livesValue", { count: draft.channelIds.length }) : null],
    [t("bots.card.powers"), t("bots.card.powersValue", { count: draft.tools.length })],
  ];
  return (
    <div className="w-full rounded-[var(--radius-card)] border border-border bg-surface-card p-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-text-tertiary">{t("bots.card.title")}</p>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-20 shrink-0 text-text-tertiary">{label}</dt>
            <dd className="min-w-0 flex-1 truncate text-text">
              {value ?? <span className="inline-block h-4 w-24 rounded-full border border-dashed border-border-strong align-middle" />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const GROUP_ICON: Record<ServerBotToolGroup, LucideIcon> = {
  senses: ImageIcon,
  lookup: Search,
  channels: Hash,
  reminders: AlarmClock,
  posting: Send,
  moderation: Ban,
};

/** Steps that always wait for a "sim", whatever the count. */
const CONFIRM_TOOLS = new Set<string>([
  "delete_channel",
  ...(SERVER_BOT_TOOL_GROUPS.moderation as readonly string[]),
]);

type ToolMode = "reads" | "now" | "confirms";

function toolMode(group: ServerBotToolGroup, tool: string): ToolMode {
  if (group === "senses" || group === "lookup") return "reads";
  return CONFIRM_TOOLS.has(tool) ? "confirms" : "now";
}

function ModeChip({ mode }: { mode: ToolMode }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-tick)] px-1.5 py-px text-[10px] font-semibold",
        mode === "reads" && "bg-surface-3 text-text-secondary",
        mode === "now" && "bg-accent-soft text-on-accent-soft",
        mode === "confirms" && "bg-warning-soft text-on-warning-soft",
      )}
    >
      {mode === "confirms" && <ShieldCheck className="h-3 w-3" aria-hidden />}
      {t(`bots.tools.mode.${mode}`)}
    </span>
  );
}

/**
 * The tool switches by group: a switch for the whole group, its tools under
 * it, and for each whether it only reads, acts at once (up to three) or
 * always waits for a "sim".
 */
export function ToolPicker({
  tools,
  onChange,
}: {
  tools: readonly ServerBotTool[];
  onChange: (tools: ServerBotTool[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ServerBotToolGroup | null>("channels");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <ModeChip mode="reads" />
        <ModeChip mode="now" />
        <ModeChip mode="confirms" />
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-card">
        {TOOL_GROUPS.map(([group, groupTools]) => {
          const on = groupTools.filter((tool) => tools.includes(tool));
          const Icon = GROUP_ICON[group];
          const expanded = open === group;
          return (
            <div key={group}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)] bg-surface-2 text-text-secondary">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : group)}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
                    {t(`serverSettings.bots.toolGroup.${group}`)}
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 text-text-tertiary transition-transform duration-[var(--duration-fast)]",
                        expanded && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </span>
                  <span className="block truncate text-xs text-text-tertiary">
                    {t("bots.tools.count", { on: on.length, total: groupTools.length })} ·{" "}
                    {t(`bots.tools.groupHint.${group}`)}
                  </span>
                </button>
                {group === "moderation" && <ModeChip mode="confirms" />}
                <div className="shrink-0">
                <Switch
                  checked={on.length > 0}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...new Set([...tools, ...groupTools])]
                        : tools.filter((tool) => !(groupTools as readonly string[]).includes(tool)),
                    )
                  }
                  label={t(`serverSettings.bots.toolGroup.${group}`)}
                  hideLabel
                />
                </div>
              </div>
              {expanded && (
                <div className="space-y-0.5 pb-2 pl-14 pr-3">
                  {groupTools.map((tool) => (
                    <div key={tool} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <CheckRow
                          checked={tools.includes(tool)}
                          onCheckedChange={(checked) =>
                            onChange(checked ? [...tools, tool] : tools.filter((name) => name !== tool))
                          }
                          label={t(`serverSettings.bots.tool.${tool}`)}
                        />
                      </div>
                      <span className="flex w-44 shrink-0 justify-end">
                        <ModeChip mode={toolMode(group, tool)} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-text-tertiary">{t("bots.tools.role")}</p>
    </div>
  );
}

/** What the server will make the handle: the name folded, with `_bot`. A preview only. */
function handlePreview(name: string): string {
  const stem = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return `${stem || "bot"}_bot`;
}
