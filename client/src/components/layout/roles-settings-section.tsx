import {
  Permission,
  clampEveryonePermissions,
  defaultRoleColor,
  defaultRoleName,
  defaultRolePermissions,
  hasPermission,
  isRoleOrderLocked,
  parsePermissions,
  serializePermissions,
  type PermissionFlagKey,
} from "@pqp/shared";
import { Plus } from "lucide-react";
import { RoleColorField } from "@/components/layout/role-color-field";
import { RoleRankList } from "@/components/layout/role-rank-list";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user/user-avatar";
import { cn } from "@/lib/utils";
import {
  ApiError,
  assignMemberRole,
  createRole,
  deleteRole,
  fetchMembers,
  fetchRoles,
  memberDisplayName,
  memberMatchesQuery,
  reorderRoles,
  unassignMemberRole,
  updateRole,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import { displayRoleName } from "@/lib/role-labels";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const FLAG_LABEL: Record<PermissionFlagKey, MessageKey> = {
  CREATE_INVITE: "roles.perm.CREATE_INVITE",
  KICK_MEMBERS: "roles.perm.KICK_MEMBERS",
  BAN_MEMBERS: "roles.perm.BAN_MEMBERS",
  ADMINISTRATOR: "roles.perm.ADMINISTRATOR",
  MANAGE_CHANNELS: "roles.perm.MANAGE_CHANNELS",
  MANAGE_SERVER: "roles.perm.MANAGE_SERVER",
  VIEW_CHANNEL: "roles.perm.VIEW_CHANNEL",
  SEND_MESSAGES: "roles.perm.SEND_MESSAGES",
  MANAGE_MESSAGES: "roles.perm.MANAGE_MESSAGES",
  ATTACH_FILES: "roles.perm.ATTACH_FILES",
  READ_MESSAGE_HISTORY: "roles.perm.READ_MESSAGE_HISTORY",
  MENTION_EVERYONE: "roles.perm.MENTION_EVERYONE",
  CONNECT: "roles.perm.CONNECT",
  SPEAK: "roles.perm.SPEAK",
  MUTE_MEMBERS: "roles.perm.MUTE_MEMBERS",
  CHANGE_NICKNAME: "roles.perm.CHANGE_NICKNAME",
  MANAGE_NICKNAMES: "roles.perm.MANAGE_NICKNAMES",
  MANAGE_ROLES: "roles.perm.MANAGE_ROLES",
  MODERATE_MEMBERS: "roles.perm.MODERATE_MEMBERS",
  ADD_REACTIONS: "roles.perm.ADD_REACTIONS",
};

/** One-liners for flags whose names collide or oversell. Labels stay for the rest. */
const FLAG_HINT: Partial<Record<PermissionFlagKey, MessageKey>> = {
  ADMINISTRATOR: "roles.permHint.ADMINISTRATOR",
  CREATE_INVITE: "roles.permHint.CREATE_INVITE",
  MANAGE_CHANNELS: "roles.permHint.MANAGE_CHANNELS",
  MANAGE_SERVER: "roles.permHint.MANAGE_SERVER",
  VIEW_CHANNEL: "roles.permHint.VIEW_CHANNEL",
  MANAGE_MESSAGES: "roles.permHint.MANAGE_MESSAGES",
  READ_MESSAGE_HISTORY: "roles.permHint.READ_MESSAGE_HISTORY",
  MENTION_EVERYONE: "roles.permHint.MENTION_EVERYONE",
  MUTE_MEMBERS: "roles.permHint.MUTE_MEMBERS",
  CHANGE_NICKNAME: "roles.permHint.CHANGE_NICKNAME",
  MANAGE_NICKNAMES: "roles.permHint.MANAGE_NICKNAMES",
  MANAGE_ROLES: "roles.permHint.MANAGE_ROLES",
  MODERATE_MEMBERS: "roles.permHint.MODERATE_MEMBERS",
};

/** Display order. Bit numbers stay as defined in `@pqp/shared`. */
const PERMISSION_GROUPS = [
  {
    heading: "roles.group.general",
    keys: [
      "VIEW_CHANNEL",
      "CREATE_INVITE",
      "MANAGE_CHANNELS",
      "MANAGE_SERVER",
      "MANAGE_ROLES",
      "CHANGE_NICKNAME",
    ],
  },
  {
    heading: "roles.group.moderation",
    keys: [
      "KICK_MEMBERS",
      "BAN_MEMBERS",
      "MODERATE_MEMBERS",
      "MANAGE_MESSAGES",
      "MUTE_MEMBERS",
      "MANAGE_NICKNAMES",
    ],
  },
  {
    heading: "roles.group.text",
    keys: [
      "SEND_MESSAGES",
      "ATTACH_FILES",
      "READ_MESSAGE_HISTORY",
      "ADD_REACTIONS",
      "MENTION_EVERYONE",
    ],
  },
  {
    heading: "roles.group.voice",
    keys: ["CONNECT", "SPEAK"],
  },
] as const satisfies readonly {
  heading: MessageKey;
  keys: readonly Exclude<PermissionFlagKey, "ADMINISTRATOR">[];
}[];

type GroupedFlag = (typeof PERMISSION_GROUPS)[number]["keys"][number];
type MissingFromGroups = Exclude<
  PermissionFlagKey,
  "ADMINISTRATOR" | GroupedFlag
>;
type GroupsCoverEveryFlag = [MissingFromGroups] extends [never] ? true : never;
const _groupsCoverEveryFlag: GroupsCoverEveryFlag = true;
void _groupsCoverEveryFlag;

/**
 * Bits that exist on the wire and in the default masks, but are not yet
 * checked on a server path. Showing a toggle would let an operator turn them
 * off and believe a restriction exists. Hide until each one is enforced.
 */
const UNENFORCED_FLAGS = new Set<PermissionFlagKey>([
  "ATTACH_FILES",
  "READ_MESSAGE_HISTORY",
  "SPEAK",
]);

const EVERYONE_LOCKED_KEYS = new Set<PermissionFlagKey>([
  "ADMINISTRATOR",
  "KICK_MEMBERS",
  "BAN_MEMBERS",
  "MODERATE_MEMBERS",
]);

function rolePermissions(role: ServerRole): bigint {
  const parsed = parsePermissions(role.permissions);
  return role.isEveryone ? clampEveryonePermissions(parsed) : parsed;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

type RoleEditorTab = "display" | "permissions" | "members";

function tabsFor(role: ServerRole | null): RoleEditorTab[] {
  if (!role) {
    return [];
  }
  if (role.systemKey === "owner") {
    return ["display"];
  }
  if (role.isEveryone || role.systemKey === "everyone") {
    return ["display", "permissions"];
  }
  return ["display", "permissions", "members"];
}

function rankRoles(roles: ServerRole[]): ServerRole[] {
  return [...roles].sort((a, b) => {
    if (a.systemKey === "owner") {
      return -1;
    }
    if (b.systemKey === "owner") {
      return 1;
    }
    if (a.isEveryone) {
      return 1;
    }
    if (b.isEveryone) {
      return -1;
    }
    return b.position - a.position;
  });
}

function ownerNeedsPin(roles: ServerRole[]): boolean {
  const owner = roles.find((role) => role.systemKey === "owner");
  if (!owner) {
    return false;
  }
  return roles.some(
    (role) => role.systemKey !== "owner" && role.position >= owner.position,
  );
}

export function RolesSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<ServerRole[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [mentionable, setMentionable] = useState(false);
  const [hoist, setHoist] = useState(false);
  const [showBadge, setShowBadge] = useState(true);
  const [color, setColor] = useState<string | null>(null);
  const [permissions, setPermissions] = useState(0n);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<RoleEditorTab>("display");

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const availableTabs = tabsFor(selected);
  const activeTab = availableTabs.includes(tab) ? tab : (availableTabs[0] ?? "display");
  const rankedRoles = rankRoles(roles);

  const isAdministrator =
    !selected?.isEveryone &&
    hasPermission(permissions, Permission.ADMINISTRATOR);

  function toggleBit(bit: bigint) {
    if (isAdministrator && bit !== Permission.ADMINISTRATOR) {
      return;
    }
    if (
      selected?.isEveryone &&
      (bit === Permission.ADMINISTRATOR ||
        bit === Permission.KICK_MEMBERS ||
        bit === Permission.BAN_MEMBERS ||
        bit === Permission.MODERATE_MEMBERS)
    ) {
      return;
    }
    setPermissions((current) =>
      hasPermission(current, bit) ? current & ~bit : current | bit,
    );
  }

  async function reload(preferId?: string, repaired = false) {
    const { roles: list } = await fetchRoles(serverId);
    if (!repaired && ownerNeedsPin(list)) {
      const movable = rankRoles(list)
        .filter((role) => !isRoleOrderLocked(role))
        .map((role) => role.id);
      try {
        await reorderRoles(serverId, [...movable].reverse());
        await reload(preferId, true);
        return;
      } catch {
        // Visual sort still pins Dono; the next successful reorder writes it.
      }
    }
    setRoles(list);
    const next =
      list.find((role) => role.id === preferId) ??
      list.find((role) => role.isEveryone) ??
      list[0] ??
      null;
    setSelectedId(next?.id ?? null);
    if (next) {
      setName(next.isEveryone ? "@everyone" : next.name);
      setMentionable(next.mentionable);
      setHoist(next.hoist);
      setShowBadge(next.showBadge);
      setColor(next.color);
      setPermissions(rolePermissions(next));
    }
  }

  useEffect(() => {
    void reload().catch((err) => {
      setError(messageOf(err, t("roles.loadFailed")));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per server
  }, [serverId]);

  function selectRole(role: ServerRole) {
    setSelectedId(role.id);
    setName(role.isEveryone ? "@everyone" : role.name);
    setMentionable(role.mentionable);
    setHoist(role.hoist);
    setShowBadge(role.showBadge);
    setColor(role.color);
    setPermissions(rolePermissions(role));
    setTab("display");
    setError(null);
  }

  async function save() {
    if (!selected) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateRole(selected.id, {
        name: selected.isEveryone ? undefined : name.trim(),
        mentionable,
        hoist: selected.isEveryone ? undefined : hoist,
        showBadge:
          selected.systemKey === "owner" ? showBadge : undefined,
        color: selected.isEveryone ? undefined : color,
        permissions:
          selected.systemKey === "owner"
            ? undefined
            : serializePermissions(
                selected.isEveryone
                  ? clampEveryonePermissions(permissions)
                  : permissions,
              ),
      });
      await reload(selected.id);
    } catch (err) {
      setError(messageOf(err, t("roles.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function addRole() {
    const trimmed = newName.trim();
    if (trimmed.length < 2) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { role } = await createRole(serverId, { name: trimmed });
      setNewName("");
      await reload(role.id);
    } catch (err) {
      setError(messageOf(err, t("roles.createFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function removeRole() {
    if (!selected || selected.isEveryone || selected.systemKey) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteRole(selected.id);
      await reload();
    } catch (err) {
      setError(messageOf(err, t("roles.deleteFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function applyOrder(next: string[]) {
    setSaving(true);
    setError(null);
    try {
      await reorderRoles(serverId, [...next].reverse());
      await reload(selectedId ?? next[0]);
    } catch (err) {
      setError(messageOf(err, t("roles.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const staffHint =
    selected?.isEveryone
      ? t("roles.everyoneHint")
      : selected?.systemKey === "owner"
        ? t("roles.ownerHint")
        : selected?.systemKey === "admin"
          ? t("roles.adminHint")
          : selected?.systemKey === "manager"
            ? t("roles.managerHint")
            : selected?.systemKey === "moderator"
              ? t("roles.moderatorHint")
              : null;

  const seedName = selected ? defaultRoleName(selected.systemKey) : null;
  const canResetName = Boolean(
    selected &&
      !selected.isEveryone &&
      seedName &&
      name !== seedName,
  );
  const seedPermissions = selected
    ? defaultRolePermissions(selected.systemKey)
    : 0n;
  const canResetPermissions = Boolean(
    selected &&
      selected.systemKey !== "owner" &&
      permissions !== seedPermissions,
  );

  return (
    <div className="-mt-1 flex min-h-0 flex-col gap-6 sm:flex-row sm:gap-8">
      <div className="w-full shrink-0 sm:w-64">
        <p className="mb-2 px-1 text-xs leading-relaxed text-paper-muted">
          {t("roles.hierarchyHint")}
        </p>
        <div className="overflow-hidden rounded-2xl bg-ink-2">
          <RoleRankList
            roles={rankedRoles}
            selectedId={selectedId}
            disabled={saving}
            labelFor={(role) => displayRoleName(role, t, roles)}
            onSelect={selectRole}
            onReorder={(next) => void applyOrder(next)}
          />
          <form
            className="flex items-center gap-2 border-t border-ink-4/60 px-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addRole();
            }}
          >
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("roles.newPlaceholder")}
              maxLength={32}
              aria-label={t("roles.newPlaceholder")}
              className="h-9 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={saving || newName.trim().length < 2}
              className="shrink-0"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("roles.add")}
            </Button>
          </form>
        </div>
      </div>

      {selected && (
        <div className="min-w-0 flex-1 space-y-4">
          {availableTabs.length > 1 && (
            <div
              role="tablist"
              aria-label={t("roles.name")}
              className="flex gap-1 rounded-xl bg-ink-3/60 p-1"
            >
              {availableTabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === id}
                  className={cn(
                    "min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm",
                    activeTab === id
                      ? "bg-ink-2 font-medium text-paper shadow-sm"
                      : "text-paper-muted hover:text-paper",
                  )}
                  onClick={() => setTab(id)}
                >
                  {t(
                    id === "display"
                      ? "roles.tab.display"
                      : id === "permissions"
                        ? "roles.tab.permissions"
                        : "roles.tab.members",
                  )}
                </button>
              ))}
            </div>
          )}

          {activeTab === "display" && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-ink-2 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <label
                    htmlFor="role-name"
                    className="text-[11px] font-semibold uppercase tracking-wider text-paper-muted"
                  >
                    {t("roles.name")}
                  </label>
                  {seedName && !selected.isEveryone && (
                    <button
                      type="button"
                      disabled={!canResetName}
                      className="text-sm text-signal hover:underline disabled:cursor-default disabled:text-paper-muted disabled:no-underline disabled:opacity-60"
                      onClick={() => setName(seedName)}
                    >
                      {t("roles.nameReset")}
                    </button>
                  )}
                </div>
                <Input
                  id="role-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={selected.isEveryone}
                  maxLength={32}
                  aria-label={t("roles.name")}
                  className="mt-1.5 border-0 bg-ink px-3"
                />
                {staffHint && (
                  <p className="mt-2 px-1 text-xs leading-relaxed text-paper-muted">
                    {staffHint}
                  </p>
                )}
              </div>

              <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
                <Switch
                  checked={mentionable}
                  onCheckedChange={setMentionable}
                  label={t("roles.mentionable")}
                  className="rounded-none px-3 py-3"
                />
                {!selected.isEveryone && (
                  <>
                    <Switch
                      checked={hoist}
                      onCheckedChange={setHoist}
                      label={t("roles.hoist")}
                      description={t("roles.hoistHint")}
                      className="rounded-none px-3 py-3"
                    />
                    {selected.systemKey === "owner" && (
                      <Switch
                        checked={showBadge}
                        onCheckedChange={setShowBadge}
                        label={t("roles.showBadge")}
                        className="rounded-none px-3 py-3"
                      />
                    )}
                    <RoleColorField
                      color={color}
                      defaultColor={defaultRoleColor(selected.systemKey)}
                      onChange={setColor}
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === "permissions" && (
            <fieldset className="space-y-4">
              <legend className="sr-only">{t("roles.permissions")}</legend>
              {selected.systemKey !== "owner" && (
                <div className="flex justify-end px-1">
                  <button
                    type="button"
                    disabled={!canResetPermissions}
                    className="text-sm text-signal hover:underline disabled:cursor-default disabled:text-paper-muted disabled:no-underline disabled:opacity-50"
                    onClick={() => setPermissions(seedPermissions)}
                  >
                    {t("roles.permissionsReset")}
                  </button>
                </div>
              )}
              <div className="overflow-hidden rounded-2xl bg-ink-2">
                <Switch
                  checked={isAdministrator}
                  disabled={selected.isEveryone}
                  onCheckedChange={() => toggleBit(Permission.ADMINISTRATOR)}
                  label={t(FLAG_LABEL.ADMINISTRATOR)}
                  title={
                    selected.isEveryone
                      ? t("roles.everyoneLockedHint")
                      : undefined
                  }
                  description={t("roles.permHint.ADMINISTRATOR")}
                  className="rounded-none px-3 py-3"
                />
              </div>
              {PERMISSION_GROUPS.map((group) => {
                const keys = group.keys.filter((key) => !UNENFORCED_FLAGS.has(key));
                if (keys.length === 0) {
                  return null;
                }
                return (
                  <div key={group.heading}>
                    <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
                      {t(group.heading)}
                    </p>
                    <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
                      {keys.map((key) => {
                        const lockedOnEveryone =
                          selected.isEveryone && EVERYONE_LOCKED_KEYS.has(key);
                        const hint = FLAG_HINT[key];
                        return (
                          <Switch
                            key={key}
                            checked={
                              !lockedOnEveryone &&
                              (isAdministrator ||
                                hasPermission(permissions, Permission[key]))
                            }
                            disabled={isAdministrator || lockedOnEveryone}
                            onCheckedChange={() => toggleBit(Permission[key])}
                            label={t(FLAG_LABEL[key])}
                            title={
                              lockedOnEveryone
                                ? t("roles.everyoneLockedHint")
                                : undefined
                            }
                            description={hint ? t(hint) : undefined}
                            className="rounded-none px-3 py-3"
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </fieldset>
          )}

          {activeTab === "members" && (
            <RoleMembersTab
              serverId={serverId}
              roleId={selected.id}
              busy={saving}
              onBusy={setSaving}
              onError={setError}
            />
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {activeTab !== "members" && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={saving} onClick={() => void save()}>
                {saving ? t("roles.saving") : t("roles.save")}
              </Button>
              {!selected.isEveryone && !selected.systemKey && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => void removeRole()}
                >
                  {t("roles.delete")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoleMembersTab({
  serverId,
  roleId,
  busy,
  onBusy,
  onError,
}: {
  serverId: string;
  roleId: string;
  busy: boolean;
  onBusy: (next: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  async function reload() {
    const { members: list } = await fetchMembers(serverId);
    setMembers(list);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setQuery("");
    void fetchMembers(serverId)
      .then(({ members: list }) => {
        if (!cancelled) {
          setMembers(list);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onError(messageOf(err, t("roles.loadFailed")));
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
  }, [serverId, roleId, onError, t]);

  const holding = members.filter((member) =>
    (member.roleIds ?? []).includes(roleId),
  );
  const trimmed = query.trim();
  const visibleHolding = holding.filter((member) =>
    memberMatchesQuery(member, trimmed),
  );
  const addable = trimmed
    ? members.filter(
        (member) =>
          !(member.roleIds ?? []).includes(roleId) &&
          memberMatchesQuery(member, trimmed),
      )
    : [];

  async function add(member: ServerMember) {
    onBusy(true);
    onError(null);
    try {
      await assignMemberRole(serverId, member.id, roleId);
      await reload();
    } catch (err) {
      onError(messageOf(err, t("roles.members.addFailed")));
    } finally {
      onBusy(false);
    }
  }

  async function remove(member: ServerMember) {
    onBusy(true);
    onError(null);
    try {
      await unassignMemberRole(serverId, member.id, roleId);
      await reload();
    } catch (err) {
      onError(messageOf(err, t("roles.members.removeFailed")));
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("roles.members.search")}
        aria-label={t("roles.members.search")}
        className="h-9 rounded-xl border-0 bg-ink-2"
      />
      {loading ? (
        <p className="px-1 py-4 text-sm text-paper-muted">
          {t("memberList.loading")}
        </p>
      ) : (
        <>
          {visibleHolding.length === 0 && addable.length === 0 && (
            <p className="px-1 py-4 text-sm text-paper-muted">
              {trimmed
                ? t("roles.members.noMatches", { query: trimmed })
                : t("roles.members.empty")}
            </p>
          )}
          {(visibleHolding.length > 0 || addable.length > 0) && (
            <ul className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
              {visibleHolding.map((member) => {
                const shown = memberDisplayName(member);
                return (
                  <li
                    key={member.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <UserAvatar
                      name={shown}
                      avatarUrl={member.avatarUrl}
                      className="h-8 w-8"
                      rounded="full"
                      fallbackClassName="bg-ink-3 text-xs"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-paper">
                      {shown}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t("roles.members.remove", { name: shown })}
                      className="w-16 shrink-0 text-right text-sm font-medium text-danger hover:underline disabled:opacity-40"
                      onClick={() => void remove(member)}
                    >
                      {t("roles.members.removeAction")}
                    </button>
                  </li>
                );
              })}
              {addable.map((member) => {
                const shown = memberDisplayName(member);
                return (
                  <li
                    key={`add-${member.id}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <UserAvatar
                      name={shown}
                      avatarUrl={member.avatarUrl}
                      className="h-8 w-8"
                      rounded="full"
                      fallbackClassName="bg-ink-3 text-xs"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-paper">
                      {shown}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      className="w-16 shrink-0 text-right text-sm font-medium text-signal hover:underline disabled:opacity-40"
                      onClick={() => void add(member)}
                    >
                      {t("roles.members.add")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
