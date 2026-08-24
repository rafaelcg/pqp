import { Permission, parsePermissions, serializePermissions } from "@pqp/shared";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  addChannelMember,
  deleteChannelOverwrite,
  fetchChannelMembers,
  fetchChannelOverwrites,
  fetchMembers,
  putChannelOverwrite,
  removeChannelMember,
  type ChannelOverwrite,
  type ServerRole,
} from "@/lib/api";
import {
  applyListedOverwriteState,
  overwriteBitsForChannel,
  overwriteState,
  shouldDeleteOverwrite,
  type OverwriteState,
} from "@/lib/overwrite-tristate";
import { cn } from "@/lib/utils";

interface Person {
  id: string;
  displayName: string;
  tag: string | null;
}

interface ChannelMembersPanelProps {
  open: boolean;
  channelId: string | null;
  channelName: string | null;
  channelType: string;
  isPrivate: boolean;
  serverId: string | null;
  roles: ServerRole[];
  canManageRoles: boolean;
  canManageAccess: boolean;
  onClose: () => void;
}

type TargetKey = `${"role" | "member"}:${string}`;

interface TargetRow {
  key: TargetKey;
  targetType: "role" | "member";
  targetId: string;
  label: string;
  allow: bigint;
  deny: bigint;
  administrator: boolean;
}

function permLabelKey(flag: string): MessageKey {
  return `roles.perm.${flag}` as MessageKey;
}

