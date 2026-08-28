import { Check, Copy, Folder, Hash, Lock, Mic } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  applyDiscordImport,
  createServer,
  previewDiscordImport,
} from "@/lib/api";
import { cn } from "@/lib/utils";

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

  const size = step === "preview" || step === "done" ? "lg" : "sm";
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
            <button
              type="button"
              className="text-sm text-signal hover:underline"
              onClick={() => {
                setStep("paste");
                setError(null);
              }}
            >
              {t("importDiscord.mode.discord")}
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

      <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-ink-4 p-3">
        {topText.map((channel) => (
          <ChannelRow key={channel.templateId} channel={channel} />
        ))}
        {categories.map((category) => {
          const children = plan.channels
            .filter((channel) => channel.parentTemplateId === category.templateId)
            .sort((a, b) => a.position - b.position);
          return (
            <div key={category.templateId}>
              <ChannelRow channel={category} />
              <div className="ml-5 mt-1 space-y-1">
                {children.map((child) => (
                  <ChannelRow key={child.templateId} channel={child} />
                ))}
              </div>
            </div>
          );
        })}
        {topVoice.map((channel) => (
          <ChannelRow key={channel.templateId} channel={channel} />
        ))}
      </div>

      {cosmeticRoles.length > 0 && (
        <div>
          <p className="mb-2 font-medium text-paper">
            {t("importDiscord.preview.roles")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {cosmeticRoles.map((role) => (
              <li
                key={role.name}
                className="rounded-full border border-ink-4 px-2 py-0.5 text-xs"
                style={role.color ? { color: role.color } : undefined}
              >
                {role.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-1 font-medium text-paper">
          {t("importDiscord.dropped.notInTemplateTitle")}
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-paper-muted">
          {plan.notInTemplate.map((reason) => (
            <li key={reason}>{t(NOT_IN_TEMPLATE_KEYS[reason])}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 font-medium text-paper">
          {t("importDiscord.dropped.mappedTitle")}
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-paper-muted">
          {plan.mappedAway.map((item, index) => (
            <li key={`${item.reason}:${item.name ?? index}`}>
              {t(MAPPED_AWAY_KEYS[item.reason], item.name ? { name: item.name } : undefined)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
}: {
  channel: DiscordImportPlan["channels"][number];
}) {
  const { t } = useTranslation();
  const Icon =
    channel.type === "category"
      ? Folder
      : channel.isPrivate
        ? Lock
        : channel.type === "voice"
          ? Mic
          : Hash;
  return (
    <div className={cn("flex items-center gap-2 text-paper")}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-paper-muted" />
      <span className="truncate">{channel.name}</span>
      {channel.isPrivate && (
        <span className="rounded-sm bg-ink-3 px-1.5 py-px text-[10px] uppercase tracking-wide text-paper-muted">
          {t("importDiscord.preview.private")}
        </span>
      )}
    </div>
  );
}
