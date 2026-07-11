import { useEffect, useState } from "react";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { banMember, fetchMembers, kickMember, updateMemberRole } from "@/lib/api";

interface MemberRow {
  id: string;
  displayName: string;
  tag: string | null;
  role: "owner" | "admin" | "member";
  avatarUrl: string | null;
}

interface MembersPanelProps {
  open: boolean;
  serverId: string | null;
  serverName: string | null;
  token: string | null;
  isOwner: boolean;
  canManage?: boolean;
  currentUserId: string | null;
  onClose: () => void;
  onMention?: (displayName: string) => void;
}

export function MembersPanel({
  open,
  serverId,
  serverName,
  token,
  isOwner,
  canManage = false,
  currentUserId,
  onClose,
  onMention,
}: MembersPanelProps) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token || !serverId) {
      return;
    }
    let cancelled = false;
    setError(null);
    void fetchMembers(token, serverId)
      .then((res) => {
        if (!cancelled) {
          setMembers(res.members);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load members");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, serverId]);

  if (!open) {
    return null;
  }

  async function setRole(userId: string, role: "admin" | "member") {
    if (!token || !serverId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await updateMemberRole(token, serverId, userId, role);
      setMembers((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, role } : m)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(
    member: MemberRow,
    mode: "kick" | "ban",
  ) {
    if (!token || !serverId) {
      return;
    }
    const verb = mode === "ban" ? "Ban" : "Kick";
    if (!window.confirm(`${verb} ${member.displayName}?`)) {
      return;
    }
    setBusyId(member.id);
    setError(null);
    try {
      if (mode === "ban") {
        await banMember(token, serverId, member.id);
      } else {
        await kickMember(token, serverId, member.id);
      }
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${mode} member`);
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
              Members
            </p>
            <h2 className="font-display text-2xl font-bold">
              {serverName ?? "Server"}
            </h2>
            {isOwner && (
              <p className="mt-1 text-xs text-paper-muted">
                Right-click a member to promote or demote admins.
              </p>
            )}
          </div>
          <button
            type="button"
            className="text-sm text-paper-muted hover:text-paper"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {error && <p className="mb-3 px-2 text-sm text-danger">{error}</p>}
          {members.map((member) => {
            const items: ContextMenuItemDef[] = [
              {
                id: "mention",
                label: "Mention",
                onSelect: () => onMention?.(member.displayName),
              },
            ];
            if (isOwner && member.role !== "owner" && member.id !== currentUserId) {
              items.push({ id: "sep", label: "", separator: true });
              if (member.role === "member") {
                items.push({
                  id: "promote",
                  label: "Promote to admin",
                  onSelect: () => void setRole(member.id, "admin"),
                  disabled: busyId === member.id,
                });
              } else {
                items.push({
                  id: "demote",
                  label: "Demote to member",
                  onSelect: () => void setRole(member.id, "member"),
                  disabled: busyId === member.id,
                });
              }
            }

            // Kick/ban: owner can act on members and admins; an admin can act
            // only on plain members. Never on the owner or yourself.
            const canModerate =
              canManage &&
              member.role !== "owner" &&
              member.id !== currentUserId &&
              (isOwner || member.role === "member");
            if (canModerate) {
              items.push(
                { id: "sep-mod", label: "", separator: true },
                {
                  id: "kick",
                  label: "Kick from server",
                  danger: true,
                  onSelect: () => void removeMember(member, "kick"),
                  disabled: busyId === member.id,
                },
                {
                  id: "ban",
                  label: "Ban from server",
                  danger: true,
                  onSelect: () => void removeMember(member, "ban"),
                  disabled: busyId === member.id,
                },
              );
            }

            return (
              <ContextMenu key={member.id} items={items}>
                <div className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-3 text-sm font-semibold">
                    {member.avatarUrl ? (
                      <img
                        src={member.avatarUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      member.displayName.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {member.displayName}
                    </p>
                    {member.tag && (
                      <p className="truncate font-mono text-[11px] text-paper-muted">
                        {member.tag}
                      </p>
                    )}
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      member.role === "owner"
                        ? "bg-signal/15 text-signal"
                        : member.role === "admin"
                          ? "bg-warning/15 text-warning"
                          : "bg-ink-4 text-paper-muted"
                    }`}
                  >
                    {member.role}
                  </span>
                  {isOwner && member.role === "member" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === member.id}
                      onClick={() => void setRole(member.id, "admin")}
                    >
                      Admin
                    </Button>
                  )}
                  {isOwner && member.role === "admin" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === member.id}
                      onClick={() => void setRole(member.id, "member")}
                    >
                      Demote
                    </Button>
                  )}
                </div>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}
