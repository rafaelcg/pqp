import type { AuditLogEntry, Server } from "@pqp/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ReportsSection } from "@/components/layout/reports-section";
import {
  ApiError,
  deleteServer,
  exportServerData,
  fetchAuditLog,
  fetchMembers,
  updateServer,
  type ServerMember,
} from "@/lib/api";

const TRANSFER_PHRASE = "TRANSFER";

/** A short, human verb phrase per action — the actor's name and (for
 * role/ban actions) the reason carry the rest of the sentence. */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "member.kick": "kicked a member",
  "member.ban": "banned a member",
  "member.unban": "unbanned a member",
  "member.role_update": "changed a member's role",
  "channel.create": "created a channel",
  "channel.update": "updated a channel",
  "channel.delete": "deleted a channel",
  "channel.move": "reordered a channel",
  "message.delete": "deleted someone's message",
  "server.update": "renamed the server",
  "server.retention_update": "changed message retention",
  "server.ownership_transfer": "transferred ownership",
  "server.data_export": "exported the server's data",
  "invite.create": "created an invite",
  "invite.delete": "revoked an invite",
  "server.sso_domain_update": "changed the SSO email domain",
  "member.sso_join": "joined via SSO email domain",
  "webhook.create": "created a webhook",
  "webhook.delete": "deleted a webhook",
  "report.resolve": "closed a report",
};

/**
 * Visible to owners and admins alike — the whole point is that a moderator
 * with the power to kick, ban, or delete is accountable to the rest of the
 * community for having used it, not just to the owner.
 */
