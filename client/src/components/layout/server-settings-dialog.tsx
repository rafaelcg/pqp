import type { Server } from "@pqp/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  deleteServer,
  fetchMembers,
  updateServer,
  type ServerMember,
} from "@/lib/api";

const TRANSFER_PHRASE = "TRANSFER";

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

  const serverId = server?.id ?? null;
  const isOwner = server?.role === "owner";

  // Seeded from a ref so a rename landing in the parent does not overwrite what
  // is being typed here; the form only resets when the dialog opens.
  const serverNameRef = useRef(server?.name ?? "");
  serverNameRef.current = server?.name ?? "";

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
        <div className="px-5 py-5">
          <p className="text-sm text-paper-muted">
            Only the server owner can rename this server, transfer ownership, or
            delete it. Ask an owner if something here needs to change.
          </p>
        </div>
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
      </div>
    </Dialog>
  );
}
