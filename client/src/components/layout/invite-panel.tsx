import { useState } from "react";
import type { Invite } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createInvite, joinInvite } from "@/lib/api";

interface InvitePanelProps {
  open: boolean;
  mode: "create" | "join";
  serverId: string | null;
  serverName: string | null;
  token: string | null;
  canManage: boolean;
  onClose: () => void;
  onJoined: (serverId: string) => void;
}

export function InvitePanel({
  open,
  mode,
  serverId,
  serverName,
  token,
  canManage,
  onClose,
  onJoined,
}: InvitePanelProps) {
  const [code, setCode] = useState("");
  const [created, setCreated] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!open) {
    return null;
  }

  async function handleCreate() {
    if (!token || !serverId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { invite } = await createInvite(token, serverId, {
        expiresInHours: 168,
      });
      setCreated(invite);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!token || !code.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await joinInvite(token, code.trim());
      onJoined(result.serverId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!created) {
      return;
    }
    await navigator.clipboard.writeText(created.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 sm:items-center sm:p-4">
      <div className="animate-rise w-full max-w-md rounded-t-2xl border border-ink-4 bg-ink-2 p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-signal">
              {mode === "create" ? "Invite people" : "Join a server"}
            </p>
            <h2 className="font-display text-xl font-bold">
              {mode === "create"
                ? serverName ?? "Server"
                : "Enter invite code"}
            </h2>
          </div>
          <button
            type="button"
            className="text-sm text-paper-muted"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {mode === "create" && canManage && (
          <div className="space-y-3">
            {!created ? (
              <Button onClick={() => void handleCreate()} disabled={busy}>
                {busy ? "Creating…" : "Create invite link"}
              </Button>
            ) : (
              <div className="rounded-lg border border-ink-4 bg-ink p-4">
                <p className="mb-2 text-xs text-paper-muted">Invite code</p>
                <p className="font-display text-3xl font-bold tracking-wide text-signal">
                  {created.code}
                </p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={() => void copyCode()}
                >
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
            )}
          </div>
        )}

        {mode === "create" && !canManage && (
          <p className="text-sm text-paper-muted">
            Only owners and admins can create invites.
          </p>
        )}

        {mode === "join" && (
          <div className="space-y-3">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Invite code"
              autoFocus
            />
            <Button onClick={() => void handleJoin()} disabled={busy}>
              {busy ? "Joining…" : "Join server"}
            </Button>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
