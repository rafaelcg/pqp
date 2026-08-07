import {
  AtSign,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  Flag,
  RotateCcw,
  ShieldMinus,
  ShieldPlus,
  TimerReset,
  UserCheck,
  UserMinus,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  TIMEOUT_PRESET_MINUTES,
  TIMEOUT_REASON_MAX_LENGTH,
  type MemberTimeout,
} from "@pqp/shared";
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
  liftTimeout,
  listBans,
  listTimeouts,
  timeoutMember,
  unbanMember,
  updateMemberRole,
  type ServerBan,
  type ServerMember,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type MemberRole = "owner" | "admin" | "member";

/** "45 minutes", "7 days" — a duration a moderator reads, not 10080. */
function describeMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (minutes < 60 * 24) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = minutes / (60 * 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * How long is left, in the coarsest unit that is still honest.
 *
 * Computed from the absolute `expiresAt` the server sent rather than from a
 * duration it counted down, so a tab left open overnight is stale by a render
 * rather than wrong by twelve hours.
 */
function timeRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return "expiring now";
  }
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m left`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours}h left`;
  }
  return `${Math.ceil(hours / 24)}d left`;
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString();
}

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

/** The member a timeout is being composed for, plus the composed values. */
interface PendingTimeout {
  member: ServerMember;
  minutes: number;
  reason: string;
}

interface MembersPanelProps {
  open: boolean;
  serverId: string | null;
  serverName: string | null;
  role: MemberRole;
  currentUserId: string | null;
  /** Who this account has blocked, so a row offers the action it does not have. */
  blockedUserIds: ReadonlySet<string>;
  onClose: () => void;
  /** Receives the username slug — mentions are matched by slug, not display name. */
  onMention?: (username: string) => void;
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  /** Opens the report dialog for this member, in this server's context. */
  onReportUser?: (member: ServerMember) => void;
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
  blockedUserIds,
  onClose,
  onMention,
  onBlockUser,
  onUnblockUser,
  onReportUser,
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
  const [pendingTimeout, setPendingTimeout] = useState<PendingTimeout | null>(
    null,
  );
  const [timeouts, setTimeouts] = useState<MemberTimeout[]>([]);
  const [timeoutsError, setTimeoutsError] = useState<string | null>(null);

  const canManage = role === "owner" || role === "admin";
  const timeoutByUser = new Map(timeouts.map((one) => [one.userId, one]));

