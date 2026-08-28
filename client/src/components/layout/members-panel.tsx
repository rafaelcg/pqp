import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TIMEOUT_PRESET_MINUTES,
  TIMEOUT_REASON_MAX_LENGTH,
  type MemberTimeout,
  type VoiceParticipant,
  type VoiceRoomTransport,
} from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  type ContextMenuItemDef,
} from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { StatusDot } from "@/components/user/status-dot";
import { RankMarks } from "@/components/user/rank-marks";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import type { ProfileSubject } from "@/components/user/profile-relations";
import { identityMarks } from "@/lib/author-display";
import { translateMessage, useTranslation } from "@/lib/i18n";
import {
  ApiError,
  banMember,
  disconnectMemberVoice,
  fetchMembers,
  kickMember,
  liftTimeout,
  listBans,
  listTimeouts,
  memberDisplayName,
  memberMatchesQuery,
  moveMemberVoice,
  setMemberVoiceMuted,
  timeoutMember,
  unbanMember,
  updateMemberNickname,
  updateMemberRole,
  type ServerBan,
  type ServerMember,
} from "@/lib/api";
import { cn, formatFullTimestamp } from "@/lib/utils";

type MemberRole = "owner" | "admin" | "member";

/** "45 minutes", "7 days" — a duration a moderator reads, not 10080. */
function describeMinutes(minutes: number): string {
  if (minutes < 60) {
    return translateMessage("timeout.minutes", { count: minutes });
  }
  if (minutes < 60 * 24) {
    const hours = minutes / 60;
    return translateMessage("timeout.hours", { count: hours });
  }
  const days = minutes / (60 * 24);
  return translateMessage("timeout.days", { count: days });
}

function timeRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return translateMessage("timeout.expiring");
  }
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) {
    return translateMessage("timeout.left.minutes", { count: minutes });
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return translateMessage("timeout.left.hours", { count: hours });
  }
  return translateMessage("timeout.left.days", { count: Math.ceil(hours / 24) });
}

function formatMoment(iso: string): string {
  return formatFullTimestamp(iso);
}

/**
 * One entry in the row's context menu. The row itself draws no action chrome:
 * these surface on right-click (or long-press), and the same set lives on the
 * profile card for anybody without a right-click.
 */
