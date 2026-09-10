import {
  AtSign,
  Ban,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flag,
  Gavel,
  Search,
  TimerOff,
  TimerReset,
  UserMinus,
  UserPen,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PublicUser, VoiceParticipant } from "@pqp/shared";
import { ContextMenu, type ContextMenuItemDef } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { RankMarks } from "@/components/user/rank-marks";
import { useProfilePopover } from "@/components/user/user-profile-popover";
import {
  MemberModerationDialog,
  type ModerationSubject,
} from "@/components/user/member-moderation-dialog";
import {
  moderationActions,
  moderationNeedsConfirmation,
  publicProfileHref,
  type ProfileModerationAction,
  type ProfileModerationContext,
  type ProfileSubject,
} from "@/components/user/profile-relations";
import {
  applyMemberModeration,
  moderationActionLabel,
} from "@/lib/member-moderation";
import { ApiError, memberDisplayName, memberMatchesQuery, updateMemberNickname, type ServerMember, type ServerRole } from "@/lib/api";
import { highestRoleColor, identityMarks, rankBadges } from "@/lib/author-display";
import { useTranslation } from "@/lib/i18n";
import { displayRoleName } from "@/lib/role-labels";
import {
  MEMBER_PAGE_SIZE,
  NO_COLLAPSE,
  groupMembers,
  isAround,
  sectionCollapsed,
  singleSection,
  toggleSectionCollapse,
  effectiveRoleIds,
  type MemberRole,
  type MemberSection,
  type SectionCollapseState,
} from "@/lib/member-groups";
import { cn } from "@/lib/utils";

const EMPTY_MEMBERS: readonly ServerMember[] = [];

/**
 * The member list, as a sidebar that is simply *there*.
 *
 * WHY THIS EXISTS SEPARATELY FROM `members-panel.tsx`. That panel is a modal
 * moderation console — it opens over the app, loads bans and timeouts, and hangs
 * five action buttons off every row. Reaching it takes a right-click on the
 * server header or a hunt for a small icon, which is why the owner's report was
 * "we have no user list": a roster you have to go and open is not a roster you
 * can see. This is the other half of the same feature, and the two are not the
 * same component for the same reason Discord's member list is not its
 * "Server Settings → Members" table: one answers "who is here", continuously,
 * and the other answers "what am I going to do about this person".
 *
 * THE LADDER IS ON THE ROW NOW. It used to be a door into the panel and
 * nothing else, on the argument that a second copy of the enforcement ladder is
 * the code you cannot afford to have drift. The argument was right and the
 * conclusion was wrong: it meant timing one person out cost a right-click, a
 * "Manage members…", a second list of the same people, finding them again and
 * another menu. What removes the drift is one implementation, not one caller.
 * `moderationActions` decides which rungs a row may show (the same function the
 * profile card asks), `applyMemberModeration` runs them, and
 * `MemberModerationDialog` asks how long and whether you are sure. The panel
 * stays for bulk work and for the ban list.
 *
 * PRESENCE IS PULLED, NOT PUSHED, and that is not this component's decision to
 * revisit: `server/src/ws/status.ts` argues it at length (a push has to reach
 * every member of every server the changing person shares). The poll and the
 * `presence-update` nudge live on the shared roster in `App.tsx` so the
 * transcript pip and this list read the same map. This file only draws it.
 */

