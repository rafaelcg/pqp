import {
  Permission,
  clampEveryonePermissions,
  hasPermission,
  parsePermissions,
  serializePermissions,
  type PermissionFlagKey,
} from "@pqp/shared";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ApiError,
  createRole,
  deleteRole,
  fetchRoles,
  reorderRoles,
  updateRole,
  type ServerRole,
} from "@/lib/api";
import { cssColorToRgb, rgbToHex } from "@/lib/oklch";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/** Native colour input needs a six-digit hex. Read the accent, never a hex literal. */
function pickerFace(color: string | null): string {
  if (color) {
    return color;
  }
  const raw =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue("--color-accent")
          .trim();
  return rgbToHex(cssColorToRgb(raw, { l: 0.88, c: 0.19, h: 125 }));
}

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
  "MANAGE_SERVER",
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

export function RolesSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<ServerRole[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [mentionable, setMentionable] = useState(false);
  const [hoist, setHoist] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [permissions, setPermissions] = useState(0n);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const rankedRoles = [...roles].sort((a, b) => b.position - a.position);
  const movableIds = rankedRoles
    .filter((role) => !role.isEveryone)
    .map((role) => role.id);

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

  async function reload(preferId?: string) {
    const { roles: list } = await fetchRoles(serverId);
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
    setColor(role.color);
    setPermissions(rolePermissions(role));
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
        color: selected.isEveryone ? undefined : color,
        permissions: serializePermissions(
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

  async function moveRole(roleId: string, direction: -1 | 1) {
    const index = movableIds.indexOf(roleId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= movableIds.length) {
      return;
    }
    const next = [...movableIds];
    const current = next[index]!;
    next[index] = next[nextIndex]!;
    next[nextIndex] = current;
    setSaving(true);
    setError(null);
    try {
      await reorderRoles(serverId, [...next].reverse());
      await reload(selectedId ?? roleId);
    } catch (err) {
      setError(messageOf(err, t("roles.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 sm:flex-row">
      <div className="w-full shrink-0 space-y-2 sm:w-52">
        <p className="text-xs text-paper-muted">{t("roles.hierarchyHint")}</p>
        <ul className="space-y-1">
          {rankedRoles.map((role) => {
            const movableIndex = movableIds.indexOf(role.id);
            const canMoveUp = movableIndex > 0;
            const canMoveDown =
              movableIndex >= 0 && movableIndex < movableIds.length - 1;
            return (
              <li key={role.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => selectRole(role)}
                  className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm ${
                    role.id === selectedId
                      ? "bg-signal/12 font-medium text-paper"
                      : "text-paper-muted hover:bg-ink-3 hover:text-paper"
                  }`}
                >
                  {role.color && (
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: role.color }}
                      aria-hidden
                    />
                  )}
                  {role.isEveryone ? "@everyone" : role.name}
                </button>
                {!role.isEveryone && (
                  <div className="flex shrink-0">
                    <button
                      type="button"
                      aria-label={t("chrome.moveUp")}
                      disabled={saving || !canMoveUp}
                      onClick={() => void moveRole(role.id, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("chrome.moveDown")}
                      disabled={saving || !canMoveDown}
                      onClick={() => void moveRole(role.id, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex gap-1">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={t("roles.newPlaceholder")}
            maxLength={32}
            aria-label={t("roles.newPlaceholder")}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={saving || newName.trim().length < 2}
            onClick={() => void addRole()}
          >
            {t("roles.add")}
          </Button>
        </div>
      </div>

      {selected && (
        <div className="min-w-0 flex-1 space-y-4">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={selected.isEveryone}
            maxLength={32}
            aria-label={t("roles.name")}
          />
          {selected.isEveryone && (
            <p className="text-xs text-paper-muted">{t("roles.everyoneHint")}</p>
          )}
          {selected.systemKey === "admin" && (
            <p className="text-xs text-paper-muted">{t("roles.adminHint")}</p>
          )}
          <Switch
            checked={mentionable}
            onCheckedChange={setMentionable}
            label={t("roles.mentionable")}
          />
          {!selected.isEveryone && (
            <>
              <Switch
                checked={hoist}
                onCheckedChange={setHoist}
                label={t("roles.hoist")}
                description={t("roles.hoistHint")}
              />
              <div className="flex items-center gap-2 px-2 py-1">
                <label className="flex items-center gap-2 text-sm text-paper">
                  {t("roles.color")}
                  <input
                    type="color"
                    value={pickerFace(color)}
                    onChange={(event) => setColor(event.target.value)}
                    className="h-7 w-10 cursor-pointer rounded-md border border-ink-4 bg-ink-2"
                  />
                </label>
                {color && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setColor(null)}
                  >
                    {t("roles.colorClear")}
                  </Button>
                )}
              </div>
            </>
          )}
          <fieldset className="space-y-3">
            <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-paper-muted">
              {t("roles.permissions")}
            </legend>
            <div className="rounded-md border border-ink-4 bg-ink-2 p-2">
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
              />
            </div>
            {PERMISSION_GROUPS.map((group) => {
              const keys = group.keys.filter((key) => !UNENFORCED_FLAGS.has(key));
              if (keys.length === 0) {
                return null;
              }
              return (
              <div key={group.heading}>
                <p className="mb-1 px-2 text-xs uppercase tracking-wide text-paper-muted">
                  {t(group.heading)}
                </p>
                <div className="space-y-0.5">
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
                      />
                    );
                  })}
                </div>
              </div>
              );
            })}
          </fieldset>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
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
        </div>
      )}
    </div>
  );
}