function AuditLogSection({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAuditLog(serverId)
      .then((res) => {
        if (!cancelled) {
          setEntries(res.entries);
          setHasMore(res.hasMore);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(messageOf(err, "Failed to load the audit log"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function loadMore() {
    const last = entries.at(-1);
    if (!last) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await fetchAuditLog(serverId, { before: last.id });
      setEntries((prev) => [...prev, ...res.entries]);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(messageOf(err, "Failed to load more"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="space-y-2 border-t border-ink-4 pt-5">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
        Audit log
      </h3>
      {loading && (
        <p role="status" aria-live="polite" className="text-sm text-paper-muted">
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!loading && entries.length === 0 && !error && (
        <p className="text-sm text-paper-muted">
          Nothing recorded yet. Kicks, bans, role changes, and channel or
          server edits will show up here.
        </p>
      )}
      {entries.length > 0 && (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-md border border-ink-4 bg-ink-3/40 p-2 text-sm"
            >
              <p className="text-paper">
                <span className="font-semibold">
                  {entry.actorName ?? "A departed account"}
                </span>{" "}
                {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                {entry.reason && (
                  <span className="text-paper-muted"> — {entry.reason}</span>
                )}
              </p>
              <p className="text-xs text-paper-muted">
                {new Date(entry.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </section>
  );
}

interface ServerSettingsDialogProps {
  open: boolean;
  server: Server | null;
  currentUserId: string | null;
  onClose: () => void;
  onRenamed: (server: Server) => void;
  onOwnershipTransferred: () => void;
  onDeleted: (serverId: string) => void;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function ServerSettingsDialog({
  open,
  server,
  currentUserId,
  onClose,
  onRenamed,
  onOwnershipTransferred,
  onDeleted,
}: ServerSettingsDialogProps) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [savingName, setSavingName] = useState(false);

  const [candidates, setCandidates] = useState<ServerMember[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [transferArmed, setTransferArmed] = useState(false);
  const [transferPhrase, setTransferPhrase] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [ssoDomain, setSsoDomain] = useState("");
  const [savingSso, setSavingSso] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoSaved, setSsoSaved] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);

  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const serverId = server?.id ?? null;
  const isOwner = server?.role === "owner";
  const isManager = isOwner || server?.role === "admin";

  // Seeded from a ref so a rename landing in the parent does not overwrite what
  // is being typed here; the form only resets when the dialog opens.
  const serverNameRef = useRef(server?.name ?? "");
  serverNameRef.current = server?.name ?? "";
  const retentionRef = useRef(server?.messageRetentionDays ?? null);
  retentionRef.current = server?.messageRetentionDays ?? null;
  const ssoRef = useRef(server?.ssoEmailDomain ?? null);
  ssoRef.current = server?.ssoEmailDomain ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(serverNameRef.current);
    setNameError(null);
    setNameSaved(false);
    setTargetId("");
    setTransferArmed(false);
    setTransferPhrase("");
    setTransferError(null);
    setDeleteArmed(false);
    setDeletePhrase("");
    setDeleteError(null);
    setRetentionDays(retentionRef.current);
    setRetentionError(null);
    setRetentionSaved(false);
    setSsoDomain(ssoRef.current ?? "");
    setSsoError(null);
    setSsoSaved(false);
    setExportError(null);
  }, [open, serverId]);

  useEffect(() => {
    if (!open || !isOwner || !serverId) {
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    void fetchMembers(serverId)
      .then((res) => {
        if (!cancelled) {
          setCandidates(res.members.filter((m) => m.id !== currentUserId));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTransferError(messageOf(err, "Failed to load members"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCandidatesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, isOwner, serverId, currentUserId]);

  if (!open || !server) {
    return null;
  }

  const busy = savingName || transferring || deleting;
  const trimmedName = name.trim();
  const target = candidates.find((m) => m.id === targetId) ?? null;

  async function saveRetention(days: number | null) {
    if (!serverId) {
      return;
    }
    setSavingRetention(true);
    setRetentionError(null);
    setRetentionSaved(false);
    try {
      const res = await updateServer(serverId, { messageRetentionDays: days });
      if (res.server) {
        onRenamed(res.server);
        setRetentionDays(days);
        setRetentionSaved(true);
      } else {
        setRetentionError("Server did not return the updated server.");
      }
    } catch (err) {
      setRetentionError(messageOf(err, "Failed to update retention"));
    } finally {
      setSavingRetention(false);
    }
  }

  async function saveSso() {
    if (!serverId) {
      return;
    }
    setSavingSso(true);
    setSsoError(null);
    setSsoSaved(false);
    try {
      // An empty box means "turn it off", which the API spells as explicit null
      // — sending "" would fail validation rather than clear the setting.
      const trimmed = ssoDomain.trim();
      const res = await updateServer(serverId, {
        ssoEmailDomain: trimmed === "" ? null : trimmed,
      });
      if (res.server) {
        onRenamed(res.server);
        setSsoDomain(res.server.ssoEmailDomain ?? "");
        setSsoSaved(true);
      } else {
        setSsoError("Server did not return the updated server.");
      }
    } catch (err) {
      setSsoError(messageOf(err, "Failed to update the SSO domain"));
    } finally {
      setSavingSso(false);
    }
  }

  async function exportData() {
    if (!serverId) {
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportServerData(serverId);
      // Same download mechanism a real file link uses — a Blob has no URL of
      // its own, so one is minted just long enough for the click to fire.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${server?.name ?? "server"}-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(messageOf(err, "Failed to export data"));
    } finally {
      setExporting(false);
    }
  }

  async function saveName() {
    if (!serverId || !trimmedName || trimmedName === server?.name) {
      return;
    }
    setSavingName(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const res = await updateServer(serverId, { name: trimmedName });
      if (res.server) {
        onRenamed(res.server);
        setNameSaved(true);
      } else {
        setNameError("Server did not return the updated server.");
      }
    } catch (err) {
      setNameError(messageOf(err, "Failed to rename server"));
    } finally {
      setSavingName(false);
    }
  }

  async function transferOwnership() {
    if (!serverId || !target) {
      return;
    }
    setTransferring(true);
    setTransferError(null);
    try {
      await updateServer(serverId, { ownerId: target.id });
      setTransferArmed(false);
      setTransferPhrase("");
      onOwnershipTransferred();
      onClose();
    } catch (err) {
      setTransferError(messageOf(err, "Failed to transfer ownership"));
    } finally {
      setTransferring(false);
    }
  }

  async function destroyServer() {
    if (!serverId) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteServer(serverId);
      onDeleted(serverId);
    } catch (err) {
      setDeleteError(messageOf(err, "Failed to delete server"));
    } finally {
      setDeleting(false);
    }
  }

  if (!isOwner) {
    return (
      <Dialog
        open
        title={server.name}
        eyebrow="Server settings"
        size="md"
        onClose={onClose}
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="space-y-2 px-5 py-5">
          <p className="text-sm text-paper-muted">
            {isManager
              ? "Only the server owner can rename this server, transfer ownership, or delete it."
              : "Only owners and admins can change server settings. Ask one if something here needs to change."}
          </p>
        </div>
        {isManager && serverId && (
          <div className="px-5 pb-5">
            <AuditLogSection serverId={serverId} />
          </div>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={server.name}
      eyebrow="Server settings"
      size="md"
      closeOnBackdrop={!transferArmed && !deleteArmed}
      onClose={onClose}
      footer={
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-6 px-5 py-5">
        <section className="space-y-2">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            Server name
          </h3>
          <div className="flex gap-2">
            <Input
              value={name}
              maxLength={64}
              aria-label="Server name"
              disabled={savingName}
              onChange={(e) => {
                setName(e.target.value);
                setNameSaved(false);
              }}
            />
            <Button
              disabled={
                savingName || !trimmedName || trimmedName === server.name
              }
              onClick={() => void saveName()}
            >
              {savingName ? "Saving…" : "Save"}
            </Button>
          </div>
          <p role="status" aria-live="polite" className="text-xs text-paper-muted">
            {nameSaved ? "Server renamed." : ""}
          </p>
          {nameError && (
            <p role="alert" className="text-sm text-danger">
              {nameError}
            </p>
          )}
        </section>

        <section className="space-y-2 border-t border-ink-4 pt-5">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            Transfer ownership
          </h3>
          <p className="text-sm text-paper-muted">
            The new owner gets full control of {server.name}. You become an admin
            and cannot take ownership back yourself.
          </p>

          {candidatesLoading ? (
            <p role="status" aria-live="polite" className="text-sm text-paper-muted">
              Loading members…
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-paper-muted">
              There is nobody else in this server to hand it to.
            </p>
          ) : (
            <div className="space-y-2">
              <select
                value={targetId}
                aria-label="New owner"
                disabled={transferArmed || transferring}
                className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Select a member…</option>
                {candidates.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                    {member.tag ? ` ${member.tag}` : ""}
                  </option>
                ))}
              </select>

              {!transferArmed ? (
                <Button
                  variant="secondary"
                  disabled={!targetId || busy}
                  onClick={() => setTransferArmed(true)}
                >
                  Transfer ownership
                </Button>
              ) : (
                <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <p className="text-sm text-paper">
                    Hand {server.name} to{" "}
                    <span className="font-semibold">{target?.displayName}</span>?
                    Type <span className="font-mono">{TRANSFER_PHRASE}</span> to
                    confirm.
                  </p>
                  <Input
                    value={transferPhrase}
                    aria-label={`Type ${TRANSFER_PHRASE} to confirm the transfer`}
                    autoFocus
                    disabled={transferring}
                    onChange={(e) => setTransferPhrase(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      disabled={
                        transferring ||
                        !target ||
                        transferPhrase.trim().toUpperCase() !== TRANSFER_PHRASE
                      }
                      onClick={() => void transferOwnership()}
                    >
                      {transferring ? "Transferring…" : "Confirm transfer"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={transferring}
                      onClick={() => {
                        setTransferArmed(false);
                        setTransferPhrase("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {transferError && (
            <p role="alert" className="text-sm text-danger">
              {transferError}
            </p>
          )}
        </section>

        <section className="space-y-2 border-t border-ink-4 pt-5">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            Export data
          </h3>
          <p className="text-sm text-paper-muted">
            Download every channel, member, and message in {server.name} as a
            JSON file. Attachment bytes are not included — only their
            filenames and sizes.
          </p>
          <Button
            variant="secondary"
            disabled={exporting}
            onClick={() => void exportData()}
          >
            {exporting ? "Preparing export…" : "Export server data"}
          </Button>
          {exportError && (
            <p role="alert" className="text-sm text-danger">
              {exportError}
            </p>
          )}
        </section>

        <section className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-4">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-danger">
            Delete server
          </h3>
          <p className="text-sm text-paper-muted">
            Every channel, message, and invite in {server.name} is deleted for
            everyone. This cannot be undone.
          </p>

          {!deleteArmed ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setDeleteArmed(true)}
            >
              Delete server
            </Button>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm text-paper">
                Type <span className="font-mono font-semibold">{server.name}</span>{" "}
                to confirm.
                <Input
                  className="mt-2"
                  value={deletePhrase}
                  autoFocus
                  disabled={deleting}
                  onChange={(e) => setDeletePhrase(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={deleting || deletePhrase !== server.name}
                  onClick={() => void destroyServer()}
                >
                  {deleting ? "Deleting…" : "Delete forever"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={deleting}
                  onClick={() => {
                    setDeleteArmed(false);
                    setDeletePhrase("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {deleteError && (
            <p role="alert" className="text-sm text-danger">
              {deleteError}
            </p>
          )}
        </section>

        <section className="space-y-2 border-t border-ink-4 pt-5">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            Message retention
          </h3>
          <p className="text-sm text-paper-muted">
            Automatically delete messages older than this, across every
            channel in {server.name}. Pinned messages are never touched.
          </p>
          <select
            value={retentionDays === null ? "" : String(retentionDays)}
            aria-label="Message retention"
            disabled={savingRetention}
            className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
            onChange={(e) =>
              void saveRetention(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Keep forever</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
          <p role="status" aria-live="polite" className="text-xs text-paper-muted">
            {retentionSaved ? "Retention updated." : ""}
          </p>
          {retentionError && (
            <p role="alert" className="text-sm text-danger">
              {retentionError}
            </p>
          )}
        </section>

        <section className="space-y-2 border-t border-ink-4 pt-5">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            SSO email domain
          </h3>
          <p className="text-sm text-paper-muted">
            Anyone with a verified email at this domain can join {server.name}{" "}
            without an invite. Only verified addresses count, and existing bans
            still apply. Leave empty to turn this off.
          </p>
          <div className="flex gap-2">
            <Input
              value={ssoDomain}
              placeholder="acme.com"
              aria-label="SSO email domain"
              disabled={savingSso}
              onChange={(e) => {
                setSsoDomain(e.target.value);
                setSsoSaved(false);
                setSsoError(null);
              }}
            />
            <Button
              variant="secondary"
              disabled={savingSso}
              onClick={() => void saveSso()}
            >
              {savingSso ? "Saving…" : "Save"}
            </Button>
          </div>
          <p role="status" aria-live="polite" className="text-xs text-paper-muted">
            {ssoSaved ? "SSO domain updated." : ""}
          </p>
          {ssoError && (
            <p role="alert" className="text-sm text-danger">
              {ssoError}
            </p>
          )}
        </section>

        {serverId && isManager && <ReportsSection serverId={serverId} />}

        {serverId && <AuditLogSection serverId={serverId} />}
      </div>
    </Dialog>
  );
}