interface MemberSidebarProps {
  open: boolean;
  /** Column beside the transcript (true) or drawer over it. */
  wide: boolean;
  onClose: () => void;
  /** Server roster mode. Null in a conversation. */
  serverId: string | null;
  /**
   * Conversation mode: the other participants, as the DM list already holds
   * them. Only a group is worth a sidebar — a 1:1's "member list" is one row
   * naming the person whose name is already in the header, which is why
   * `App.tsx` passes null for a direct conversation.
   */
  participants: readonly PublicUser[] | null;
  /**
   * The account itself, for the conversation case only. `DmSummary.participants`
   * excludes the viewer by design — the DM list draws its title and avatars from
   * that list, and including yourself would put your own face on every 1:1 — so
   * a participant list built straight from it would say "Participants — 2" about
   * a group of three. The server roster needs nothing here: it already contains
   * everybody, the reader included.
   */
  self: PublicUser | null;
  currentUserId: string | null;
  /** The acting account's role here, for the profile card's own gating. */
  role: MemberRole;
  blockedUserIds: ReadonlySet<string>;
  /**
   * The selected server's roster, owned by the shell. Same map the
   * transcript pips read. Ignored in a conversation (see `participants`).
   */
  members?: readonly ServerMember[];
  /** Writes a nickname back onto the shared roster after a successful edit. */
  onMemberNickname?: (userId: string, nickname: string | null) => void;
  onMention?: (username: string) => void;
  onReportUser?: (member: ServerMember) => void;
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  /** Opens the full moderation panel, for bulk work and the ban list. */
  onOpenMembersPanel?: () => void;
  /**
   * What the viewer may do to people in this server, exactly as the profile
   * card is handed it. Null in a conversation and for anybody holding none of
   * the staff bits, which is why this file never asks the question itself.
   */
  moderation?: ProfileModerationContext | null;
  /** channelId → participants, from the live `voice-roster` frames. */
  voiceOccupancy?: Record<string, VoiceParticipant[]>;
  /** This server's voice channels, for the "in voice" second line. */
  voiceChannels?: ReadonlyArray<{ id: string; name: string }>;
  /** Server roles, for hoist sections and name colour. */
  roles?: readonly ServerRole[];
  /**
   * Accepted-friend ids from the shell's friends snapshot. Incoming and
   * outgoing requests stay out: those people are not friends yet.
   */
  friendIds?: ReadonlySet<string>;
  canManageNicknames?: boolean;
  showManageRoster?: boolean;
}

/** A row, as the profile card wants it. */

const MODERATION_ICON: Record<ProfileModerationAction, LucideIcon> = {
  timeout: TimerOff,
  endTimeout: TimerReset,
  kick: UserMinus,
  ban: Gavel,
};

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
    isCharacter: member.isCharacter,
    handle: member.handle ?? null,
    customStatus: member.customStatus ?? null,
  };
}

/**
 * A conversation participant, in the shape the rest of this file speaks. Role is
 * `member` because a conversation has none — nobody moderates a group DM — and
 * status is absent because `publicUserSchema` does not carry one.
 */
function asRosterRow(person: PublicUser): ServerMember {
  return {
    id: person.id,
    displayName: person.displayName,
    username: person.username,
    tag: person.tag,
    role: "member",
    avatarUrl: person.avatarUrl,
    // A group conversation carries no roster read and no presence, but it does
    // carry the recado: it is on `publicUserSchema`, so the participant list
    // already has it and the row can draw the same second line it draws in a
    // server. Presence stays absent here on purpose (see the note on the pip).
    customStatus: person.customStatus ?? null,
  };
}

