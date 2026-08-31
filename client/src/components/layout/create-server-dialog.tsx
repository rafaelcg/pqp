import {
  Ban,
  Check,
  ChevronRight,
  Copy,
  Hash,
  LayoutList,
  Link2,
  Lock,
  MessageSquare,
  Mic,
  Minus,
  Paperclip,
  Smile,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Channel,
  DiscordImportPlan,
  Invite,
  MappedAwayReason,
  NotInTemplateReason,
  Server,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ServerIcon } from "@/components/layout/server-identity";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  applyDiscordImport,
  createServer,
  previewDiscordImport,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type PlanChannel = DiscordImportPlan["channels"][number];

const STAGGER_CAP = 10;

function staggerVars(index: number): CSSProperties {
  return { "--stagger": index } as CSSProperties;
}

type Step = "name" | "paste" | "preview" | "done";

const NOT_IN_TEMPLATE_KEYS: Record<NotInTemplateReason, MessageKey> = {
  members: "importDiscord.dropped.members",
  messages: "importDiscord.dropped.messages",
  attachments: "importDiscord.dropped.attachments",
  customEmoji: "importDiscord.dropped.customEmoji",
  webhooks: "importDiscord.dropped.webhooks",
  bans: "importDiscord.dropped.bans",
  discordInvites: "importDiscord.dropped.discordInvites",
};

const MAPPED_AWAY_KEYS: Record<MappedAwayReason, MessageKey> = {
  permissionBits: "importDiscord.mapped.permissionBits",
  overwrites: "importDiscord.mapped.overwrites",
  nsfw: "importDiscord.mapped.nsfw",
  slowmode: "importDiscord.mapped.slowmode",
  bitrate: "importDiscord.mapped.bitrate",
  forumTags: "importDiscord.mapped.forumTags",
  threads: "importDiscord.mapped.threads",
  directory: "importDiscord.mapped.directory",
  serverIcon: "importDiscord.mapped.serverIcon",
  unsanitisableRole: "importDiscord.mapped.unsanitisableRole",
  roleCap: "importDiscord.mapped.roleCap",
  flattenAnnouncement: "importDiscord.mapped.flattenAnnouncement",
  flattenForum: "importDiscord.mapped.flattenForum",
  flattenMedia: "importDiscord.mapped.flattenMedia",
  flattenStage: "importDiscord.mapped.flattenStage",
  topicTruncated: "importDiscord.mapped.topicTruncated",
};

export interface CreatedServerPayload {
  server: Server;
  channels: Channel[];
}

interface CreateServerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreatedServerPayload) => Promise<void> | void;
}

function inviteLink(code: string): string {
  return `${window.location.origin}/app/invite/${encodeURIComponent(code)}`;
}

