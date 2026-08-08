import { Check, Copy, Link2, Share2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Invite } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation, type Translator } from "@/lib/i18n";
import {
  createInvite,
  deleteInvite,
  joinInvite,
  listInvites,
  previewInvite,
} from "@/lib/api";

interface InvitePanelProps {
  open: boolean;
  mode: "create" | "join";
  serverId: string | null;
  serverName: string | null;
  canManage: boolean;
  /** Code from an `/app/invite/<code>` link or `pqp://invite/<code>` deep link. */
  initialCode?: string | null;
  /**
   * Why the app could not walk them in on its own.
   *
   * Arriving on an invite link no longer stops at this dialog — the app joins and
   * opens the channel. So the only way a *link* gets here is a refusal, and
   * opening pre-filled and silent after one would read as "nothing happened"
   * rather than "that link is dead".
   */
  initialError?: string | null;
  onClose: () => void;
  onJoined: (serverId: string) => void;
}

const DEFAULT_EXPIRY_HOURS = 168;

function inviteLink(code: string): string {
  return `${window.location.origin}/app/invite/${encodeURIComponent(code)}`;
}

/** Accepts a bare code or a pasted `/app/invite/<code>` link. */
function normalizeCode(input: string): string {
  const segments = input.trim().split(/[/\\]/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function formatExpiry(t: Translator["t"], expiresAt: string | null): string {
  if (!expiresAt) {
    return t("invite.expiry.never");
  }
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) {
    return t("invite.expiry.expired");
  }
  const hours = Math.round(remainingMs / 3_600_000);
  if (hours < 24) {
    return t("invite.expiry.hours", { count: Math.max(1, hours) });
  }
  return t("invite.expiry.days", { count: Math.round(hours / 24) });
}

function formatUses(t: Translator["t"], invite: Invite): string {
  return invite.maxUses === null
    ? t("invite.uses.unlimited", { count: invite.uses })
    : t("invite.uses.capped", { used: invite.uses, max: invite.maxUses });
}

export function InvitePanel({
  open,
  mode,
  serverId,
  serverName,
  canManage,
  initialCode = null,
  initialError = null,
  onClose,
  onJoined,
}: InvitePanelProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Invite | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open && mode === "join") {
      setCode(initialCode ?? "");
      setError(initialError);
    }
  }, [open, mode, initialCode, initialError]);

  useEffect(() => {
    if (!open || mode !== "create" || !serverId || !canManage) {
      return;
    }
    let cancelled = false;
    setLoadingInvites(true);
    setError(null);

    listInvites(serverId)
      .then((result) => {
        if (!cancelled) {
          setInvites(result.invites);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t("invite.create.loadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingInvites(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // `t` is stable for a locale and re-running on it would refetch the list on
    // a language change for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, serverId, canManage]);

  // Resolving the code before joining lets people confirm which server a
  // pasted link actually points at.
  useEffect(() => {
    if (!open || mode !== "join") {
      return;
    }
    const trimmed = code.trim();
    if (trimmed.length < 4) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewInvite(trimmed)
        .then(({ invite }) => {
          if (!cancelled) {
            setPreview(invite);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPreview(null);
          }
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, code]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  async function copyToClipboard(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(t("invite.create.copyFailed"));
    }
  }

  async function handleCreate() {
    if (!serverId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { invite } = await createInvite(serverId, {
        expiresInHours: DEFAULT_EXPIRY_HOURS,
      });
      setInvites((prev) => [invite, ...prev]);
      await copyToClipboard(`link:${invite.id}`, inviteLink(invite.code));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("invite.create.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    if (!serverId) {
      return;
    }
    setPendingId(inviteId);
    setError(null);
    try {
      await deleteInvite(serverId, inviteId);
      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("invite.create.revokeFailed"),
      );
    } finally {
      setPendingId(null);
    }
  }

  async function handleJoin() {
    const trimmed = code.trim();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await joinInvite(trimmed);
      onJoined(result.serverId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("invite.join.failed"));
    } finally {
      setBusy(false);
    }
  }

  const isCreate = mode === "create";

  return (
    <Dialog
      open={open}
      eyebrow={
        isCreate ? t("invite.create.eyebrow") : t("invite.join.eyebrow")
      }
      title={
        isCreate
          ? (serverName ?? t("invite.create.serverFallback"))
          : t("invite.join.title")
      }
      description={
        isCreate
          ? t("invite.create.description")
          : t("invite.join.description")
      }
      onClose={onClose}
      footer={
        isCreate ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("invite.close")}
            </Button>
            {canManage && (
              <Button onClick={() => void handleCreate()} disabled={busy}>
                {busy ? t("invite.create.creating") : t("invite.create.action")}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("invite.join.cancel")}
            </Button>
            <Button
              onClick={() => void handleJoin()}
              disabled={busy || !code.trim()}
            >
              {busy ? t("invite.join.joining") : t("invite.join.action")}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 px-5 py-4">
        {isCreate && !canManage && (
          <p className="text-sm text-paper-muted">
            {t("invite.create.notAllowed")}
          </p>
        )}

        {isCreate && canManage && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
              {t("invite.create.activeTitle")}
            </h3>
            {loadingInvites ? (
              <p className="text-sm text-paper-muted">
                {t("invite.create.loading")}
              </p>
            ) : invites.length === 0 ? (
              <p className="text-sm text-paper-muted">
                {t("invite.create.none")}
              </p>
            ) : (
              <ul className="space-y-2">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="rounded-lg border border-ink-4 bg-ink p-3"
                  >
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate font-mono text-sm text-signal">
                        {inviteLink(invite.code)}
                      </p>
                      {/* The system share sheet where one exists (phones,
                          mostly) — straight into WhatsApp, same journey as
                          the iOS app. Desktop browsers lack the API and get
                          copy-the-link, which is the desktop journey anyway. */}
                      {typeof navigator.share === "function" && (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="h-8 w-8 shrink-0"
                          aria-label={t("invite.create.share", {
                            code: invite.code,
                          })}
                          onClick={() =>
                            void navigator
                              .share({ url: inviteLink(invite.code) })
                              .catch(() => {})
                          }
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="secondary"
                        className="h-8 w-8 shrink-0"
                        aria-label={t("invite.create.copyLink", {
                          code: invite.code,
                        })}
                        onClick={() =>
                          void copyToClipboard(
                            `link:${invite.id}`,
                            inviteLink(invite.code),
                          )
                        }
                      >
                        {copied === `link:${invite.id}` ? (
                          <Check className="h-4 w-4 text-success" />
                        ) : (
                          <Link2 className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        aria-label={t("invite.create.copyCode", {
                          code: invite.code,
                        })}
                        onClick={() =>
                          void copyToClipboard(
                            `code:${invite.id}`,
                            invite.code,
                          )
                        }
                      >
                        {copied === `code:${invite.id}` ? (
                          <Check className="h-4 w-4 text-success" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        aria-label={t("invite.create.revoke", {
                          code: invite.code,
                        })}
                        disabled={pendingId === invite.id}
                        onClick={() => void handleRevoke(invite.id)}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-paper-muted">
                      <span className="font-mono text-paper">
                        {invite.code}
                      </span>
                      {" · "}
                      {formatUses(t, invite)}
                      {" · "}
                      {formatExpiry(t, invite.expiresAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p
              className="mt-2 h-4 text-xs text-success"
              role="status"
              aria-live="polite"
            >
              {copied ? t("invite.create.copied") : ""}
            </p>
          </section>
        )}

        {!isCreate && (
          <div className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
                {t("invite.join.label")}
              </span>
              <Input
                value={code}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                placeholder={t("invite.join.placeholder")}
                autoFocus
              />
            </label>
            <p
              className="h-4 text-xs text-paper-muted"
              role="status"
              aria-live="polite"
            >
              {preview?.serverName
                ? t("invite.join.preview", { name: preview.serverName })
                : ""}
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
