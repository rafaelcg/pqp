import { Check } from "lucide-react";
import { useState } from "react";
import {
  discordMergeIsEmpty,
  isDiscordInviteLink,
  MAX_IMPORT_CATEGORIES,
  MAX_IMPORT_CHANNELS,
  type Channel,
  type DiscordMergePreview,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { discordImportErrorKey } from "@/components/layout/create-server-dialog";
import { DiscordImportMergePreview } from "@/components/layout/discord-import-merge-preview";
import { ApiError, applyDiscordMerge, previewDiscordMerge } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

type Step = "paste" | "preview" | "done";

const IMPORT_CAPS = {
  channels: MAX_IMPORT_CHANNELS,
  categories: MAX_IMPORT_CATEGORIES,
};

/**
 * `403` and a code-less `404` are this dialog's own answers (not allowed, or
 * the flag is off for the server), and must not read as "that template was not
 * found", which is what the shared mapper says for a bare 404.
 */
function mergeErrorKey(error: unknown, fallback: MessageKey): MessageKey {
  if (error instanceof ApiError) {
    const code = (error.details as { code?: unknown } | null)?.code;
    if (error.status === 403) {
      return "importDiscordMerge.error.forbidden";
    }
    if (error.status === 404 && typeof code !== "string") {
      return "importDiscordMerge.error.gone";
    }
  }
  return discordImportErrorKey(error, fallback);
}

export interface DiscordImportMergeDialogProps {
  serverId: string;
  serverName: string;
  /** Pre-fills the paste box. */
  startSource?: string | null;
  onClose: () => void;
  /** After a merge that added something: refetch this server's channels. */
  onMerged?: (serverId: string, channels: Channel[]) => void;
  /** The done step's link to the new channels. */
  onOpenChannel?: (serverId: string, channelId: string) => void;
}

/**
 * Mount it per server (`key={serverId}`): a new server id is a new import, and
 * nothing typed or previewed for another community carries over.
 *
 * Bring a Discord layout into a community that already exists. Paste, preview
 * what would be added, confirm, done. It only ever adds (see
 * `docs/DISCORD_IMPORT.md` "Into a server that already exists"), so the copy
 * says so on every step. No invite step: that one is for a NEW server.
 */
export function DiscordImportMergeDialog({
  serverId,
  serverName,
  startSource = null,
  onClose,
  onMerged,
  onOpenChannel,
}: DiscordImportMergeDialogProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("paste");
  const [source, setSource] = useState(startSource ?? "");
  const [preview, setPreview] = useState<DiscordMergePreview | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    channels: Channel[];
    categories: number;
    roles: number;
  } | null>(null);

  async function handlePreview() {
    if (!source.trim() || busy) {
      return;
    }
    if (isDiscordInviteLink(source)) {
      setError(t("importDiscord.error.inviteLink"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await previewDiscordMerge(serverId, source.trim());
      setPreview(next);
      // Cargos are off until somebody ticks them.
      setPicked(new Set());
      setStep("preview");
    } catch (err) {
      setError(t(mergeErrorKey(err, "importDiscord.error.previewFailed"), IMPORT_CAPS));
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!preview || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await applyDiscordMerge(serverId, source.trim(), [...picked]);
      setDone({
        channels: result.channels,
        categories: result.plan.addedCategories.length,
        roles: result.rolesCreated.length,
      });
      setStep("done");
      onMerged?.(serverId, result.channels);
    } catch (err) {
      setError(t(mergeErrorKey(err, "importDiscord.error.applyFailed"), IMPORT_CAPS));
    } finally {
      setBusy(false);
    }
  }

  const empty = preview ? discordMergeIsEmpty(preview) : false;
  const firstChannel = done?.channels.find((channel) => channel.type !== "category") ?? null;

  const title =
    step === "paste"
      ? t("importDiscordMerge.title")
      : step === "preview"
        ? empty
          ? t("importDiscordMerge.preview.titleEmpty")
          : t("importDiscordMerge.preview.title")
        : done && done.channels.length + done.categories > 0
          ? t("importDiscordMerge.done.title")
          : t("importDiscordMerge.done.titleEmpty");

  const description =
    step === "paste"
      ? t("importDiscordMerge.subtitle", { server: serverName })
      : step === "preview"
        ? t("importDiscordMerge.preview.subtitle", { server: serverName })
        : t("importDiscordMerge.done.body");

  const channelParts = done
    ? [
        done.channels.length > 0
          ? t("importDiscordMerge.count.channels", { count: done.channels.length })
          : null,
        done.categories > 0
          ? t("importDiscordMerge.count.categories", { count: done.categories })
          : null,
        done.roles > 0 ? t("importDiscordMerge.count.roles", { count: done.roles }) : null,
      ].filter(Boolean)
    : [];

  return (
    <Dialog
      open
      title={title}
      eyebrow={t("importDiscord.eyebrow")}
      description={description}
      size={step === "paste" ? "md" : "lg"}
      onClose={onClose}
      dismissible={!busy}
      closeOnBackdrop={!busy}
      footer={
        step === "done" ? (
          <>
            {firstChannel && onOpenChannel && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onOpenChannel(serverId, firstChannel.id);
                  onClose();
                }}
              >
                {t("importDiscordMerge.done.open")}
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              {t("importDiscord.done.close")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={
                step === "preview"
                  ? () => {
                      setStep("paste");
                      setError(null);
                    }
                  : onClose
              }
            >
              {step === "preview" ? t("importDiscord.preview.back") : t("invite.join.cancel")}
            </Button>
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
                disabled={busy || empty}
                data-testid="discord-merge-confirm"
              >
                {busy
                  ? t("importDiscordMerge.preview.applying")
                  : t("importDiscordMerge.preview.confirm")}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-4 px-5 py-4">
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
              aria-label={t("importDiscordMerge.paste.label")}
              placeholder={t("importDiscord.paste.placeholder")}
              className="w-full resize-none rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </>
        )}

        {step === "preview" && preview && (
          <>
            <DiscordImportMergePreview
              preview={preview}
              serverName={serverName}
              pickedRoles={picked}
              onToggleRole={(templateId) =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(templateId)) {
                    next.delete(templateId);
                  } else {
                    next.add(templateId);
                  }
                  return next;
                })
              }
            />
            {!empty && (
              <p className="text-xs text-paper-muted" data-testid="discord-merge-promise">
                {t("importDiscordMerge.preview.promise")}
              </p>
            )}
          </>
        )}

        {step === "done" && done && (
          <div className="space-y-3" data-testid="discord-merge-done">
            <p className="flex items-start gap-2 text-sm text-paper">
              <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
              <span role="status">
                {channelParts.length > 0
                  ? t("importDiscordMerge.done.summary", { parts: channelParts.join(", ") })
                  : t("importDiscordMerge.done.nothing")}
              </span>
            </p>
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