export function CreateServerDialog({
  open,
  onClose,
  onCreated,
}: CreateServerDialogProps) {
  const { t, locale } = useTranslation();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [plan, setPlan] = useState<DiscordImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    serverName: string;
    invite: Invite;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      return;
    }
    setStep("name");
    setName("");
    setSource("");
    setPlan(null);
    setError(null);
    setBusy(false);
    setDone(null);
    setCopied(null);
  }, [open]);

  useEffect(
    () => () => {
      if (copyTimer.current != null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (copyTimer.current != null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(t("importDiscord.error.copyFailed"));
    }
  }

  async function handleCreateByName() {
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createServer(trimmed);
      await onCreated(created);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("importDiscord.error.createFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    if (!source.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await previewDiscordImport(source.trim());
      setPlan(next);
      setStep("preview");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("importDiscord.error.previewFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!source.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await applyDiscordImport(source.trim());
      await onCreated({ server: created.server, channels: created.channels });
      setDone({ serverName: created.server.name, invite: created.invite });
      setStep("done");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("importDiscord.error.applyFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  const snapshotLabel = useMemo(() => {
    if (!plan?.templateUpdatedAt) {
      return null;
    }
    const date = new Date(plan.templateUpdatedAt);
    if (Number.isNaN(date.getTime())) {
      return plan.templateUpdatedAt;
    }
    return date.toLocaleDateString(locale === "pt-BR" ? "pt-BR" : "en", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, [locale, plan?.templateUpdatedAt]);

  const title =
    step === "paste"
      ? t("importDiscord.title")
      : step === "preview"
        ? t("importDiscord.preview.title")
        : step === "done"
          ? t("importDiscord.done.title")
          : t("communities.create.title");

  const description =
    step === "paste"
      ? t("importDiscord.subtitle")
      : step === "preview"
        ? t("importDiscord.preview.subtitle", { name: plan?.serverName ?? "" })
        : step === "done"
          ? t("importDiscord.done.body")
          : t("communities.create.body");

  const size = step === "preview" || step === "done" ? "lg" : "md";
  const eyebrow =
    step === "paste" || step === "preview" || step === "done"
      ? t("importDiscord.eyebrow")
      : undefined;
  const link = done ? inviteLink(done.invite.code) : "";
  const pasteMessage = done
    ? t("importDiscord.done.pasteMessage", {
        server: done.serverName,
        link,
      })
    : "";

  return (
    <Dialog
      open={open}
      title={title}
      eyebrow={eyebrow}
      description={description}
      size={size}
      onClose={onClose}
      dismissible={!busy}
      closeOnBackdrop={!busy}
      footer={
        step === "done" ? (
          <Button type="button" onClick={onClose}>
            {t("importDiscord.done.close")}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={
                step === "preview"
                  ? () => {
                      setStep("paste");
                      setError(null);
                    }
                  : onClose
              }
              disabled={busy}
            >
              {step === "preview"
                ? t("importDiscord.preview.back")
                : t("invite.join.cancel")}
            </Button>
            {step === "name" && (
              <Button
                type="button"
                onClick={() => void handleCreateByName()}
                disabled={!name.trim() || busy}
              >
                {busy ? t("chrome.creating") : t("chrome.create")}
              </Button>
            )}
            {step === "paste" && (
              <Button
                type="button"
                onClick={() => void handlePreview()}
                disabled={!source.trim() || busy}
              >
                {busy ? t("importDiscord.paste.loading") : t("importDiscord.paste.preview")}
              </Button>
            )}
            {step === "preview" && (
              <Button
                type="button"
                onClick={() => void handleApply()}
                disabled={busy}
              >
                {busy
                  ? t("importDiscord.preview.applying")
                  : t("importDiscord.preview.confirm")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-4 px-5 py-4">
        {step === "name" && (
          <>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleCreateByName();
                }
              }}
              placeholder={t("communities.create.placeholder")}
              autoFocus
              disabled={busy}
            />
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
              <span className="h-px flex-1 bg-ink-4" />
              {t("importDiscord.mode.or")}
              <span className="h-px flex-1 bg-ink-4" />
            </div>
            <button
              type="button"
              data-discord-import-path=""
              disabled={busy}
              className="flex w-full items-start gap-3 rounded-xl border border-signal/35 bg-signal/5 px-4 py-3.5 text-left transition-colors hover:border-signal/60 hover:bg-signal/10 disabled:opacity-50"
              onClick={() => {
                setStep("paste");
                setError(null);
              }}
            >
              <LayoutList className="mt-0.5 h-5 w-5 shrink-0 text-signal" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-paper">
                  {t("importDiscord.mode.discord")}
                </span>
                <span className="mt-0.5 block text-sm text-paper-muted">
                  {t("importDiscord.mode.discordBody")}
                </span>
              </span>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" />
            </button>
          </>
        )}

        {step === "paste" && (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-paper-muted">
              <li>{t("importDiscord.howto.step1")}</li>
              <li>{t("importDiscord.howto.step2")}</li>
              <li>{t("importDiscord.howto.step3")}</li>
            </ol>
            <textarea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              rows={3}
              disabled={busy}
              autoFocus
              placeholder={t("importDiscord.paste.placeholder")}
              className="w-full resize-none rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              className="text-sm text-paper-muted hover:text-paper hover:underline"
              onClick={() => {
                setStep("name");
                setError(null);
              }}
            >
              {t("importDiscord.mode.name")}
            </button>
          </>
        )}

        {step === "preview" && plan && (
          <PreviewBody
            plan={plan}
            snapshotLabel={snapshotLabel}
          />
        )}

        {step === "done" && done && (
          <div className="space-y-3">
            <label className="block text-sm text-paper">
              {t("importDiscord.done.invite")}
              <div className="mt-1 flex gap-2">
                <Input readOnly value={link} />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void copyText("invite", link)}
                >
                  {copied === "invite" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied === "invite"
                    ? t("importDiscord.done.copied")
                    : t("importDiscord.done.copyInvite")}
                </Button>
              </div>
            </label>
            <label className="block text-sm text-paper">
              {t("importDiscord.done.pasteLabel")}
              <textarea
                readOnly
                rows={4}
                value={pasteMessage}
                className="mt-1 w-full resize-none rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper"
              />
              <Button
                type="button"
                variant="secondary"
                className="mt-2"
                onClick={() => void copyText("message", pasteMessage)}
              >
                {copied === "message" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied === "message"
                  ? t("importDiscord.done.copied")
                  : t("importDiscord.done.copyMessage")}
              </Button>
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PreviewBody({
  plan,
  snapshotLabel,
}: {
  plan: DiscordImportPlan;
  snapshotLabel: string | null;
}) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const categories = plan.channels
    .filter((channel) => channel.type === "category")
    .sort((a, b) => a.position - b.position);
  const topText = plan.channels
    .filter((channel) => channel.type === "text" && channel.parentTemplateId == null)
    .sort((a, b) => a.position - b.position);
  const topVoice = plan.channels
    .filter((channel) => channel.type === "voice" && channel.parentTemplateId == null)
    .sort((a, b) => a.position - b.position);
  const cosmeticRoles = plan.roles;

  const comingCount =
    topText.length +
    topVoice.length +
    categories.length +
    plan.channels.filter((channel) => channel.parentTemplateId != null).length +
    (cosmeticRoles.length > 0 ? 1 : 0);
  let comingIndex = 0;
  const nextComing = () => staggerVars(Math.min(comingIndex++, STAGGER_CAP));

  return (
    <div className="space-y-4 text-sm">
      {plan.isDirty && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-paper">
          {t("importDiscord.preview.unsynced")}
        </p>
      )}
      {snapshotLabel && (
        <p className="text-paper-muted">
          {t("importDiscord.preview.snapshot", { date: snapshotLabel })}
        </p>
      )}
      <p className="text-paper-muted">{t("importDiscord.preview.renameNote")}</p>

      <aside className="overflow-hidden rounded-xl border border-ink-4/60 bg-channel">
        <div className="flex min-h-14 items-center gap-2.5 border-b border-ink-4/60 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-3 font-display text-xs font-bold text-paper">
            <ServerIcon name={plan.serverName} iconUrl={plan.iconUrl} />
          </span>
          <p className="truncate font-display text-base font-bold leading-tight">
            {plan.serverName}
          </p>
        </div>
        <div className="max-h-72 overflow-y-auto px-1 py-3">
          {topText.length > 0 && (
            <PreviewSection label={t("chrome.text")}>
              {topText.map((channel) => (
                <PreviewChannelRow
                  key={channel.templateId}
                  channel={channel}
                  reduced={reduced}
                  style={nextComing()}
                />
              ))}
            </PreviewSection>
          )}
          {topVoice.length > 0 && (
            <PreviewSection label={t("chrome.voice")}>
              {topVoice.map((channel) => (
                <PreviewChannelRow
                  key={channel.templateId}
                  channel={channel}
                  reduced={reduced}
                  style={nextComing()}
                />
              ))}
            </PreviewSection>
          )}
          {categories.length > 0 && (
            <PreviewSection label={t("chrome.categories")}>
              {categories.map((category) => {
                const children = plan.channels
                  .filter(
                    (channel) => channel.parentTemplateId === category.templateId,
                  )
                  .sort((a, b) => a.position - b.position);
                const headerStyle = nextComing();
                return (
                  <div key={category.templateId} className="mb-1">
                    <div
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-paper-muted",
                        !reduced && "animate-rise",
                      )}
                      style={reduced ? undefined : headerStyle}
                    >
                      <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
                      <span className="truncate">{category.name}</span>
                    </div>
                    <div className="ml-2 border-l border-ink-4/70 pl-2">
                      {children.map((child) => (
                        <PreviewChannelRow
                          key={child.templateId}
                          channel={child}
                          reduced={reduced}
                          style={nextComing()}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </PreviewSection>
          )}
          {cosmeticRoles.length > 0 && (
            <PreviewSection label={t("importDiscord.preview.rolesSection")}>
              <ul
                className={cn(
                  "flex flex-wrap gap-1.5 px-2 py-1",
                  !reduced && "animate-rise",
                )}
                style={reduced ? undefined : nextComing()}
              >
                {cosmeticRoles.map((role) => (
                  <li
                    key={role.name}
                    className="rounded-full border border-ink-4 bg-ink-3/50 px-2 py-0.5 text-xs"
                    style={role.color ? { color: role.color } : undefined}
                  >
                    {role.name}
                  </li>
                ))}
              </ul>
              <p className="px-2 pt-1 text-[11px] text-paper-muted">
                {t("importDiscord.preview.rolesHint")}
              </p>
            </PreviewSection>
          )}
        </div>
      </aside>

      <aside
        className={cn(
          "overflow-hidden rounded-xl border border-ink-4/60 bg-channel",
          !reduced && "animate-rise",
        )}
        style={reduced ? undefined : staggerVars(Math.min(comingCount, STAGGER_CAP) + 4)}
      >
        <div className="border-b border-ink-4/60 px-4 py-3">
          <p className="font-display text-base font-bold leading-tight text-paper-muted">
            {t("importDiscord.dropped.sectionTitle")}
          </p>
        </div>
        <div className="max-h-56 overflow-y-auto px-1 py-3">
          <PreviewSection label={t("importDiscord.dropped.notInTemplateTitle")}>
            {plan.notInTemplate.map((reason) => (
              <DroppedRow
                key={reason}
                icon={NOT_IN_TEMPLATE_ICONS[reason]}
                label={t(NOT_IN_TEMPLATE_KEYS[reason])}
              />
            ))}
          </PreviewSection>
          {plan.mappedAway.length > 0 && (
            <PreviewSection label={t("importDiscord.dropped.mappedTitle")}>
              {plan.mappedAway.map((item, index) => (
                <DroppedRow
                  key={`${item.reason}:${item.name ?? index}`}
                  icon={Minus}
                  label={t(
                    MAPPED_AWAY_KEYS[item.reason],
                    item.name ? { name: item.name } : undefined,
                  )}
                />
              ))}
            </PreviewSection>
          )}
        </div>
      </aside>
    </div>
  );
}

function PreviewSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function PreviewChannelRow({
  channel,
  reduced,
  style,
}: {
  channel: PlanChannel;
  reduced: boolean;
  style: CSSProperties;
}) {
  const { t } = useTranslation();
  const Icon = channel.isPrivate ? Lock : channel.type === "voice" ? Mic : Hash;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-paper-muted",
        !reduced && "animate-rise",
      )}
      style={reduced ? undefined : style}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          channel.isPrivate ? "text-warning" : "text-paper-muted",
        )}
      />
      <span className="truncate">{channel.name}</span>
      {channel.isPrivate && (
        <span className="ml-auto shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
          {t("importDiscord.preview.private")}
        </span>
      )}
    </div>
  );
}

const NOT_IN_TEMPLATE_ICONS: Record<NotInTemplateReason, LucideIcon> = {
  members: Users,
  messages: MessageSquare,
  attachments: Paperclip,
  customEmoji: Smile,
  webhooks: Webhook,
  bans: Ban,
  discordInvites: Link2,
};

function DroppedRow({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-sm text-paper-muted/80">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="leading-snug">{label}</span>
    </div>
  );
}

