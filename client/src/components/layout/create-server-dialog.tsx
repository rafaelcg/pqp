import { Check, ChevronRight, Copy, LayoutList } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, DiscordImportPlan, Invite, Server } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DiscordImportPreview } from "@/components/layout/discord-import-preview";
import { InvitePaste } from "@/components/layout/invite-paste";
import { useTranslation } from "@/lib/i18n";
import {
  applyDiscordImport,
  createInvite,
  createServer,
  previewDiscordImport,
} from "@/lib/api";

type Step = "name" | "paste" | "preview" | "done";

export interface CreatedServerPayload {
  server: Server;
  channels: Channel[];
}

interface CreateServerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreatedServerPayload) => Promise<void> | void;
  /**
   * Where the dialog opens. `paste` skips the name field and lands on the
   * Discord template box, for somebody who arrived from `pqp.gg/vem` having
   * already said that is what they came to do (`CreateIntent`).
   */
  initialStep?: "name" | "paste";
}

function inviteLink(code: string): string {
  return `${window.location.origin}/app/invite/${encodeURIComponent(code)}`;
}

export function CreateServerDialog({
  open,
  onClose,
  onCreated,
  initialStep = "name",
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
    serverId: string;
    invite: Invite | null;
    fromImport: boolean;
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

  useEffect(() => {
    if (open && initialStep === "paste") {
      setStep("paste");
    }
  }, [open, initialStep]);

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
      const [invite] = await Promise.all([
        createInvite(created.server.id, { expiresInHours: 168 })
          .then((result) => result.invite)
          .catch(() => null),
        Promise.resolve()
          .then(() => onCreated(created))
          .catch(() => undefined),
      ]);
      setDone({
        serverName: created.server.name,
        serverId: created.server.id,
        invite,
        fromImport: false,
      });
      setStep("done");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("importDiscord.error.createFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryInvite() {
    if (!done || busy) {
      return;
    }
    setBusy(true);
    try {
      const { invite } = await createInvite(done.serverId, {
        expiresInHours: 168,
      });
      setDone({ ...done, invite });
    } catch {
      setDone({ ...done, invite: null });
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
      setDone({
        serverName: created.server.name,
        serverId: created.server.id,
        invite: created.invite,
        fromImport: true,
      });
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
          ? done?.fromImport
            ? t("importDiscord.done.body")
            : t("invite.done.body")
          : t("communities.create.body");

  const size = step === "preview" || step === "done" ? "lg" : "md";
  const eyebrow =
    step === "paste" ||
    step === "preview" ||
    (step === "done" && done?.fromImport)
      ? t("importDiscord.eyebrow")
      : undefined;
  const link = done?.invite ? inviteLink(done.invite.code) : "";
  const pasteMessage =
    done?.invite
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
          <DiscordImportPreview
            plan={plan}
            snapshotLabel={snapshotLabel}
          />
        )}

        {step === "done" && done && (
          <div className="space-y-3">
            {done.invite ? (
              <>
                <label className="block text-sm text-paper">
                  {t("importDiscord.done.invite")}
                  <div className="mt-1 flex gap-2">
                    <Input readOnly value={link} />
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-w-[6.5rem] shrink-0"
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
                <InvitePaste
                  code={done.invite.code}
                  onCopyFailed={() => setError(t("importDiscord.error.copyFailed"))}
                />
              </>
            ) : (
              <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3">
                <p className="text-sm text-text-secondary">
                  {t("invite.done.inviteFailed")}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void retryInvite()}
                >
                  {t("invite.done.retryInvite")}
                </Button>
              </div>
            )}
            {done.fromImport && (
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
            )}
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
