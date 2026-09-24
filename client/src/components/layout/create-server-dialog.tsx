import { Check, ChevronRight, Copy, LayoutList } from "lucide-react";
import { intlLocale } from "@/lib/locale";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, DiscordImportPlan, Invite, Server } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DiscordImportPreview } from "@/components/layout/discord-import-preview";
import { ServerReadyPanel } from "@/components/onboarding/server-ready-panel";
import { shareInviteUrl } from "@/lib/share-invite";
import { useTranslation } from "@/lib/i18n";
import { rememberInviteCode } from "@/lib/invite-paste-copy";
import { IdempotencyAttempt } from "@/lib/idempotency";
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
  /**
   * Where the dialog opens. `import` goes straight to the Discord layout
   * paste, for somebody who already said "I have a Discord server" (the
   * onboarding's third door, a `/vem` CTA or a `?import=discord` link, all one
   * `CreateIntent`). Read on each open.
   */
  startMode?: "name" | "import";
  /** Pre-fills the paste box when the link named a template. */
  startSource?: string | null;
  onClose: () => void;
  onCreated: (created: CreatedServerPayload) => Promise<void> | void;
}

/**
 * The invite link on the last screen. Tagged `?ref=discord` after an import:
 * that link is what a group leader pastes back into their old Discord, and the
 * tag is how the joins it brings get counted (`server_members.join_ref`).
 */
function inviteLink(code: string, fromImport: boolean): string {
  return shareInviteUrl(
    window.location.origin,
    code,
    fromImport ? "discord" : "convite",
  );
}

export function CreateServerDialog({
  open,
  startMode = "name",
  startSource = null,
  onClose,
  onCreated,
}: CreateServerDialogProps) {
  const { t, locale } = useTranslation();
  const [step, setStep] = useState<Step>(startMode === "import" ? "paste" : "name");
  const [name, setName] = useState("");
  const [source, setSource] = useState(startSource ?? "");
  // Pick the first step while rendering the open, not in an effect after it:
  // an effect would paint the name step for one frame and then swap it.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep(startMode === "import" ? "paste" : "name");
      setSource(startSource ?? "");
    }
  }
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
  /**
   * One key per create attempt, reused across a retry of the same content
   * so a lost response never makes a second room. Two separate holders: the
   * name-based create and the Discord import are independent attempts. See
   * `@/lib/idempotency`.
   */
  const createAttemptRef = useRef(new IdempotencyAttempt());
  const importAttemptRef = useRef(new IdempotencyAttempt());

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
    createAttemptRef.current.reset();
    importAttemptRef.current.reset();
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
      const created = await createServer(
        trimmed,
        createAttemptRef.current.keyFor(trimmed),
      );
      createAttemptRef.current.reset();
      const [invite] = await Promise.all([
        createInvite(created.server.id, { expiresInHours: 168 })
          .then((result) => result.invite)
          .catch(() => null),
        Promise.resolve()
          .then(() => onCreated(created))
          .catch(() => undefined),
      ]);
      if (invite) {
        // The owner banner's "Copiar convite" reuses this link.
        rememberInviteCode(created.server.id, invite.code);
      }
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
      const trimmedSource = source.trim();
      const created = await applyDiscordImport(
        trimmedSource,
        importAttemptRef.current.keyFor(trimmedSource),
      );
      importAttemptRef.current.reset();
      if (created.invite) {
        rememberInviteCode(created.server.id, created.invite.code);
      }
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
    return date.toLocaleDateString(intlLocale(locale), {
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
  const link = done?.invite ? inviteLink(done.invite.code, done.fromImport) : "";
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
          <div className="space-y-4">
            <ServerReadyPanel
              invite={done.invite}
              inviteRef={done.fromImport ? "discord" : "convite"}
              retrying={busy}
              onRetry={() => void retryInvite()}
              onCopyFailed={() => setError(t("importDiscord.error.copyFailed"))}
            />
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