export function MemberSidebar({
  open,
  wide,
  onClose,
  serverId,
  participants,
  self,
  currentUserId,
  blockedUserIds,
  members = EMPTY_MEMBERS,
  onMemberNickname,
  onMention,
  onReportUser,
  onBlockUser,
  onUnblockUser,
  onOpenMembersPanel,
  moderation = null,
  voiceOccupancy = {},
  voiceChannels = [],
  roles = [],
  friendIds,
  canManageNicknames = false,
  showManageRoster = false,
}: MemberSidebarProps) {
  const { t } = useTranslation();
  const openProfile = useProfilePopover();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] =
    useState<SectionCollapseState>(NO_COLLAPSE);
  /** A rung picked from a row's menu, held until its dialog answers. */
  const [pendingModeration, setPendingModeration] = useState<{
    action: Exclude<ProfileModerationAction, "endTimeout">;
    subject: ModerationSubject;
  } | null>(null);
  /** section id → how many of its rows are mounted. */
  const [shown, setShown] = useState<Record<string, number>>({});
  const loading = !participants && members.length === 0;

  // Wipe pagination / collapse only when the server changes. Resetting on
  // every roster patch would slam the list shut each time a pip moved.
  useEffect(() => {
    setError(null);
    setQuery("");
    setShown({});
    setCollapsed(NO_COLLAPSE);
  }, [serverId]);

  // Escape closes the DRAWER only. In column mode it is not a transient thing
  // covering anything, so eating Escape there would take the key away from the
  // popover and the composer for no gain. A typed query is dismissed first so
  // the first Escape is "back to the roster", not "close the list".
  useEffect(() => {
    if (!open || wide) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (query.trim()) {
        setQuery("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, wide, onClose, query]);

  // ----------------------------------------------------------------- grouping

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
      participants
        ? [...participants, ...(self ? [self] : [])].map(asRosterRow)
        : members.map((member) => {
            const ids = effectiveRoleIds(member, adminRoleId, ownerRoleId);
            if (member.role === "owner" && !ids.includes("owner")) {
              ids.push("owner");
            }
            return { ...member, roleIds: ids };
          }),
    [participants, self, members, adminRoleId, ownerRoleId],
  );

  const conversationKey = serverId
    ?? (participants ? participants.map((person) => person.id).sort().join(",") : "");

  useEffect(() => {
    setQuery("");
  }, [conversationKey]);

  const searching = query.trim().length > 0;
  const visibleRows = useMemo(
    () => rows.filter((member) => memberMatchesQuery(member, query)),
    [rows, query],
  );

  const sections = useMemo(
    () =>
      participants
        ? singleSection(visibleRows)
        : groupMembers(visibleRows, hoistedRoles, friendIds),
    [participants, visibleRows, hoistedRoles, friendIds],
  );

  // userId → where they are in this server's voice, from the live rosters. Same
  // restriction the moderation panel applies: only this server's channels, so a
  // DM call this account can see never leaks into a server's roster.
  const voiceByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of voiceChannels) {
      for (const person of voiceOccupancy[channel.id] ?? []) {
        map.set(person.userId, channel.name);
      }
    }
    return map;
  }, [voiceChannels, voiceOccupancy]);

  if (!open) {
    return null;
  }
  if (!serverId && !participants) {
    return null;
  }

  // ---------------------------------------------------------------- rendering

  function headingFor(section: MemberSection<ServerMember>): string {
    let label: string;
    switch (section.kind) {
      case "role":
        label = section.label ?? t("memberList.admins");
        break;
      case "friends":
        label = t("memberList.friends");
        break;
      case "offline":
        label = t("memberList.offline");
        break;
      case "all":
        label = t("memberList.participants");
        break;
      case "online":
        label = t("memberList.online");
        break;
    }
    return t("memberList.sectionHeading", {
      label,
      count: section.members.length,
    });
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
    try {
      const nickname = trimmed.length === 0 ? null : trimmed;
      await updateMemberNickname(serverId, member.id, nickname);
      onMemberNickname?.(member.id, nickname);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : t("member.nicknameFailed"),
      );
    }
  }

  /**
   * The one rung that needs no dialog. Errors land in the same line the
   * nickname failure uses: a moderator has to be told the API said no, and the
   * row itself has nowhere to put a sentence.
   */
  async function runModeration(
    action: ProfileModerationAction,
    member: ServerMember,
  ) {
    if (!moderation) {
      return;
    }
    setError(null);
    try {
      await applyMemberModeration({
        action,
        serverId: moderation.serverId,
        userId: member.id,
      });
      moderation.onModerated();
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("member.moderationFailed"),
      );
    }
  }

  function menuFor(member: ServerMember): ContextMenuItemDef[] {
    const items: ContextMenuItemDef[] = [];
    const publicHref = publicProfileHref(member.handle);
    if (publicHref) {
      items.push({
        id: "public-profile",
        label: t("profile.viewPublic"),
        icon: ExternalLink,
        onSelect: () => {
          window.open(publicHref, "_blank", "noopener,noreferrer");
        },
      });
    }
    if (onMention && member.username) {
      const username = member.username;
      items.push({
        id: "mention",
        label: t("memberList.mention"),
        icon: AtSign,
        onSelect: () => onMention(username),
      });
    }
    if (
      serverId &&
      !participants &&
      (member.id === currentUserId || canManageNicknames)
    ) {
      items.push({
        id: "nickname",
        label: t("member.nickname"),
        icon: UserPen,
        onSelect: () => void changeNickname(member),
      });
    }
    // The ladder, on the row. Only ever the rungs `moderationActions` allows,
    // which is the same judgement the card makes and mirrors the server's
    // `requireOutranked`. A plain member reads this list and finds nothing of
    // it, and a moderator never sees a rung the API would refuse.
    const rungs = participants
      ? []
      : moderationActions(member.id, currentUserId, moderation);
    if (rungs.length > 0) {
      items.push({ id: "sep-mod", label: "", separator: true });
      for (const rung of rungs) {
        items.push({
          id: `mod-${rung}`,
          label: moderationActionLabel(rung, t),
          icon: MODERATION_ICON[rung],
          danger: moderationNeedsConfirmation(rung),
          onSelect: () => {
            if (rung === "endTimeout") {
              // Lifting a sentence takes nothing away, so it is the one rung
              // with nothing to ask: no duration, no confirmation.
              void runModeration(rung, member);
              return;
            }
            setPendingModeration({
              action: rung,
              subject: {
                id: member.id,
                displayName: memberDisplayName(member),
              },
            });
          },
        });
      }
      items.push({ id: "sep-after-mod", label: "", separator: true });
    }
    if (member.id !== currentUserId) {
      items.push(
        blockedUserIds.has(member.id)
          ? {
              id: "unblock",
              label: t("profile.unblock"),
              icon: Ban,
              onSelect: () => onUnblockUser(member.id),
            }
          : {
              id: "block",
              label: t("profile.block"),
              icon: Ban,
              onSelect: () => onBlockUser(member.id),
              danger: true,
            },
      );
      if (onReportUser) {
        items.push({
          id: "report",
          label: t("profile.report"),
          icon: Flag,
          onSelect: () => onReportUser(member),
          danger: true,
        });
      }
    }
    // The door to the enforcement ladder rather than a second copy of it — see
    // the note at the top of this file.
    if (onOpenMembersPanel && showManageRoster) {
      items.push({ id: "sep", label: "", separator: true });
      items.push({
        id: "manage",
        label: t("memberList.manage"),
        icon: Users,
        onSelect: onOpenMembersPanel,
      });
    }
    return items;
  }

  function renderSection(section: MemberSection<ServerMember>): ReactNode {
    const shut = searching ? false : sectionCollapsed(section, collapsed);
    const limit = shown[section.id] ?? MEMBER_PAGE_SIZE;
    const visible = shut ? [] : section.members.slice(0, limit);
    const remaining = shut ? 0 : section.members.length - visible.length;

    return (
      <section key={section.id} data-member-section={section.id} className="mb-4">
        {searching ? (
          <div className="flex w-full items-center gap-1 px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
            <span className="truncate">{headingFor(section)}</span>
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={!shut}
            className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-paper-muted hover:text-paper"
            onClick={() =>
              setCollapsed((prev) => toggleSectionCollapse(section, prev))
            }
          >
            {shut ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{headingFor(section)}</span>
          </button>
        )}
        {visible.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            blocked={blockedUserIds.has(member.id)}
            dim={!isAround(member.status)}
            voiceChannelName={voiceByUser.get(member.id) ?? null}
            items={menuFor(member)}
            nameColor={highestRoleColor(member.roleIds, roles)}
            roles={roles}
            onOpenProfile={(anchor) => openProfile(subjectOf(member), anchor)}
          />
        ))}
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
  }

  const total = rows.length;

  return (
    <>
      {/* Drawer mode only: a tap outside closes it, the way the mobile channel
          list already behaves. In column mode there is no outside. */}
      {!wide && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-ink/70"
          aria-label={t("memberList.close")}
          onClick={onClose}
        />
      )}
      <aside
        data-member-sidebar=""
        data-immersive-hide=""
        aria-label={t("memberList.title")}
        className={cn(
          "flex shrink-0 flex-col border-l border-ink-4/60 bg-channel",
          wide
            ? "w-60"
            : "fixed inset-y-0 right-0 z-30 w-[min(100%,15rem)] shadow-[var(--shadow-popover)]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-ink-4/60 px-3">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
            {t("memberList.sectionHeading", {
              label: t("memberList.title"),
              count: total,
            })}
          </p>
          {/* `side="left"`: this sits in the top-right corner of the window,
              where a bubble above or beside it would run off the edge. */}
          <Tooltip label={t("memberList.close")} side="left">
            <button
              type="button"
              className="shrink-0 rounded-md p-1.5 text-paper-muted hover:bg-ink-3 hover:text-paper"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        {rows.length > 0 && (
          <div role="search" className="shrink-0 px-2 pb-1 pt-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
                aria-label={t("memberList.search")}
                placeholder={t("memberList.search")}
                className={cn(
                  "h-9 w-full appearance-none rounded-xl bg-ink-2 pl-9 text-sm text-paper placeholder:text-paper-muted",
                  "focus:outline-none focus:ring-2 focus:ring-signal/60",
                  "[&::-webkit-search-cancel-button]:hidden",
                  searching ? "pr-9" : "pr-3",
                )}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {searching && (
                <button
                  type="button"
                  aria-label={t("memberList.searchClear")}
                  className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3">
          {error && (
            <p role="alert" className="px-1 pb-2 text-xs text-danger">
              {error}
            </p>
          )}
          {loading && sections.length === 0 && !error && (
            <p
              role="status"
              aria-live="polite"
              className="px-1 py-2 text-xs text-paper-muted"
            >
              {t("memberList.loading")}
            </p>
          )}
          {!loading && sections.length === 0 && !error && (
            <p className="px-1 py-2 text-xs text-paper-muted">
              {searching
                ? t("memberList.noMatches", { query: query.trim() })
                : t("memberList.empty")}
            </p>
          )}
          {sections.map(renderSection)}
        </div>
      </aside>
      {moderation && (
        <MemberModerationDialog
          action={pendingModeration?.action ?? null}
          subject={pendingModeration?.subject ?? null}
          serverId={moderation.serverId}
          onDone={() => {
            moderation.onModerated();
            // A kick or a ban takes the row this menu was opened on off the
            // list. `onRolesChanged` is the shell's roster re-read, and the
            // roster is the thing the reader is looking at right now.
            moderation.onRolesChanged?.();
          }}
          onClose={() => setPendingModeration(null)}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------- a row

interface MemberRowProps {
  member: ServerMember;
  /**
   * The viewer has blocked this person. Only the recado cares: a block is the
   * reader saying they do not want this account's writing, and a status line is
   * the one thing on this row that this account wrote. The name and the picture
   * stay, because the row still has to be identifiable enough to unblock.
   */
  blocked: boolean;
  /** Offline rows are drawn back, the way every member list does it. */
  dim: boolean;
  voiceChannelName: string | null;
  items: ContextMenuItemDef[];
  nameColor: string | null;
  roles: readonly ServerRole[];
  onOpenProfile: (anchor: HTMLElement) => void;
}

/**
 * One person: picture, pip, name, and a second line when there is something true
 * to put on it.
 *
 * THE SECOND LINE IS THE RECADO, and the third is voice.
 *
 * That order was decided when there was no recado to draw and the voice line
 * had the slot to itself: a person's own line about themselves outranks a fact
 * the channel list is already showing two inches to the left. Both can be true
 * at once, so both are drawn when both are, and each is capped at one line.
 *
 * NEITHER LINE WRAPS. A member list whose rows are different heights stops
 * being scannable, and a recado is the one field here whose length somebody
 * else chooses. Eighty characters is roughly twice what fits at this width, so
 * `truncate` is the normal case rather than the edge case, and the `title`
 * carries the rest for anybody who wants it. The tooltip is on the text and not
 * on the row: the row's own title says "open profile", and two nested titles
 * would make which one appears a matter of where the pointer stopped.
 *
 * `data-member-sidebar-trigger` rather than `members-panel`'s
 * `data-member-trigger`: both can be on screen at once (the panel opens over
 * this), and one attribute matching two elements would make every existing
 * `[data-member-trigger=...]` locator ambiguous.
 */
function MemberRow({
  member,
  blocked,
  dim,
  voiceChannelName,
  items,
  nameColor,
  roles,
  onOpenProfile,
}: MemberRowProps) {
  const { t } = useTranslation();
  const status = member.status ?? null;
  const shown = memberDisplayName(member);
  // Absent and empty are the same thing here. The API stores NULL for a recado
  // that normalises to nothing, but a client must not depend on that being the
  // only shape it will ever see: an empty string would draw a blank line that
  // makes one row taller than its neighbours for no visible reason.
  const recado = blocked ? null : member.customStatus?.trim() || null;

  return (
    <ContextMenu items={items}>
      <div
        className={cn(
          "group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-ink-3",
          dim && "opacity-60 hover:opacity-100",
        )}
      >
        <button
          type="button"
          data-member-sidebar-trigger={member.id}
          title={t("profile.open", { name: shown })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          onClick={(event) => onOpenProfile(event.currentTarget)}
        >
          <span className="relative shrink-0">
            <UserAvatar
              name={shown}
              avatarUrl={member.avatarUrl}
              className="h-8 w-8"
              rounded="full"
              fallbackClassName="bg-ink-3 text-xs"
            />
            {/* Null means the payload carried no status at all — a group
                conversation's participants. Nothing is drawn rather than a
                confident "offline" for everybody. */}
            {status && (
              <StatusDot
                status={status}
                className="absolute -bottom-0.5 -right-0.5"
                ringClassName="rounded-full bg-channel ring-2 ring-channel"
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            {/* `text-paper` explicitly: role colours are the next thing to land
                here, and a name that inherits its colour has nowhere to put
                one. */}
            <span className="flex min-w-0 items-center gap-1">
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
                  isCharacter: member.isCharacter,
                  ...rankBadges(member.roleIds, roles),
                })}
              />
            </span>
            {recado && (
              <span
                className="block truncate text-[11px] text-paper-muted"
                title={recado}
                data-member-custom-status={member.id}
              >
                {recado}
              </span>
            )}
            {voiceChannelName && (
              <span className="block truncate text-[11px] text-signal">
                {t("memberList.inVoice", { channel: voiceChannelName })}
              </span>
            )}
          </span>
        </button>
      </div>
    </ContextMenu>
  );
}