interface RowAction {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

function menuFromActions(
  actions: RowAction[],
  busy: boolean,
): ContextMenuItemDef[] {
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
  return items;
}

/**
 * Clickable ⋯ for the actions that used to be a row of unlabeled icons.
 * Right-click still opens the same set via ContextMenu; this is the affordance
 * a trackpad user can actually find. The well is a square so it can sit on
 * the same centerline as the name, instead of hanging off a stretched cell.
 */
function RowMenu({
  items,
  label,
}: {
  items: ContextMenuItemDef[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative mr-2 flex shrink-0 items-center">
      <Tooltip label={label}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 w-8 items-center justify-center rounded-full text-paper-muted hover:bg-ink-3 hover:text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((was) => !was);
          }}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {items.map((item) =>
            item.separator ? (
              <div
                key={item.id}
                role="separator"
                className="my-1 h-px bg-ink-4"
              />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-ink-3 focus-visible:bg-ink-3 disabled:opacity-50",
                  item.danger ? "text-danger" : "text-paper",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// --- voice moderation ---

/** Where a member currently is in this server's voice, per the live roster. */
interface MemberVoicePresence {
  channelId: string;
  channelName: string;
  /** Undefined when the roster predates the transport field. */
  transport: VoiceRoomTransport | undefined;
  muted: boolean;
  deafened: boolean;
}

function MemberRow({
  member,
  items,
  timeoutLine,
  voice,
  actionsLabel,
  onOpen,
}: {
  member: ServerMember;
  items: ContextMenuItemDef[];
  timeoutLine: string | null;
  voice: MemberVoicePresence | undefined;
  actionsLabel: string;
  onOpen: (anchor: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const shown = memberDisplayName(member);
  return (
    <ContextMenu items={items}>
      <div className="flex items-center hover:bg-ink-3">
        <button
          type="button"
          title={t("profile.open", { name: shown })}
          data-member-trigger={member.id}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <span className="relative shrink-0">
            <UserAvatar
              name={shown}
              avatarUrl={member.avatarUrl}
              className="h-10 w-10"
              rounded="full"
              fallbackClassName="bg-ink-3 text-sm"
            />
            <StatusDot
              status={member.status ?? "offline"}
              className="absolute -bottom-0.5 -right-0.5"
              ringClassName="rounded-full bg-ink-2 ring-2 ring-ink-2"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-paper">
                {shown}
              </span>
              <RankMarks
                marks={identityMarks({
                  rank: member.role,
                })}
              />
            </span>
            {timeoutLine && (
              <span
                className="block truncate text-[11px] text-warning"
                title={timeoutLine}
              >
                {timeoutLine}
              </span>
            )}
            {voice && (
              <span className="block truncate text-[11px] text-signal">
                {t("memberList.inVoice", {
                  channel: voice.channelName,
                })}
                {voice.deafened ? (
                  <span className="text-danger">
                    {" "}
                    {t("timeout.deafened")}
                  </span>
                ) : (
                  voice.muted && (
                    <span className="text-danger">
                      {" "}
                      {t("timeout.muted")}
                    </span>
                  )
                )}
              </span>
            )}
          </span>
        </button>
        <RowMenu items={items} label={actionsLabel} />
      </div>
    </ContextMenu>
  );
}

/** The member a move is being composed for. */
interface PendingMove {
  member: ServerMember;
  fromChannelId: string;
}

/**
 * Why a server mute is refused on a mesh room — client-side copy of the same
 * sentence the API answers with, so the tooltip can be honest without a round
 * trip. Media in a mesh room flows peer-to-peer; there is no server in the
 * audio path to do the muting, and faking it client-side would be enforcement
 * theater.
 */
function meshMuteUnavailable(): string {
  return translateMessage("timeout.mesh");
}

interface PendingRemoval {
  member: ServerMember;
  ban: boolean;
}

/**
 * How often an open panel re-reads statuses.
 *
 * PULLED, NOT PUSHED — and this interval is the whole reason that is affordable.
 * A pushed status has to reach every member of every server the changing person
 * shares, so at a thousand concurrent users a few idle transitions a second
 * become hundreds of frames a second, nearly all of them delivered to clients
 * with no member list open. Re-reading costs one request per *open panel*, which
 * is a far smaller number and is exactly zero while nobody is looking.
 *
 * Fifteen seconds because status is a soft fact: nobody is harmed by learning
 * ten seconds late that a colleague stepped away, and the request is a single
 * indexed query plus an in-memory lookup. It also silently repairs a tab left
 * open across a reconnect, which a push design has to handle explicitly.
 */
const STATUS_REFRESH_MS = 15_000;

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
  // --- voice moderation ---
  /** channelId → participants, straight from the live `voice-roster` frames. */
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  /** channelId → the transport that room runs on (gates the SFU-only mute). */
  voiceRoomTransports?: Record<string, VoiceRoomTransport>;
  /** This server's voice channels — the "in voice" label and move targets. */
  voiceChannels?: Array<{ id: string; name: string }>;
}

/**
 * A roster row, as the profile card wants it. The panel already resolved this
 * person's presence server-side, so the card is handed it rather than left to
 * guess — see `resolvePresence`, which never invents an `offline`.
 */
function subjectOf(member: ServerMember): ProfileSubject {
  return {
    id: member.id,
    displayName: memberDisplayName(member),
    tag: member.tag ?? null,
    avatarUrl: member.avatarUrl ?? null,
    status: member.status ?? null,
    username: member.username ?? null,
    roleIds: member.roleIds,
    rank: member.role,
    // The raw nickname too, so the card's Change-nickname prompt can prefill
    // it instead of starting from blank.
    nickname: member.nickname ?? null,
  };
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
  voiceOccupancy = {},
  voiceRoomTransports = {},
  voiceChannels = [],
}: MembersPanelProps) {
  const { t } = useTranslation();
  const openProfile = useProfilePopover();
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
  // --- voice moderation ---
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  /** A quiet explanation line ("that needs the SFU"), never an error banner. */
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  /** The directory filter. Matches name, username and tag. */
  const [query, setQuery] = useState("");

  const canManage = role === "owner" || role === "admin";
  const timeoutByUser = new Map(timeouts.map((one) => [one.userId, one]));

  // userId → where they are in *this server's* voice, from the live rosters.
  // Occupancy also carries other servers' rooms and DM calls this account can
  // see; restricting to this server's voice channels is what keeps a server's
  // moderators away from everything that is not theirs.
  const voiceByUser = new Map<string, MemberVoicePresence>();
  for (const channel of voiceChannels) {
    for (const person of voiceOccupancy[channel.id] ?? []) {
      voiceByUser.set(person.userId, {
        channelId: channel.id,
        channelName: channel.name,
        transport: voiceRoomTransports[channel.id],
        muted: person.muted,
        deafened: person.deafened,
      });
    }
  }

  // Same identifiers the row paints, plus the account display name so a
  // nickname cannot hide someone from a query typed from the name the rest
  // of the app uses. Username and tag stay in the haystack for @mentions.
  const visibleMembers = members.filter((member) =>
    memberMatchesQuery(member, query),
  );

  useEffect(() => {
    if (!open || !serverId) {
      return;
    }
    let cancelled = false;
    setPending(null);
    setPendingTimeout(null);
    setPendingMove(null);
    setVoiceHint(null);
    setQuery("");
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
          setError(messageOf(err, t("member.loadFailed")));
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
            setTimeoutsError(messageOf(err, t("timeout.loadFailed")));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, serverId, canManage]);

  /**
   * Keep statuses fresh without re-rendering the whole roster.
   *
   * Only the `status` field is merged back in, and only for members already on
   * screen. Replacing the list wholesale would fight every optimistic update the
   * panel makes — a promotion, a kick, a lifted timeout — by reinstating the
   * server's older answer a few seconds later. A member who joined since the
   * panel opened is picked up the next time it opens; that is the right trade
   * for a dialog somebody has open for thirty seconds.
   *
   * Deliberately paused while a confirmation dialog is up: those replace the
   * whole panel, so there is nothing on screen to refresh, and a background poll
   * behind a "Ban member?" question is pure noise.
   */
  useEffect(() => {
    if (!open || !serverId || pending || pendingTimeout || pendingMove) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchMembers(serverId)
        .then((res) => {
          if (cancelled) {
            return;
          }
          const statuses = new Map(res.members.map((one) => [one.id, one.status]));
          setMembers((prev) =>
            prev.map((member) =>
              statuses.has(member.id)
                ? { ...member, status: statuses.get(member.id) }
                : member,
            ),
          );
        })
        // A failed refresh leaves the last known statuses on screen. They are
        // stale, not wrong, and an error banner for a background poll would
        // teach people to ignore the banner.
        .catch(() => {});
    }, STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, serverId, pending, pendingTimeout, pendingMove]);

  const reloadTimeouts = useCallback(async () => {
    if (!serverId || !canManage) {
      return;
    }
    try {
      setTimeouts((await listTimeouts(serverId)).timeouts);
      setTimeoutsError(null);
    } catch (err) {
      setTimeoutsError(messageOf(err, t("timeout.loadFailed")));
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
      setBansError(messageOf(err, t("member.bansLoadFailed")));
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

  async function changeNickname(member: ServerMember) {
    if (!serverId) {
      return;
    }
    const next = window.prompt(
      t("member.nicknamePrompt"),
      member.nickname ?? "",
    );
    if (next === null) {
      return;
    }
    const trimmed = next.trim();
    setBusyId(member.id);
    setError(null);
    try {
      const nickname = trimmed.length === 0 ? null : trimmed;
      await updateMemberNickname(serverId, member.id, nickname);
      setMembers((prev) =>
        prev.map((row) =>
          row.id === member.id ? { ...row, nickname } : row,
        ),
      );
    } catch (err) {
      setError(messageOf(err, t("member.nicknameFailed")));
    } finally {
      setBusyId(null);
    }
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
      setError(messageOf(err, t("member.roleFailed")));
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
        messageOf(err, ban ? t("member.banFailed") : t("member.removeFailed")),
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
      setError(messageOf(err, t("member.timeoutFailed")));
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
      setTimeoutsError(messageOf(err, t("timeout.liftFailed")));
    } finally {
      setBusyId(null);
    }
  }

  // --- voice moderation ---

  async function disconnectVoice(member: ServerMember) {
    if (!serverId) {
      return;
    }
    setBusyId(member.id);
    setError(null);
    setVoiceHint(null);
    try {
      await disconnectMemberVoice(serverId, member.id);
      // No local list surgery: the roster broadcast that follows the eviction
      // is what removes their voice line, and it is the authority anyway.
    } catch (err) {
      setError(messageOf(err, t("member.disconnectFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmMove(channelId: string) {
    if (!serverId || !pendingMove) {
      return;
    }
    const { member } = pendingMove;
    setBusyId(member.id);
    setError(null);
    try {
      await moveMemberVoice(serverId, member.id, channelId);
      setPendingMove(null);
    } catch (err) {
      setError(messageOf(err, t("member.moveFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function serverMuteVoice(member: ServerMember) {
    if (!serverId) {
      return;
    }
    setBusyId(member.id);
    setError(null);
    setVoiceHint(null);
    try {
      await setMemberVoiceMuted(serverId, member.id, true);
      setVoiceHint(
        t("timeout.sfuMute", { name: member.displayName }),
      );
    } catch (err) {
      // The 409 for a mesh room lands here too, with the server's own honest
      // sentence — a hint, not an error: nothing is broken, it is a limit.
      setVoiceHint(messageOf(err, t("member.muteFailed")));
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
      setBansError(messageOf(err, t("member.unbanFailed")));
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
        label: t("member.mention"),
        onSelect: () => onMention(username),
      });
    }
    if (
      serverId &&
      (member.id === currentUserId || canManage)
    ) {
      actions.push({
        id: "nickname",
        label: t("member.nickname"),
        onSelect: () => void changeNickname(member),
      });
    }
    if (role === "owner" && member.role !== "owner" && member.id !== currentUserId) {
      actions.push(
        member.role === "member"
          ? {
              id: "promote",
              label: t("member.promote"),
              onSelect: () => void setRole(member.id, "admin"),
            }
          : {
              id: "demote",
              label: t("member.demote"),
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
              label: t("member.unblock"),
              onSelect: () => onUnblockUser(member.id),
            }
          : {
              id: "block",
              label: t("member.block"),
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
        label: t("member.report"),
        onSelect: () => onReportUser(member),
        danger: true,
      });
    }
    if (canModerate(member)) {
      // Listed before kick and ban, and not marked `danger`, because the order
      // and the colour of this menu are the enforcement ladder as a moderator
      // experiences it. A timeout is the reversible one; putting it in the red
      // block next to "Ban from community" would teach the opposite.
      const active = timeoutByUser.get(member.id);
      actions.push(
        active
          ? {
              id: "untimeout",
              label: t("timeout.end", {
                remaining: timeRemaining(active.expiresAt),
              }),
              onSelect: () => void endTimeout(member.id),
            }
          : {
              id: "timeout",
              label: t("timeout.action"),
              onSelect: () =>
                setPendingTimeout({
                  member,
                  minutes: TIMEOUT_PRESET_MINUTES[1]!,
                  reason: "",
                }),
            },
      );
      // --- voice moderation ---
      // Only offered while the roster shows them in this server's voice: these
      // act on a live call, and a button that 404s ("not in voice") teaches a
      // moderator not to trust the panel. Ordered with timeout, above the red
      // block — disconnect ends a session, not a membership.
      const voice = voiceByUser.get(member.id);
      if (voice) {
        if (voiceChannels.length > 1) {
          actions.push({
            id: "voice-move",
            label: t("member.moveVoice"),
            onSelect: () =>
              setPendingMove({ member, fromChannelId: voice.channelId }),
          });
        }
        // SFU rooms get the real server-side mute; mesh rooms get the honest
        // refusal — tappable, so a tap explains instead of acting. An older
        // server that omits the transport is treated as SFU-capable and the
        // API stays the judge.
        const meshRoom = voice.transport === "mesh";
        actions.push({
          id: "voice-mute",
          label: t("member.serverMute"),
          onSelect: () => {
            if (meshRoom) {
              setVoiceHint(meshMuteUnavailable());
              return;
            }
            void serverMuteVoice(member);
          },
        });
        actions.push({
          id: "voice-disconnect",
          label: t("member.disconnectVoice", { channel: voice.channelName }),
          onSelect: () => void disconnectVoice(member),
          danger: true,
        });
      }
      actions.push(
        {
          id: "kick",
          label: t("member.remove"),
          onSelect: () => setPending({ member, ban: false }),
          danger: true,
        },
        {
          id: "ban",
          label: t("member.ban"),
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
        title={t("timeout.title", { name })}
        eyebrow={t("timeout.eyebrow")}
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
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void confirmTimeout()}
            >
              {busy
                ? t("common.working")
                : t("timeout.confirm", {
                    duration: describeMinutes(pendingTimeout.minutes),
                  })}
            </Button>
          </>
        }
      >
        <div className="space-y-4 px-5 py-5">
          {/* Says what a timeout is *not*, because that is the part a moderator
              reaching for the ban button does not know yet. */}
          <p className="text-sm text-paper">
            {t("timeout.body", {
              name,
              server: serverName ?? t("timeout.thisServer"),
            })}
          </p>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
              {t("timeout.howLong")}
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
              {t("timeout.why")}
            </label>
            <input
              id="timeout-reason"
              type="text"
              value={pendingTimeout.reason}
              maxLength={TIMEOUT_REASON_MAX_LENGTH}
              disabled={busy}
              placeholder={t("timeout.reasonPlaceholder")}
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

  // --- voice moderation ---
  if (pendingMove) {
    const name = pendingMove.member.displayName;
    const busy = busyId === pendingMove.member.id;
    const targets = voiceChannels.filter(
      (channel) => channel.id !== pendingMove.fromChannelId,
    );
    return (
      <Dialog
        open
        title={t("member.moveTitle", { name })}
        eyebrow={t("chrome.voice")}
        size="lg"
        closeOnBackdrop={false}
        onClose={() => setPendingMove(null)}
        footer={
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setPendingMove(null)}
          >
            {t("common.cancel")}
          </Button>
        }
      >
        <div className="space-y-4 px-5 py-5">
          {/* Honest about the mechanism: the server cannot teleport a client,
              it disconnects them with an invitation their app follows. */}
          <p className="text-sm text-paper">
            {t("member.moveBody", { name })}
          </p>
          <div className="flex flex-col gap-1">
            {targets.map((channel) => (
              <Button
                key={channel.id}
                variant="secondary"
                disabled={busy}
                className="justify-start"
                onClick={() => void confirmMove(channel.id)}
              >
                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                {channel.name}
              </Button>
            ))}
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
        title={
          pending.ban
            ? t("member.banTitle", { name })
            : t("member.removeTitle", { name })
        }
        eyebrow={t("timeout.eyebrow")}
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
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busyId === pending.member.id}
              onClick={() => void confirmRemoval()}
            >
              {busyId === pending.member.id
                ? t("common.working")
                : pending.ban
                  ? t("member.banAction")
                  : t("member.removeAction")}
            </Button>
          </>
        }
      >
        <div className="space-y-3 px-5 py-5">
          <p className="text-sm text-paper">
            {t(pending.ban ? "member.banBody" : "member.removeBody", {
              name,
              server: serverName ?? t("timeout.thisServer"),
            })}
          </p>
          {pending.ban && (
            <p className="text-sm text-paper-muted">
              {t("member.liftBanHint")}
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
      title={serverName ?? t("chrome.fallbackServer")}
      eyebrow={t("memberList.title")}
      size="lg"
      onClose={onClose}
    >
      {/* Directory: inset grouped list. The name opens the card; ⋯ is the
          same action set as a right-click, centred on the row. */}
      <div className="min-h-full bg-ink p-4">
        {error && (
          <p role="alert" className="mb-3 px-2 text-sm text-danger">
            {error}
          </p>
        )}

        {loading && (
          <p role="status" aria-live="polite" className="px-2 py-6 text-sm text-paper-muted">
            {t("memberList.loading")}
          </p>
        )}

        {!loading && members.length === 0 && !error && (
          <p className="px-2 py-6 text-sm text-paper-muted">
            {t("member.emptyInvite")}
          </p>
        )}

        {!loading && members.length > 0 && (
          <div className="relative mb-3">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
            />
            <input
              type="search"
              value={query}
              aria-label={t("memberList.search")}
              placeholder={t("memberList.search")}
              className="h-9 w-full rounded-xl bg-ink-2 pl-9 pr-3 text-sm text-paper placeholder:text-paper-muted focus:outline-none focus:ring-2 focus:ring-signal/60"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        {timeoutsError && (
          <p role="alert" className="mb-3 px-2 text-sm text-danger">
            {timeoutsError}
          </p>
        )}

        {/* Voice-tool explanations ("that needs the SFU"). `status`, not
            `alert`: a stated limit is information, not an emergency. */}
        {voiceHint && (
          <p role="status" className="mb-3 px-2 text-sm text-paper-muted">
            {voiceHint}
          </p>
        )}

        {!loading && members.length > 0 && visibleMembers.length === 0 && (
          <p className="px-2 py-6 text-sm text-paper-muted">
            {t("memberList.noMatches", { query: query.trim() })}
          </p>
        )}

        {visibleMembers.length > 0 && (
          <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
            {visibleMembers.map((member) => {
              const shown = memberDisplayName(member);
              const timeout = timeoutByUser.get(member.id);
              const timeoutLine = timeout
                ? t("timeout.until", {
                    expires: formatMoment(timeout.expiresAt),
                    remaining: timeRemaining(timeout.expiresAt),
                    issuer: timeout.issuedByName ?? t("timeout.formerMod"),
                    created: formatMoment(timeout.createdAt),
                  }) + (timeout.reason ? ` · ${timeout.reason}` : "")
                : null;
              return (
                <MemberRow
                  key={member.id}
                  member={member}
                  items={menuFromActions(
                    actionsFor(member),
                    busyId === member.id,
                  )}
                  timeoutLine={timeoutLine}
                  voice={voiceByUser.get(member.id)}
                  actionsLabel={t("memberList.actions", { name: shown })}
                  onOpen={(anchor) =>
                    openProfile(subjectOf(member), anchor)
                  }
                />
              );
            })}
          </div>
        )}

        {canManage && (
          <div className="mt-4">
            <button
              type="button"
              aria-expanded={bansOpen}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-paper-muted transition-colors hover:text-paper"
              onClick={() => setBansOpen((prev) => !prev)}
            >
              {bansOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {t("member.bans")}
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
                    {t("member.bansLoading")}
                  </p>
                )}
                {!bansLoading && bans.length === 0 && !bansError && (
                  <p className="px-2 py-4 text-sm text-paper-muted">
                    {t("member.bansEmpty")}
                  </p>
                )}
                {/* Banned people have no card to open from here, so these rows
                    are not buttons; Unban is a text button, the one action the
                    row still owns. */}
                {bans.length > 0 && (
                  <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
                    {bans.map((banned) => (
                      <div
                        key={banned.userId}
                        className="flex items-center gap-3 px-4 py-2.5"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-3 text-sm font-semibold text-paper">
                          {banned.displayName.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-paper">
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
                        <button
                          type="button"
                          disabled={busyId === banned.userId}
                          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-signal transition-colors hover:bg-signal/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 disabled:opacity-50"
                          onClick={() => void unban(banned.userId)}
                        >
                          {busyId === banned.userId
                            ? t("common.working")
                            : t("member.unban")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
