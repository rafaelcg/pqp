import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
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
import { publicProfileHref, type ProfileSubject } from "@/components/user/profile-relations";
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
 * The split is deliberate about moderation, too. The destructive actions all
 * need a confirmation dialog, a busy flag and a timeout/ban fetch to describe
 * themselves honestly; duplicating that here would be two copies of an
 * enforcement ladder, which is exactly the code you cannot afford to have drift.
 * So the row's context menu carries only what is already a plain callback the
 * shell owns — mention, block, report, open profile — plus a door into the panel
 * for everything else.
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
  /** Opens the full moderation panel — where kick, ban and timeout live. */
  onOpenMembersPanel?: () => void;
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

  function menuFor(member: ServerMember): ContextMenuItemDef[] {
    const items: ContextMenuItemDef[] = [];
    const publicHref = publicProfileHref(member.handle);
    if (publicHref) {
      items.push({
        id: "public-profile",
        label: t("profile.viewPublic"),
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
        onSelect: () => void changeNickname(member),
      });
    }
    if (member.id !== currentUserId) {
      items.push(
        blockedUserIds.has(member.id)
          ? {
              id: "unblock",
              label: t("profile.unblock"),
              onSelect: () => onUnblockUser(member.id),
            }
          : {
              id: "block",
              label: t("profile.block"),
              onSelect: () => onBlockUser(member.id),
              danger: true,
            },
      );
      if (onReportUser) {
        items.push({
          id: "report",
          label: t("profile.report"),
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
    </>
  );
}

// --------------------------------------------------------------------- a row

interface MemberRowProps {
  member: ServerMember;
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
 * THE SECOND LINE IS NOT A CUSTOM STATUS. Discord and Stoat put a person's own
 * status text there; this product has no such field anywhere — not on `users`,
 * not in `user_preferences`, not in `publicUserSchema` — so there is nothing to
 * render and inventing a placeholder would be worse than the blank. What *is*
 * true and live is where somebody is in voice, which is the same fact the
 * channel list already shows, so it takes the slot. When a custom status does
 * land, it belongs here, above the voice line.
 *
 * `data-member-sidebar-trigger` rather than `members-panel`'s
 * `data-member-trigger`: both can be on screen at once (the panel opens over
 * this), and one attribute matching two elements would make every existing
 * `[data-member-trigger=...]` locator ambiguous.
 */
function MemberRow({
  member,
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
