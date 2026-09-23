import { Check, Copy, Link2, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Invite } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InviteChoiceRow } from "@/components/layout/invite-choice-row";
import { InvitePaste } from "@/components/layout/invite-paste";
import {
  intentStorage,
  stashInviteRef,
  takeInviteRef,
} from "@/lib/handle-intent";
import { useTranslation, type MessageKey, type Translator } from "@/lib/i18n";
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
  /** Create an invite. Distinct from listing/revoking every invite. */
  canCreateInvite?: boolean;
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

const EXPIRY_OPTIONS = [1, 24, 168, 720, null] as const;
const USE_OPTIONS = [null, 1, 5, 10, 25, 50, 100] as const;

type ExpiryHours = (typeof EXPIRY_OPTIONS)[number];
type MaxUses = (typeof USE_OPTIONS)[number];

const EXPIRY_OPTION_KEY: Record<
  "1" | "24" | "168" | "720" | "never",
  MessageKey
> = {
  "1": "invite.create.expiryOption.1h",
  "24": "invite.create.expiryOption.1d",
  "168": "invite.create.expiryOption.7d",
  "720": "invite.create.expiryOption.30d",
  never: "invite.create.expiryOption.never",
};

const EXPIRY_SUMMARY_KEY: Record<"1" | "24" | "168" | "720", MessageKey> = {
  "1": "invite.create.summaryExpiry.1h",
  "24": "invite.create.summaryExpiry.1d",
  "168": "invite.create.summaryExpiry.7d",
  "720": "invite.create.summaryExpiry.30d",
};

function expirySlot(hours: ExpiryHours): "1" | "24" | "168" | "720" | "never" {
  if (hours === 1) return "1";
  if (hours === 24) return "24";
  if (hours === 168) return "168";
  if (hours === 720) return "720";
  return "never";
}

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
    : t("invite.uses.capped", {
        count: invite.uses,
        used: invite.uses,
        max: invite.maxUses,
      });
}

export function InvitePanel({
  open,
  mode,
  serverId,
  serverName,
  canManage,
  canCreateInvite,
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
  const [expiryHours, setExpiryHours] = useState<ExpiryHours>(
    DEFAULT_EXPIRY_HOURS,
  );
  const [maxUses, setMaxUses] = useState<MaxUses>(null);
  const [freshInviteId, setFreshInviteId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const canCreate = canCreateInvite ?? canManage;

  useEffect(() => {
    if (open && mode === "join") {
      setCode(initialCode ?? "");
      setError(initialError);
    }
    if (open && mode === "create") {
      setExpiryHours(DEFAULT_EXPIRY_HOURS);
      setMaxUses(null);
      setFreshInviteId(null);
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
        expiresInHours: expiryHours,
        maxUses,
      });
      setInvites((prev) => [invite, ...prev]);
      setFreshInviteId(invite.id);
      await copyToClipboard(`link:${invite.id}`, inviteLink(invite.code));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("invite.create.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    if (!serverId || !canManage) {
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
    // A `?ref=` tag a failed link join left for this code (see App's
    // `acceptInviteFromLink`), put back again if this attempt fails too.
    const storage = intentStorage();
    const ref = takeInviteRef(storage, trimmed, "");
    try {
      const result = await joinInvite(trimmed, ref);
      onJoined(result.serverId);
      onClose();
    } catch (err) {
      stashInviteRef(storage, trimmed, ref);
      setError(err instanceof Error ? err.message : t("invite.join.failed"));
    } finally {
      setBusy(false);
    }
  }

  const isCreate = mode === "create";
  const expiryOptions = useMemo(
    () =>
      EXPIRY_OPTIONS.map((hours) => ({
        value: hours === null ? "never" : String(hours),
        label: t(EXPIRY_OPTION_KEY[expirySlot(hours)]),
      })),
    [t],
  );
  const useOptions = useMemo(
    () =>
      USE_OPTIONS.map((uses) => ({
        value: uses === null ? "none" : String(uses),
        label:
          uses === null ? t("invite.create.limit.none") : String(uses),
      })),
    [t],
  );
  const summaryUses =
    maxUses === null
      ? t("invite.create.summaryUses.unlimited")
      : t("invite.create.summaryUses.capped", { count: maxUses });
  const expirySlotNow = expirySlot(expiryHours);
  const createSummary =
    expirySlotNow === "never"
      ? t("invite.create.summary.never", { uses: summaryUses })
      : t("invite.create.summary.expiring", {
          expiry: t(EXPIRY_SUMMARY_KEY[expirySlotNow]),
          uses: summaryUses,
        });
  const newestInvite =
    invites.find((invite) => invite.id === freshInviteId) ?? invites[0] ?? null;

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
      size={isCreate ? "lg" : "md"}
      onClose={onClose}
      footer={
        isCreate ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("invite.close")}
            </Button>
            {canCreate && (
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
        {isCreate && !canCreate && (
          <p className="text-sm text-paper-muted">
            {t("invite.create.notAllowed")}
          </p>
        )}

        {isCreate && canCreate && (
          <section className="space-y-3">
            <InviteChoiceRow
              label={t("invite.create.expiryLabel")}
              value={expiryHours === null ? "never" : String(expiryHours)}
              options={expiryOptions}
              onChange={(next) =>
                setExpiryHours(next === "never" ? null : (Number(next) as ExpiryHours))
              }
            />
            <InviteChoiceRow
              label={t("invite.create.limitLabel")}
              value={maxUses === null ? "none" : String(maxUses)}
              options={useOptions}
              onChange={(next) =>
                setMaxUses(next === "none" ? null : (Number(next) as MaxUses))
              }
            />
            <p
              className="text-sm text-text-secondary"
              data-invite-summary=""
            >
              {createSummary}
            </p>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
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
                      {/* Four near-identical glyphs on one row is the case a
                          tooltip is actually for: share, link, code and bin
                          differ by a couple of strokes, and three of them do
                          something silent that a person cannot verify by
                          looking. The bubbles reuse the labels these buttons
                          already carried, code and all — a list can hold
                          several invites, and "Copy invite link" alone would
                          not say which row you are on. */}
                      {typeof navigator.share === "function" && (
                        <Tooltip
                          label={t("invite.create.share", {
                            code: invite.code,
                          })}
                        >
                          <Button
                            size="icon"
                            variant="secondary"
                            className="h-8 w-8 shrink-0"
                            onClick={() =>
                              void navigator
                                .share({ url: inviteLink(invite.code) })
                                .catch(() => {})
                            }
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip
                        label={t("invite.create.copyLink", {
                          code: invite.code,
                        })}
                      >
                        <Button
                          size="icon"
                          variant="secondary"
                          className="h-8 w-8 shrink-0"
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
                      </Tooltip>
                      <Tooltip
                        label={t("invite.create.copyCode", {
                          code: invite.code,
                        })}
                      >
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
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
                      </Tooltip>
                      {canManage && (
                      <Tooltip
                        label={t("invite.create.revoke", {
                          code: invite.code,
                        })}
                      >
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          disabled={pendingId === invite.id}
                          onClick={() => void handleRevoke(invite.id)}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </Tooltip>
                      )}
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
                    {newestInvite?.id === invite.id && (
                      <InvitePaste
                        code={invite.code}
                        className="mt-3"
                        onCopyFailed={() => setError(t("invite.create.copyFailed"))}
                      />
                    )}
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