  useEffect(() => {
    if (!open || !serverId) {
      return;
    }
    let cancelled = false;
    setPending(null);
    setPendingTimeout(null);
    setBansOpen(false);
    setBans([]);
    setBansError(null);
    setTimeouts([]);
    setTimeoutsError(null);
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
    // Loaded alongside the roster rather than behind a disclosure the way bans
    // are: a timeout is a *live* state of somebody in the list above, and the
    // row has to be able to say so. A failure here is not fatal to the panel —
    // the roster still renders, minus the badges — so it gets its own error
    // line rather than replacing the members error.
    if (canManage) {
      void listTimeouts(serverId)
        .then((res) => {
          if (!cancelled) {
            setTimeouts(res.timeouts);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setTimeoutsError(messageOf(err, "Failed to load timeouts"));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, serverId, canManage]);

  const reloadTimeouts = useCallback(async () => {
    if (!serverId || !canManage) {
      return;
    }
    try {
      setTimeouts((await listTimeouts(serverId)).timeouts);
      setTimeoutsError(null);
    } catch (err) {
      setTimeoutsError(messageOf(err, "Failed to load timeouts"));
    }
  }, [serverId, canManage]);

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

  async function confirmTimeout() {
    if (!serverId || !pendingTimeout) {
      return;
    }
    const { member, minutes, reason } = pendingTimeout;
    setBusyId(member.id);
    setError(null);
    try {
      await timeoutMember(serverId, member.id, minutes, reason.trim() || null);
      setPendingTimeout(null);
      await reloadTimeouts();
    } catch (err) {
      setError(messageOf(err, "Failed to time out member"));
    } finally {
      setBusyId(null);
    }
  }

  async function endTimeout(userId: string) {
    if (!serverId) {
      return;
    }
    setBusyId(userId);
    setTimeoutsError(null);
    try {
      await liftTimeout(serverId, userId);
      setTimeouts((prev) => prev.filter((one) => one.userId !== userId));
    } catch (err) {
      setTimeoutsError(messageOf(err, "Failed to lift the timeout"));
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
    // Offered for anybody but yourself, whatever their role. Blocking is not
    // moderation: it is the thing a member does *instead* of asking a moderator
    // to act, so gating it on the target's rank would leave the person with the
    // least power the only one with no option at all.
    if (member.id !== currentUserId) {
      actions.push(
        blockedUserIds.has(member.id)
          ? {
              id: "unblock",
              label: "Unblock",
              icon: UserCheck,
              onSelect: () => onUnblockUser(member.id),
            }
          : {
              id: "block",
              label: "Block",
              icon: UserX,
              onSelect: () => onBlockUser(member.id),
              danger: true,
            },
      );
    }
    // Like blocking, offered for anybody but yourself whatever their rank —
    // including an admin, since the person a member most needs to be able to
    // report is sometimes the person with the power. Where the report goes is
    // the server's decision; this only says who it is about.
    if (onReportUser && member.id !== currentUserId) {
      actions.push({
        id: "report",
        label: "Report",
        icon: Flag,
        onSelect: () => onReportUser(member),
        danger: true,
      });
    }
    if (canModerate(member)) {
      // Listed before kick and ban, and not marked `danger`, because the order
      // and the colour of this menu are the enforcement ladder as a moderator
      // experiences it. A timeout is the reversible one; putting it in the red
      // block next to "Ban from server" would teach the opposite.
      const active = timeoutByUser.get(member.id);
      actions.push(
        active
          ? {
              id: "untimeout",
              label: `End timeout (${timeRemaining(active.expiresAt)})`,
              icon: TimerReset,
              onSelect: () => void endTimeout(member.id),
            }
          : {
              id: "timeout",
              label: "Time out",
              icon: Clock,
              onSelect: () =>
                setPendingTimeout({
                  member,
                  minutes: TIMEOUT_PRESET_MINUTES[1]!,
                  reason: "",
                }),
            },
      );
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

  if (pendingTimeout) {
    const name = pendingTimeout.member.displayName;
    const busy = busyId === pendingTimeout.member.id;
    return (
      <Dialog
        open
        title={`Time out ${name}?`}
        eyebrow="Confirm"
        size="lg"
        closeOnBackdrop={false}
        onClose={() => setPendingTimeout(null)}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setPendingTimeout(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void confirmTimeout()}
            >
              {busy
                ? "Working…"
                : `Time out for ${describeMinutes(pendingTimeout.minutes)}`}
            </Button>
          </>
        }
      >
        <div className="space-y-4 px-5 py-5">
          {/* Says what a timeout is *not*, because that is the part a moderator
              reaching for the ban button does not know yet. */}
          <p className="text-sm text-paper">
            <span className="font-semibold">{name}</span>
            {pendingTimeout.member.tag && (
              <span className="font-mono text-paper-muted">
                {" "}
                {pendingTimeout.member.tag}
              </span>
            )}{" "}
            stays in{" "}
            <span className="font-semibold">{serverName ?? "this server"}</span>{" "}
            and can still read every channel. They cannot post, react or join
            voice until the timeout ends. It does not touch their direct
            messages.
          </p>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
              How long
            </legend>
            <div className="flex flex-wrap gap-2">
              {TIMEOUT_PRESET_MINUTES.map((minutes) => (
                <Button
                  key={minutes}
                  size="sm"
                  variant={
                    pendingTimeout.minutes === minutes ? "secondary" : "ghost"
                  }
                  aria-pressed={pendingTimeout.minutes === minutes}
                  disabled={busy}
                  onClick={() =>
                    setPendingTimeout((prev) =>
                      prev ? { ...prev, minutes } : prev,
                    )
                  }
                >
                  {describeMinutes(minutes)}
                </Button>
              ))}
            </div>
          </fieldset>

          <div>
            <label
              htmlFor="timeout-reason"
              className="mb-2 block text-xs font-semibold uppercase tracking-wider text-paper-muted"
            >
              Why (kept in the audit log)
            </label>
            <input
              id="timeout-reason"
              type="text"
              value={pendingTimeout.reason}
              maxLength={TIMEOUT_REASON_MAX_LENGTH}
              disabled={busy}
              placeholder="Optional — but this is what you will read next week"
              className="w-full rounded-md border border-ink-4 bg-ink-2 px-3 py-2 text-sm text-paper placeholder:text-paper-muted"
              onChange={(event) => {
                const reason = event.target.value;
                setPendingTimeout((prev) => (prev ? { ...prev, reason } : prev));
              }}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    );
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

        {timeoutsError && (
          <p role="alert" className="mb-3 px-2 text-sm text-danger">
            {timeoutsError}
          </p>
        )}

        {members.map((member) => {
          const actions = actionsFor(member);
          const busy = busyId === member.id;
          const timeout = timeoutByUser.get(member.id);
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
                  {/* Who did it, when, why, and when it ends — on the row, not
                      three clicks away in the audit log. This is the whole
                      reason `listTimeouts` returns more than a boolean. */}
                  {timeout && (
                    <p className="truncate text-[11px] text-warning">
                      Timed out until {formatMoment(timeout.expiresAt)} (
                      {timeRemaining(timeout.expiresAt)}) by{" "}
                      {timeout.issuedByName ?? "a former moderator"} on{" "}
                      {formatMoment(timeout.createdAt)}
                      {timeout.reason ? ` — ${timeout.reason}` : ""}
                    </p>
                  )}
                </div>
                {timeout && (
                  <span
                    className="flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning"
                    title={`Timed out until ${formatMoment(timeout.expiresAt)}`}
                  >
                    <Clock className="h-3 w-3" />
                    {timeRemaining(timeout.expiresAt)}
                  </span>
                )}
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
