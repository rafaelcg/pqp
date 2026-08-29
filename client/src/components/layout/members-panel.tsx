import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { highestRoleColor, identityMarks, rankBadges } from "@/lib/author-display";
import { translateMessage, useTranslation } from "@/lib/i18n";
import {
  ApiError,
  assignMemberRole,
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
  unassignMemberRole,
  unbanMember,
  updateMemberNickname,
  type ServerBan,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import { assignableRoleIds, canActOnMemberClient } from "@/lib/role-hierarchy";
import { displayRoleName } from "@/lib/role-labels";
import {
  MEMBER_PAGE_SIZE,
  NO_COLLAPSE,
  effectiveRoleIds,
  groupMembers,
  sectionCollapsed,
  toggleSectionCollapse,
  type SectionCollapseState,
} from "@/lib/member-groups";
import type { ProfileModerationBits } from "@/components/user/profile-relations";
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
 * Clickable ⋯ for the same set right-click already opens. It does not own a
 * popup: it fires a synthetic `contextmenu` so the portaled Radix menu
 * (which flips above the last row) is the only renderer.
 */
function RowMenu({
  items,
  label,
  open,
}: {
  items: ContextMenuItemDef[];
  label: string;
  open: boolean;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className="relative mr-2 flex shrink-0 items-center"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Tooltip label={label}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 w-8 items-center justify-center rounded-full text-paper-muted hover:bg-ink-3 hover:text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: rect.right,
                clientY: rect.bottom,
              }),
            );
          }}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
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
  roles,
  dim,
  nameColor,
  onOpen,
  onMenuOpenChange,
}: {
  member: ServerMember;
  items: ContextMenuItemDef[];
  timeoutLine: string | null;
  voice: MemberVoicePresence | undefined;
  actionsLabel: string;
  roles: readonly ServerRole[];
  dim?: boolean;
  nameColor?: string | null;
  onOpen: (anchor: HTMLElement) => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const shown = memberDisplayName(member);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <ContextMenu
      items={items}
      onOpenChange={(next) => {
        setMenuOpen(next);
        onMenuOpenChange?.(next);
      }}
    >
      <div
        className={cn(
          "flex items-center hover:bg-ink-3",
          dim && "opacity-60 hover:opacity-100",
        )}
      >
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
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  !nameColor && "text-paper",
                )}
                style={nameColor ? { color: nameColor } : undefined}
              >
                {shown}
              </span>
              <RankMarks
                marks={identityMarks({
                  rank: member.role,
                  ...rankBadges(member.roleIds, roles),
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
        <RowMenu items={items} label={actionsLabel} open={menuOpen} />
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
  bits?: ProfileModerationBits;
  roles?: readonly ServerRole[];
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
  bits,
  roles = [],
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
  const [loading, setLoading] = useState(true);
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
  const [collapsed, setCollapsed] =
    useState<SectionCollapseState>(NO_COLLAPSE);
  const [shown, setShown] = useState<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);

  const canKick = bits ? bits.kick : role === "owner" || role === "admin";
  const canBan = bits ? bits.ban : role === "owner" || role === "admin";
  const canTimeout = bits ? bits.timeout : role === "owner" || role === "admin";
  const canMute = bits ? bits.mute : role === "owner" || role === "admin";
  const canNick = bits ? bits.nicknames : role === "owner" || role === "admin";
  const canRoles = bits ? bits.manageRoles : role === "owner" || role === "admin";
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
  const adminRoleId = useMemo(
    () => roles.find((role) => role.systemKey === "admin")?.id ?? null,
    [roles],
  );
  const ownerRoleId = useMemo(
    () => roles.find((role) => role.systemKey === "owner")?.id ?? null,
    [roles],
  );
  const hoistedRoles = useMemo(
    () =>
      [...roles]
        .filter((role) => role.hoist && !role.isEveryone)
        .sort((a, b) => b.position - a.position)
        .map((role) => ({
          id: role.systemKey === "owner" ? "owner" : role.id,
          name: displayRoleName(role, t, roles),
        })),
    [roles, t],
  );
  const rows = useMemo(
    () =>
      members.map((member) => {
        const ids = effectiveRoleIds(member, adminRoleId, ownerRoleId);
        if (member.role === "owner" && !ids.includes("owner")) {
          ids.push("owner");
        }
        return { ...member, roleIds: ids };
      }),
    [members, adminRoleId, ownerRoleId],
  );
  const sections = useMemo(
    () =>
      groupMembers(
        rows.filter((member) => memberMatchesQuery(member, query)),
        hoistedRoles,
      ),
    [rows, query, hoistedRoles],
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
    setCollapsed(NO_COLLAPSE);
    setShown({});
    setMenuOpen(false);
    setBansOpen(false);
    setBans([]);
    setBansError(null);
    setTimeouts([]);
    setTimeoutsError(null);
    setError(null);
    setMembers([]);
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
    if (canTimeout) {
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
  }, [open, serverId, canTimeout]);

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
    if (
      !open ||
      !serverId ||
      pending ||
      pendingTimeout ||
      pendingMove ||
      menuOpen
    ) {
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
  }, [open, serverId, pending, pendingTimeout, pendingMove, menuOpen]);

  const reloadTimeouts = useCallback(async () => {
    if (!serverId || !canTimeout) {
      return;
    }
    try {
      setTimeouts((await listTimeouts(serverId)).timeouts);
      setTimeoutsError(null);
    } catch (err) {
      setTimeoutsError(messageOf(err, t("timeout.loadFailed")));
    }
  }, [serverId, canTimeout]);

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
    if (!open || !canBan || !bansOpen) {
      return;
    }
    void loadBans();
  }, [open, canBan, bansOpen, loadBans]);

  if (!open) {
    return null;
  }

  // Kick/ban: the owner can act on members and admins; an admin can act only on
  // plain members. Never on the owner or yourself.
  function canActOn(member: ServerMember): boolean {
    if (member.role === "owner" || member.id === currentUserId) {
      return false;
    }
    const actor = members.find((row) => row.id === currentUserId);
    if (!actor) {
      return role === "owner" || (role === "admin" && member.role === "member");
    }
    return canActOnMemberClient(
      actor,
      member,
      roles.map((entry) => ({
        id: entry.id,
        position: entry.position,
        permissions: entry.permissions,
        systemKey: entry.systemKey,
      })),
      currentUserId,
      member.id,
    );
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

  async function toggleCargo(
    member: ServerMember,
    roleId: string,
    next: boolean,
  ) {
    if (!serverId) {
      return;
    }
    setBusyId(member.id);
    setError(null);
    try {
      if (next) {
        await assignMemberRole(serverId, member.id, roleId);
      } else {
        await unassignMemberRole(serverId, member.id, roleId);
      }
      const { members: nextMembers } = await fetchMembers(serverId);
      setMembers(nextMembers);
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
      (member.id === currentUserId || canNick)
    ) {
      actions.push({
        id: "nickname",
        label: t("member.nickname"),
        onSelect: () => void changeNickname(member),
      });
    }
    if (serverId && canRoles && canActOn(member)) {
      const actor = members.find((row) => row.id === currentUserId);
      if (actor) {
        const held = new Set(member.roleIds ?? []);
        const hierarchy = roles.map((entry) => ({
          id: entry.id,
          position: entry.position,
          permissions: entry.permissions,
          systemKey: entry.systemKey,
          isEveryone: entry.isEveryone,
        }));
        for (const roleId of assignableRoleIds(actor, hierarchy)) {
          const cargo = roles.find((entry) => entry.id === roleId);
          if (!cargo) {
            continue;
          }
          const on = held.has(roleId);
          const label = displayRoleName(cargo, t, roles);
          actions.push({
            id: `cargo-${roleId}`,
            label: on ? `✓ ${label}` : label,
            onSelect: () => void toggleCargo(member, roleId, !on),
          });
        }
      }
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
    if (canActOn(member)) {
      const active = timeoutByUser.get(member.id);
      if (canTimeout) {
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
      }
      const voice = voiceByUser.get(member.id);
      if (voice && (canTimeout || canMute)) {
        if (canTimeout && voiceChannels.length > 1) {
          actions.push({
            id: "voice-move",
            label: t("member.moveVoice"),
            onSelect: () =>
              setPendingMove({ member, fromChannelId: voice.channelId }),
          });
        }
        if (canMute) {
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
        }
        if (canTimeout) {
          actions.push({
            id: "voice-disconnect",
            label: t("member.disconnectVoice", { channel: voice.channelName }),
            onSelect: () => void disconnectVoice(member),
            danger: true,
          });
        }
      }
      if (canKick) {
        actions.push({
          id: "kick",
          label: t("member.remove"),
          onSelect: () => setPending({ member, ban: false }),
          danger: true,
        });
      }
      if (canBan) {
        actions.push({
          id: "ban",
          label: t("member.ban"),
          onSelect: () => setPending({ member, ban: true }),
          danger: true,
        });
      }
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
      <div className="min-h-full bg-ink px-4 pb-4">
        {!loading && members.length > 0 && (
          <div className="sticky top-0 z-10 -mx-4 bg-ink px-4 pb-3 pt-4">
            <div className="relative">
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
          </div>
        )}

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

        {timeoutsError && (
          <p role="alert" className="mb-3 px-2 text-sm text-danger">
            {timeoutsError}
          </p>
        )}

        {voiceHint && (
          <p role="status" className="mb-3 px-2 text-sm text-paper-muted">
            {voiceHint}
          </p>
        )}

        {!loading && members.length > 0 && sections.length === 0 && (
          <p className="px-2 py-6 text-sm text-paper-muted">
            {t("memberList.noMatches", { query: query.trim() })}
          </p>
        )}

        {sections.map((section) => {
          const label =
            section.kind === "role"
              ? (section.label ?? t("memberList.admins"))
              : section.kind === "offline"
                ? t("memberList.offline")
                : t("memberList.online");
          const heading = t("memberList.sectionHeading", {
            label,
            count: section.members.length,
          });
          const searching = query.trim().length > 0;
          const shut = searching
            ? false
            : sectionCollapsed(section, collapsed);
          const limit = shown[section.id] ?? MEMBER_PAGE_SIZE;
          const visible = shut ? [] : section.members.slice(0, limit);
          const remaining = shut ? 0 : section.members.length - visible.length;
          return (
            <section
              key={section.id}
              data-panel-member-section={section.id}
              className="mb-4"
            >
              <button
                type="button"
                aria-expanded={!shut}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-paper-muted hover:text-paper"
                onClick={() => {
                  if (searching) {
                    return;
                  }
                  setCollapsed((prev) => toggleSectionCollapse(section, prev));
                }}
              >
                {shut ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{heading}</span>
              </button>
              {visible.length > 0 && (
                <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
                  {visible.map((member) => {
                    const shownName = memberDisplayName(member);
                    const timeout = timeoutByUser.get(member.id);
                    const timeoutLine = timeout
                      ? t("timeout.until", {
                          expires: formatMoment(timeout.expiresAt),
                          remaining: timeRemaining(timeout.expiresAt),
                          issuer:
                            timeout.issuedByName ?? t("timeout.formerMod"),
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
                        actionsLabel={t("memberList.actions", {
                          name: shownName,
                        })}
                        roles={roles}
                        dim={section.kind === "offline"}
                        nameColor={highestRoleColor(member.roleIds, roles)}
                        onOpen={(anchor) =>
                          openProfile(subjectOf(member), anchor)
                        }
                        onMenuOpenChange={setMenuOpen}
                      />
                    );
                  })}
                </div>
              )}
              {remaining > 0 && (
                <button
                  type="button"
                  className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-signal hover:bg-ink-3"
                  onClick={() =>
                    setShown((prev) => ({
                      ...prev,
                      [section.id]: limit + MEMBER_PAGE_SIZE,
                    }))
                  }
                >
                  {t("memberList.showMore", { count: remaining })}
                </button>
              )}
            </section>
          );
        })}

        {canBan && (
          <div className="mt-4">
            <button
              type="button"
              aria-expanded={bansOpen}
              className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-paper-muted hover:text-paper"
              onClick={() => setBansOpen((prev) => !prev)}
            >
              {bansOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">
                {bansOpen && !bansLoading
                  ? t("memberList.sectionHeading", {
                      label: t("member.bans"),
                      count: bans.length,
                    })
                  : t("member.bans")}
              </span>
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
