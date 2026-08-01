import {
  AtSign,
  Ban,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  ShieldMinus,
  ShieldPlus,
  UserMinus,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import {
  ApiError,
  banMember,
  fetchMembers,
  kickMember,
  listBans,
  unbanMember,
  updateMemberRole,
  type ServerBan,
  type ServerMember,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type MemberRole = "owner" | "admin" | "member";

interface RowAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
}

interface PendingRemoval {
  member: ServerMember;
  ban: boolean;
}

interface MembersPanelProps {
  open: boolean;
  serverId: string | null;
  serverName: string | null;
  role: MemberRole;
  currentUserId: string | null;
  onClose: () => void;
  /** Receives the username slug — mentions are matched by slug, not display name. */
  onMention?: (username: string) => void;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function MembersPanel({
  open,
  serverId,
  serverName,
  role,
  currentUserId,
  onClose,
  onMention,
}: MembersPanelProps) {
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [bansOpen, setBansOpen] = useState(false);
  const [bans, setBans] = useState<ServerBan[]>([]);
  const [bansLoading, setBansLoading] = useState(false);
  const [bansError, setBansError] = useState<string | null>(null);

  const canManage = role === "owner" || role === "admin";

  useEffect(() => {
    if (!open || !serverId) {
      return;
    }
    let cancelled = false;
    setPending(null);
    setBansOpen(false);
    setBans([]);
    setBansError(null);
    setError(null);
    setLoading(true);
    void fetchMembers(serverId)
      .then((res) => {
        if (!cancelled) {
          setMembers(res.members);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(messageOf(err, "Failed to load members"));
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
  }, [open, serverId]);

  const loadBans = useCallback(async () => {
    if (!serverId) {
      return;
    }
    setBansLoading(true);
    setBansError(null);
    try {
      const res = await listBans(serverId);
      setBans(res.bans);
    } catch (err) {
      setBansError(messageOf(err, "Failed to load bans"));
    } finally {
      setBansLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (!open || !canManage || !bansOpen) {
      return;
    }
    void loadBans();
  }, [open, canManage, bansOpen, loadBans]);

  if (!open) {
    return null;
  }

  // Kick/ban: the owner can act on members and admins; an admin can act only on
  // plain members. Never on the owner or yourself.
  function canModerate(member: ServerMember): boolean {
    if (!canManage || member.role === "owner" || member.id === currentUserId) {
      return false;
    }
    return role === "owner" || member.role === "member";
  }

  async function setRole(userId: string, next: "admin" | "member") {
    if (!serverId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await updateMemberRole(serverId, userId, next);
      setMembers((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, role: next } : m)),
      );
    } catch (err) {
      setError(messageOf(err, "Failed to update role"));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRemoval() {
    if (!serverId || !pending) {
      return;
    }
    const { member, ban } = pending;
    setBusyId(member.id);
    setError(null);
    try {
      if (ban) {
        await banMember(serverId, member.id);
      } else {
        await kickMember(serverId, member.id);
      }
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      setPending(null);
      if (ban && bansOpen) {
        void loadBans();
      }
    } catch (err) {
      setError(
        messageOf(err, ban ? "Failed to ban member" : "Failed to remove member"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function unban(userId: string) {
    if (!serverId) {
      return;
    }
    setBusyId(userId);
    setBansError(null);
    try {
      await unbanMember(serverId, userId);
      setBans((prev) => prev.filter((b) => b.userId !== userId));
    } catch (err) {
      setBansError(messageOf(err, "Failed to lift ban"));
    } finally {
      setBusyId(null);
    }
  }

  function actionsFor(member: ServerMember): RowAction[] {
    const actions: RowAction[] = [];
    if (onMention && member.username) {
      const username = member.username;
      actions.push({
        id: "mention",
        label: "Mention",
        icon: AtSign,
        onSelect: () => onMention(username),
      });
    }
    if (role === "owner" && member.role !== "owner" && member.id !== currentUserId) {
      actions.push(
        member.role === "member"
          ? {
              id: "promote",
              label: "Promote to admin",
              icon: ShieldPlus,
              onSelect: () => void setRole(member.id, "admin"),
            }
          : {
              id: "demote",
              label: "Demote to member",
              icon: ShieldMinus,
              onSelect: () => void setRole(member.id, "member"),
            },
      );
    }
    if (canModerate(member)) {
      actions.push(
        {
          id: "kick",
          label: "Remove from server",
          icon: UserMinus,
          onSelect: () => setPending({ member, ban: false }),
          danger: true,
        },
        {
          id: "ban",
          label: "Ban from server",
          icon: Ban,
          onSelect: () => setPending({ member, ban: true }),
          danger: true,
        },
      );
    }
    return actions;
  }

  if (pending) {
    const name = pending.member.displayName;
    return (
      <Dialog
        open
        title={pending.ban ? `Ban ${name}?` : `Remove ${name}?`}
        eyebrow="Confirm"
        size="lg"
        closeOnBackdrop={false}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busyId === pending.member.id}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busyId === pending.member.id}
              onClick={() => void confirmRemoval()}
            >
              {busyId === pending.member.id
                ? "Working…"
                : pending.ban
                  ? "Ban member"
                  : "Remove member"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 px-5 py-5">
          <p className="text-sm text-paper">
            <span className="font-semibold">{name}</span>
            {pending.member.tag && (
              <span className="font-mono text-paper-muted">
                {" "}
                {pending.member.tag}
              </span>
            )}{" "}
            will be removed from{" "}
            <span className="font-semibold">{serverName ?? "this server"}</span>
            {pending.ban
              ? " and cannot rejoin by invite until the ban is lifted."
              : ". They can rejoin with a new invite."}
          </p>
          {pending.ban && (
            <p className="text-sm text-paper-muted">
              Lift the ban from the Banned section to let them back in.
            </p>
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

  return (
    <Dialog
      open
      title={serverName ?? "Server"}
      eyebrow="Members"
      size="lg"
      onClose={onClose}
    >
      <div className="p-3">
        {error && (
          <p role="alert" className="mb-3 px-2 text-sm text-danger">
            {error}
          </p>
        )}

        {loading && (
          <p role="status" aria-live="polite" className="px-2 py-6 text-sm text-paper-muted">
            Loading members…
          </p>
        )}

        {!loading && members.length === 0 && !error && (
          <p className="px-2 py-6 text-sm text-paper-muted">
            Nobody here yet. Invite people to get started.
          </p>
        )}

        {members.map((member) => {
          const actions = actionsFor(member);
          const busy = busyId === member.id;
          const items: ContextMenuItemDef[] = [];
          let separated = false;
          for (const action of actions) {
            if (action.danger && !separated && items.length > 0) {
              separated = true;
              items.push({ id: "sep", label: "", separator: true });
            }
            items.push({
              id: action.id,
              label: action.label,
              onSelect: action.onSelect,
              danger: action.danger,
              disabled: busy,
            });
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
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    member.role === "owner"
                      ? "bg-signal/15 text-signal"
                      : member.role === "admin"
                        ? "bg-warning/15 text-warning"
                        : "bg-ink-4 text-paper-muted",
                  )}
                >
                  {member.role}
                </span>
                {actions.length > 0 && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {actions.map((action) => (
                      <Button
                        key={action.id}
                        size="icon"
                        variant={action.danger ? "danger" : "ghost"}
                        className="h-8 w-8"
                        aria-label={`${action.label}: ${member.displayName}`}
                        title={action.label}
                        disabled={busy}
                        onClick={action.onSelect}
                      >
                        <action.icon className="h-4 w-4" />
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </ContextMenu>
          );
        })}

        {canManage && (
          <div className="mt-3 border-t border-ink-4 pt-3">
            <button
              type="button"
              aria-expanded={bansOpen}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={() => setBansOpen((prev) => !prev)}
            >
              {bansOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Banned
            </button>

            {bansOpen && (
              <div className="mt-1">
                {bansError && (
                  <p role="alert" className="px-2 pb-2 text-sm text-danger">
                    {bansError}
                  </p>
                )}
                {bansLoading && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="px-2 py-4 text-sm text-paper-muted"
                  >
                    Loading bans…
                  </p>
                )}
                {!bansLoading && bans.length === 0 && !bansError && (
                  <p className="px-2 py-4 text-sm text-paper-muted">
                    Nobody is banned from this server.
                  </p>
                )}
                {bans.map((banned) => (
                  <div
                    key={banned.userId}
                    className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-3 text-sm font-semibold">
                      {banned.displayName.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {banned.displayName}
                      </p>
                      {banned.tag && (
                        <p className="truncate font-mono text-[11px] text-paper-muted">
                          {banned.tag}
                        </p>
                      )}
                      {banned.reason && (
                        <p className="truncate text-[11px] text-paper-muted">
                          {banned.reason}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5"
                      disabled={busyId === banned.userId}
                      onClick={() => void unban(banned.userId)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {busyId === banned.userId ? "Working…" : "Unban"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
