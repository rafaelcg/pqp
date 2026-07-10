import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  addChannelMember,
  fetchChannelMembers,
  fetchMembers,
  removeChannelMember,
} from "@/lib/api";

interface Person {
  id: string;
  displayName: string;
  tag: string | null;
}

interface ChannelMembersPanelProps {
  open: boolean;
  channelId: string | null;
  channelName: string | null;
  serverId: string | null;
  token: string | null;
  onClose: () => void;
}

export function ChannelMembersPanel({
  open,
  channelId,
  channelName,
  serverId,
  token,
  onClose,
}: ChannelMembersPanelProps) {
  const [channelMembers, setChannelMembers] = useState<Person[]>([]);
  const [serverMembers, setServerMembers] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token || !channelId || !serverId) {
      return;
    }
    let cancelled = false;
    setError(null);

    async function load() {
      try {
        const [channelRes, serverRes] = await Promise.all([
          fetchChannelMembers(token!, channelId!),
          fetchMembers(token!, serverId!),
        ]);
        if (cancelled) {
          return;
        }
        setChannelMembers(
          channelRes.members.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            tag: m.tag,
          })),
        );
        setServerMembers(
          serverRes.members.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            tag: m.tag,
          })),
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, token, channelId, serverId]);

  const memberIds = useMemo(
    () => new Set(channelMembers.map((m) => m.id)),
    [channelMembers],
  );

  const candidates = serverMembers.filter((m) => !memberIds.has(m.id));

  if (!open) {
    return null;
  }

  async function addMember(userId: string) {
    if (!token || !channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await addChannelMember(token, channelId, userId);
      const person = serverMembers.find((m) => m.id === userId);
      if (person) {
        setChannelMembers((prev) => [...prev, person]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(userId: string) {
    if (!token || !channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await removeChannelMember(token, channelId, userId);
      setChannelMembers((prev) => prev.filter((m) => m.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-0 sm:items-center sm:p-4">
      <div className="animate-rise flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-4 bg-ink-2 shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-end justify-between gap-3 border-b border-ink-4 px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-signal">
              Private channel
            </p>
            <h2 className="font-display text-2xl font-bold">
              #{channelName ?? "channel"}
            </h2>
            <p className="mt-1 text-xs text-paper-muted">
              Only listed members (plus owners/admins) can see this channel.
            </p>
          </div>
          <button
            type="button"
            className="text-sm text-paper-muted hover:text-paper"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {error && <p className="text-sm text-danger">{error}</p>}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
              Access ({channelMembers.length})
            </h3>
            {channelMembers.length === 0 ? (
              <p className="text-sm text-paper-muted">No members yet.</p>
            ) : (
              channelMembers.map((member) => (
                <div
                  key={member.id}
                  className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-3 text-xs font-semibold">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.displayName}
                    </p>
                    {member.tag && (
                      <p className="truncate font-mono text-[11px] text-paper-muted">
                        {member.tag}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === member.id}
                    onClick={() => void removeMember(member.id)}
                  >
                    Remove
                  </Button>
                </div>
              ))
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
              Add from server
            </h3>
            {candidates.length === 0 ? (
              <p className="text-sm text-paper-muted">
                Everyone on the server already has access.
              </p>
            ) : (
              candidates.map((member) => (
                <div
                  key={member.id}
                  className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-3 text-xs font-semibold">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.displayName}
                    </p>
                    {member.tag && (
                      <p className="truncate font-mono text-[11px] text-paper-muted">
                        {member.tag}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === member.id}
                    onClick={() => void addMember(member.id)}
                  >
                    Add
                  </Button>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