export function ChannelMembersPanel({
  open,
  channelId,
  channelName,
  channelType,
  isPrivate,
  serverId,
  roles,
  canManageRoles,
  canManageAccess,
  onClose,
}: ChannelMembersPanelProps) {
  const { t } = useTranslation();
  const [channelMembers, setChannelMembers] = useState<Person[]>([]);
  const [serverMembers, setServerMembers] = useState<Person[]>([]);
  const [overwrites, setOverwrites] = useState<ChannelOverwrite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<TargetKey | null>(null);
  const [addRoleId, setAddRoleId] = useState("");
  const [addMemberId, setAddMemberId] = useState("");

  const bits = overwriteBitsForChannel(channelType);
  const everyone = roles.find((role) => role.isEveryone) ?? null;

  useEffect(() => {
    if (!open || !channelId || !serverId) {
      return;
    }
    let cancelled = false;
    setError(null);
    setChannelMembers([]);
    setServerMembers([]);
    setOverwrites([]);
    setLoading(true);

    async function load(channel: string, server: string) {
      try {
        const [channelRes, serverRes, overwriteRes] = await Promise.all([
          canManageAccess
            ? fetchChannelMembers(channel)
            : Promise.resolve({ members: [] as Person[] }),
          fetchMembers(server),
          canManageRoles
            ? fetchChannelOverwrites(channel)
            : Promise.resolve({ overwrites: [] as ChannelOverwrite[] }),
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
        setOverwrites(overwriteRes.overwrites);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t("channelPerms.loadFailed"),
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load(channelId, serverId);
    return () => {
      cancelled = true;
    };
  }, [open, channelId, serverId, canManageAccess, canManageRoles, t]);

  const memberIds = useMemo(
    () => new Set(channelMembers.map((m) => m.id)),
    [channelMembers],
  );
  const candidates = serverMembers.filter((m) => !memberIds.has(m.id));

  const targets = useMemo(() => {
    const byKey = new Map<TargetKey, TargetRow>();
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const memberById = new Map(serverMembers.map((m) => [m.id, m]));

    if (everyone) {
      byKey.set(`role:${everyone.id}`, {
        key: `role:${everyone.id}`,
        targetType: "role",
        targetId: everyone.id,
        label: "@everyone",
        allow: 0n,
        deny: 0n,
        administrator: false,
      });
    }

    for (const row of overwrites) {
      const key: TargetKey = `${row.targetType}:${row.targetId}`;
      const role = row.targetType === "role" ? roleById.get(row.targetId) : undefined;
      const person =
        row.targetType === "member" ? memberById.get(row.targetId) : undefined;
      const label =
        role?.isEveryone
          ? "@everyone"
          : (role?.name ?? person?.displayName ?? row.targetId);
      byKey.set(key, {
        key,
        targetType: row.targetType,
        targetId: row.targetId,
        label,
        allow: parsePermissions(row.allow),
        deny: parsePermissions(row.deny),
        administrator: role
          ? (parsePermissions(role.permissions) & Permission.ADMINISTRATOR) ===
            Permission.ADMINISTRATOR
          : false,
      });
    }

    const ordered: TargetRow[] = [];
    if (everyone) {
      const row = byKey.get(`role:${everyone.id}`);
      if (row) {
        ordered.push(row);
        byKey.delete(row.key);
      }
    }
    const roleRows = [...byKey.values()]
      .filter((row) => row.targetType === "role")
      .sort((a, b) => {
        const posA = roleById.get(a.targetId)?.position ?? 0;
        const posB = roleById.get(b.targetId)?.position ?? 0;
        return posB - posA;
      });
    const memberRows = [...byKey.values()]
      .filter((row) => row.targetType === "member")
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    return [...ordered, ...roleRows, ...memberRows];
  }, [everyone, overwrites, roles, serverMembers]);

  useEffect(() => {
    if (targets.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !targets.some((row) => row.key === selectedKey)) {
      setSelectedKey(targets[0]!.key);
    }
  }, [targets, selectedKey]);

  const selected = targets.find((row) => row.key === selectedKey) ?? null;
  const everyoneViewLocked =
    selected?.targetType === "role" && selected.targetId === everyone?.id;
  const addableRoles = roles.filter(
    (role) =>
      !role.isEveryone &&
      !targets.some((row) => row.targetType === "role" && row.targetId === role.id),
  );
  const addableMembers = serverMembers.filter(
    (member) =>
      !targets.some(
        (row) => row.targetType === "member" && row.targetId === member.id,
      ),
  );

  async function persist(
    targetType: "role" | "member",
    targetId: string,
    allow: bigint,
    deny: bigint,
  ) {
    if (!channelId) {
      return;
    }
    if (shouldDeleteOverwrite(allow, deny)) {
      await deleteChannelOverwrite(channelId, targetType, targetId);
      setOverwrites((prev) =>
        prev.filter(
          (row) => !(row.targetType === targetType && row.targetId === targetId),
        ),
      );
      return;
    }
    const body: ChannelOverwrite = {
      targetType,
      targetId,
      allow: serializePermissions(allow),
      deny: serializePermissions(deny),
    };
    await putChannelOverwrite(channelId, body);
    setOverwrites((prev) => {
      const without = prev.filter(
        (row) => !(row.targetType === targetType && row.targetId === targetId),
      );
      return [...without, body];
    });
  }

  async function setBit(flag: (typeof bits)[number], state: OverwriteState) {
    if (!selected) {
      return;
    }
    setBusyId(selected.key);
    setError(null);
    try {
      const next = applyListedOverwriteState(
        bits,
        flag,
        state,
        selected.allow,
        selected.deny,
      );
      await persist(selected.targetType, selected.targetId, next.allow, next.deny);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelPerms.saveFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function addTarget(targetType: "role" | "member", targetId: string) {
    if (!targetId) {
      return;
    }
    setSelectedKey(`${targetType}:${targetId}`);
    setOverwrites((prev) => [
      ...prev,
      { targetType, targetId, allow: "0", deny: "0" },
    ]);
    if (targetType === "role") {
      setAddRoleId("");
    } else {
      setAddMemberId("");
    }
  }

  async function addMember(userId: string) {
    if (!channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await addChannelMember(channelId, userId);
      const person = serverMembers.find((m) => m.id === userId);
      if (person) {
        setChannelMembers((prev) => [...prev, person]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelMembers.addFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(userId: string) {
    if (!channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await removeChannelMember(channelId, userId);
      setChannelMembers((prev) => prev.filter((m) => m.id !== userId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("channelMembers.removeFailed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  const showAccess = canManageAccess && isPrivate;

  return (
    <Dialog
      open={open}
      size="lg"
      eyebrow={
        isPrivate ? t("channelMembers.eyebrow") : t("channelPerms.eyebrow")
      }
      title={`#${channelName ?? t("channelMembers.fallbackName")}`}
      description={
        canManageRoles
          ? t("channelPerms.description")
          : t("channelMembers.description")
      }
      onClose={onClose}
    >
      <div className="space-y-5 p-4">
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {loading && (
          <p className="text-sm text-paper-muted" role="status">
            {t("channelMembers.loading")}
          </p>
        )}

        {canManageRoles && (
          <section className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
              {t("channelPerms.title")}
            </h3>
            <div className="flex min-h-0 flex-col gap-3 sm:flex-row">
              <div className="w-full shrink-0 space-y-2 sm:w-44">
                <ul className="space-y-1">
                  {targets.map((row) => (
                    <li key={row.key}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(row.key)}
                        className={cn(
                          "w-full rounded-md px-2 py-1.5 text-left text-sm",
                          row.key === selectedKey
                            ? "bg-signal/12 font-medium text-paper"
                            : "text-paper-muted hover:bg-ink-3 hover:text-paper",
                        )}
                      >
                        {row.label}
                      </button>
                    </li>
                  ))}
                </ul>
                {addableRoles.length > 0 && (
                  <select
                    className="w-full rounded-md border border-ink-4 bg-ink-2 px-2 py-1.5 text-sm text-paper"
                    value={addRoleId}
                    aria-label={t("channelPerms.addRole")}
                    onChange={(event) => {
                      const id = event.target.value;
                      setAddRoleId(id);
                      if (id) {
                        void addTarget("role", id);
                      }
                    }}
                  >
                    <option value="">{t("channelPerms.addRole")}</option>
                    {addableRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                )}
                {addableMembers.length > 0 && (
                  <select
                    className="w-full rounded-md border border-ink-4 bg-ink-2 px-2 py-1.5 text-sm text-paper"
                    value={addMemberId}
                    aria-label={t("channelPerms.addMember")}
                    onChange={(event) => {
                      const id = event.target.value;
                      setAddMemberId(id);
                      if (id) {
                        void addTarget("member", id);
                      }
                    }}
                  >
                    <option value="">{t("channelPerms.addMember")}</option>
                    {addableMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {selected && (
                  <>
                    {selected.administrator && (
                      <p className="text-xs text-paper-muted">
                        {t("channelPerms.administratorHint")}
                      </p>
                    )}
                    {bits.map((flag) => {
                      const bit = Permission[flag];
                      const locked = everyoneViewLocked && flag === "VIEW_CHANNEL";
                      const state = locked
                        ? isPrivate
                          ? "deny"
                          : "inherit"
                        : overwriteState(bit, selected.allow, selected.deny);
                      return (
                        <div
                          key={flag}
                          className="flex flex-col gap-1 rounded-md px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <p className="text-sm text-paper">{t(permLabelKey(flag))}</p>
                          <div className="flex rounded-md border border-ink-4">
                            {(["allow", "inherit", "deny"] as const).map((option) => (
                              <button
                                key={option}
                                type="button"
                                disabled={locked || busyId === selected.key}
                                aria-pressed={state === option}
                                onClick={() => void setBit(flag, option)}
                                className={cn(
                                  "px-2 py-1 text-xs",
                                  state === option
                                    ? "bg-signal/12 font-medium text-paper"
                                    : "text-paper-muted hover:bg-ink-3",
                                  locked && "cursor-not-allowed opacity-50",
                                )}
                              >
                                {t(`channelPerms.${option}` as MessageKey)}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {everyoneViewLocked && (
                      <p className="text-xs text-paper-muted">
                        {t("channelPerms.everyoneViewLocked")}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {showAccess && (
          <>
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
                {t("channelMembers.access", { count: channelMembers.length })}
              </h3>
              {channelMembers.length === 0 ? (
                <p className="text-sm text-paper-muted">
                  {loading ? t("common.loading") : t("channelMembers.empty")}
                </p>
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
                      aria-label={t("channelMembers.removeAria", {
                        name: member.displayName,
                      })}
                      disabled={busyId === member.id}
                      onClick={() => void removeMember(member.id)}
                    >
                      {t("channelMembers.remove")}
                    </Button>
                  </div>
                ))
              )}
            </section>

            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
                {t("channelMembers.addFromServer")}
              </h3>
              {candidates.length === 0 ? (
                <p className="text-sm text-paper-muted">
                  {t("channelMembers.everyoneHasAccess")}
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
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("channelMembers.addAria", {
                        name: member.displayName,
                      })}
                      disabled={busyId === member.id}
                      onClick={() => void addMember(member.id)}
                    >
                      {t("channelMembers.add")}
                    </Button>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
