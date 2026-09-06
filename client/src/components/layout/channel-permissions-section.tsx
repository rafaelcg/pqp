import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { Permission, parsePermissions, serializePermissions } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  ApiError,
  addChannelMember,
  memberDisplayName,
  memberMatchesQuery,
  putChannelOverwrite,
  deleteChannelOverwrite,
  removeChannelMember,
  type ChannelOverwrite,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import {
  applyListedOverwriteState,
  overwriteBitsForChannel,
  overwriteState,
  shouldDeleteOverwrite,
  type OverwriteState,
} from "@/lib/overwrite-tristate";
import {
  planRecipe,
  readRecipe,
  recipeBitsForChannel,
  roleIgnoresChannelOverwrites,
  type RecipeKind,
  type RecipeOverwrite,
} from "@/lib/speak-recipe";
import { cn } from "@/lib/utils";
import { joinRoleNames } from "@/components/layout/channel-overview-section";

function permLabelKey(flag: string): MessageKey {
  return `roles.perm.${flag}` as MessageKey;
}

const PERM_HINTS: Partial<Record<string, MessageKey>> = {
  VIEW_CHANNEL: "roles.permHint.VIEW_CHANNEL",
  MANAGE_MESSAGES: "roles.permHint.MANAGE_MESSAGES",
  CONNECT: "roles.permHint.CONNECT",
  SPEAK: "roles.permHint.SPEAK",
  STREAM: "roles.permHint.STREAM",
};

const OVERRIDE_OPTIONS: {
  state: Exclude<OverwriteState, "inherit">;
  Icon: typeof Check;
  selected: string;
}[] = [
  {
    state: "allow",
    Icon: Check,
    selected: "bg-success/20 text-success",
  },
  {
    state: "deny",
    Icon: X,
    selected: "bg-danger/20 text-danger",
  },
];

function OverwriteStateControl({
  value,
  disabled,
  onChange,
  labels,
  clearLabel,
}: {
  value: OverwriteState;
  disabled?: boolean;
  onChange: (state: OverwriteState) => void;
  labels: Record<OverwriteState, string>;
  clearLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={labels[value]}
      className="flex shrink-0 gap-0.5 rounded-lg bg-ink p-0.5"
    >
      {OVERRIDE_OPTIONS.map(({ state, Icon, selected }) => {
        const active = value === state;
        return (
          <button
            key={state}
            type="button"
            aria-pressed={active}
            aria-label={active ? clearLabel : labels[state]}
            title={active ? clearLabel : labels[state]}
            disabled={disabled}
            onClick={() => onChange(active ? "inherit" : state)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
              active ? selected : "text-paper-muted hover:bg-ink-3 hover:text-paper",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={active ? 2.5 : 2} />
          </button>
        );
      })}
    </div>
  );
}

function AddTargetButton({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl bg-ink px-3 text-left text-sm",
          "text-paper hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        )}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <ul className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-48 overflow-y-auto rounded-xl bg-ink-3 py-1 shadow-lg ring-1 ring-ink-4">
          {children}
        </ul>
      )}
    </div>
  );
}

function toRecipeRows(overwrites: ChannelOverwrite[]): RecipeOverwrite[] {
  return overwrites.map((row) => ({
    targetType: row.targetType,
    targetId: row.targetId,
    allow: parsePermissions(row.allow),
    deny: parsePermissions(row.deny),
  }));
}

export function readChannelRecipe(
  overwrites: ChannelOverwrite[],
  everyoneId: string | undefined,
  channelType: string,
): { kind: RecipeKind; roleIds: string[] } {
  if (!everyoneId) {
    return { kind: "everyone", roleIds: [] };
  }
  return readRecipe(
    toRecipeRows(overwrites),
    everyoneId,
    recipeBitsForChannel(channelType),
  );
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

export function ChannelPermissionsSection({
  channelId,
  channelType,
  isPrivate,
  roles,
  overwrites,
  onOverwritesChange,
  serverMembers,
  channelMembers,
  onChannelMembersChange,
  canManageRoles,
  canManageAccess,
  forceAdvancedOpen,
  recipeRef,
  privateRef,
  onPrivateChange,
  privateBusy,
  reloadOverwrites,
}: {
  channelId: string;
  channelType: string;
  isPrivate: boolean;
  roles: ServerRole[];
  overwrites: ChannelOverwrite[];
  onOverwritesChange: (next: ChannelOverwrite[]) => void;
  reloadOverwrites: () => Promise<ChannelOverwrite[]>;
  serverMembers: ServerMember[];
  channelMembers: ServerMember[];
  onChannelMembersChange: (next: ServerMember[]) => void;
  canManageRoles: boolean;
  canManageAccess: boolean;
  forceAdvancedOpen: boolean;
  recipeRef: (node: HTMLElement | null) => void;
  privateRef: (node: HTMLElement | null) => void;
  onPrivateChange: (next: boolean) => Promise<void>;
  privateBusy: boolean;
}) {
  const { t, locale } = useTranslation();
  const everyone = roles.find((role) => role.isEveryone) ?? null;
  const recipe = readChannelRecipe(overwrites, everyone?.id, channelType);
  const pickedRoles = roles.filter(
    (role) =>
      recipe.roleIds.includes(role.id) && !roleIgnoresChannelOverwrites(role),
  );
  const recipeNames = pickedRoles.map((role) => role.name);
  const isVoice = channelType === "voice";
  const [advancedOpen, setAdvancedOpen] = useState(
    forceAdvancedOpen || recipe.kind === "custom",
  );
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [recipeError, setRecipeError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<TargetKey | null>(null);
  const [addingTarget, setAddingTarget] = useState<"role" | "member" | null>(
    null,
  );
  const [memberQuery, setMemberQuery] = useState("");
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const lastRecipeRef = useRef<{
    choice: "everyone" | "roles";
    roleIds: string[];
  } | null>(null);
  const recipeGenRef = useRef(0);

  useEffect(() => {
    if (forceAdvancedOpen || recipe.kind === "custom") {
      setAdvancedOpen(true);
    }
  }, [forceAdvancedOpen, recipe.kind]);

  const bits = overwriteBitsForChannel(channelType);
  const targets = useMemo(() => {
    const overwriteByKey = new Map<TargetKey, ChannelOverwrite>();
    for (const row of overwrites) {
      overwriteByKey.set(`${row.targetType}:${row.targetId}`, row);
    }
    const memberById = new Map(serverMembers.map((m) => [m.id, m]));

    function roleTarget(role: ServerRole): TargetRow {
      const existing = overwriteByKey.get(`role:${role.id}`);
      return {
        key: `role:${role.id}`,
        targetType: "role",
        targetId: role.id,
        label: role.isEveryone ? "@everyone" : role.name,
        allow: existing ? parsePermissions(existing.allow) : 0n,
        deny: existing ? parsePermissions(existing.deny) : 0n,
        administrator:
          (parsePermissions(role.permissions) & Permission.ADMINISTRATOR) ===
          Permission.ADMINISTRATOR,
      };
    }

    const ordered: TargetRow[] = [];
    if (everyone) {
      ordered.push(roleTarget(everyone));
    }
    for (const role of [...roles]
      .filter((role) => !role.isEveryone)
      .sort((a, b) => b.position - a.position)) {
      ordered.push(roleTarget(role));
    }
    const memberRows = overwrites
      .filter((row) => row.targetType === "member")
      .map((row) => {
        const person = memberById.get(row.targetId);
        return {
          key: `member:${row.targetId}` as TargetKey,
          targetType: "member" as const,
          targetId: row.targetId,
          label: person?.displayName ?? row.targetId,
          allow: parsePermissions(row.allow),
          deny: parsePermissions(row.deny),
          administrator: false,
        };
      })
      .sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
      );
    return [...ordered, ...memberRows];
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

  const holding = channelMembers.filter((member) =>
    memberMatchesQuery(member, memberQuery),
  );
  const addableAllowlist =
    memberQuery.trim().length > 0
      ? serverMembers.filter(
          (member) =>
            !channelMembers.some((row) => row.id === member.id) &&
            memberMatchesQuery(member, memberQuery),
        )
      : [];

  async function persist(
    targetType: "role" | "member",
    targetId: string,
    allow: bigint,
    deny: bigint,
  ) {
    if (shouldDeleteOverwrite(allow, deny)) {
      await deleteChannelOverwrite(channelId, targetType, targetId);
      onOverwritesChange(
        overwrites.filter(
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
    onOverwritesChange([
      ...overwrites.filter(
        (row) => !(row.targetType === targetType && row.targetId === targetId),
      ),
      body,
    ]);
  }

  function recipeTargetLabel(targetId: string): string {
    const role = roles.find((row) => row.id === targetId);
    if (role) {
      return role.isEveryone ? "@everyone" : role.name;
    }
    return (
      serverMembers.find((member) => member.id === targetId)?.displayName ??
      targetId
    );
  }

  async function applyWrites(
    writes: ReturnType<typeof planRecipe>,
  ): Promise<{ target: string; detail?: string; slow?: boolean } | null> {
    let next = overwrites;
    for (const write of writes) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (write.op === "delete") {
            const exists = next.some(
              (row) =>
                row.targetType === write.targetType &&
                row.targetId === write.targetId,
            );
            if (exists) {
              await deleteChannelOverwrite(
                channelId,
                write.targetType,
                write.targetId,
              );
            }
            next = next.filter(
              (row) =>
                !(
                  row.targetType === write.targetType &&
                  row.targetId === write.targetId
                ),
            );
          } else {
            const body: ChannelOverwrite = {
              targetType: write.targetType,
              targetId: write.targetId,
              allow: serializePermissions(write.allow),
              deny: serializePermissions(write.deny),
            };
            await putChannelOverwrite(channelId, body);
            next = [
              ...next.filter(
                (row) =>
                  !(
                    row.targetType === write.targetType &&
                    row.targetId === write.targetId
                  ),
              ),
              body,
            ];
          }
          onOverwritesChange(next);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const retryable =
            err instanceof ApiError && err.status === 429 && attempt < 3;
          if (!retryable) {
            break;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 800 * (attempt + 1)),
          );
        }
      }
      if (lastError) {
        if (lastError instanceof ApiError && lastError.status === 429) {
          return { target: recipeTargetLabel(write.targetId), slow: true };
        }
        const detail =
          lastError instanceof Error ? lastError.message : "";
        console.error("channel recipe write failed", write, lastError);
        return { target: recipeTargetLabel(write.targetId), detail };
      }
    }
    return null;
  }

  async function applyRecipe(
    choice: "everyone" | "roles",
    roleIds: string[],
  ) {
    if (!everyone) {
      return;
    }
    const gen = ++recipeGenRef.current;
    lastRecipeRef.current = { choice, roleIds };
    setRecipeBusy(true);
    setRecipeError(null);
    const failed = await applyWrites(
      planRecipe(
        toRecipeRows(overwrites),
        everyone.id,
        recipeBitsForChannel(channelType),
        choice,
        roleIds,
      ),
    );
    if (gen !== recipeGenRef.current) {
      return;
    }
    if (failed) {
      try {
        await reloadOverwrites();
      } catch {
        // Readback already uses whatever we last persisted.
      }
      setRecipeError(
        failed.slow
          ? t("channelSettings.recipeSlowDown")
          : failed.detail
            ? t("channelSettings.recipeFailedDetail", {
                target: failed.target,
                detail: failed.detail,
              })
            : t("channelSettings.recipeFailed", { target: failed.target }),
      );
    }
    setRecipeBusy(false);
  }

  function chooseEveryone() {
    void applyRecipe("everyone", []);
  }

  function chooseRoles(roleIds: string[]) {
    void applyRecipe(
      "roles",
      roleIds.filter((id) => {
        const role = roles.find((row) => row.id === id);
        return (
          role &&
          !role.isEveryone &&
          !roleIgnoresChannelOverwrites(role)
        );
      }),
    );
  }

  function retryRecipe() {
    const last = lastRecipeRef.current;
    if (!last) {
      return;
    }
    void applyRecipe(last.choice, last.roleIds);
  }

  async function setBit(flag: (typeof bits)[number], state: OverwriteState) {
    if (!selected) {
      return;
    }
    setRowBusy(selected.key);
    setRowError(null);
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
      setRowError(
        err instanceof Error ? err.message : t("channelPerms.saveFailed"),
      );
    } finally {
      setRowBusy(null);
    }
  }

  async function addMember(member: ServerMember) {
    setMemberBusy(member.id);
    setMemberError(null);
    try {
      await addChannelMember(channelId, member.id);
      onChannelMembersChange([...channelMembers, member]);
    } catch (err) {
      setMemberError(
        err instanceof Error ? err.message : t("channelMembers.addFailed"),
      );
    } finally {
      setMemberBusy(null);
    }
  }

  async function removeMember(member: ServerMember) {
    setMemberBusy(member.id);
    setMemberError(null);
    try {
      await removeChannelMember(channelId, member.id);
      onChannelMembersChange(
        channelMembers.filter((row) => row.id !== member.id),
      );
    } catch (err) {
      setMemberError(
        err instanceof Error ? err.message : t("channelMembers.removeFailed"),
      );
    } finally {
      setMemberBusy(null);
    }
  }

  const readback =
    recipe.kind === "everyone"
      ? t(
          isVoice
            ? "channelSettings.readback.speakEveryone"
            : "channelSettings.readback.postEveryone",
        )
      : recipe.kind === "custom"
        ? t("channelSettings.readback.custom")
        : recipeNames.length === 0
          ? t(
              isVoice
                ? "channelSettings.readback.speakRolesEmpty"
                : "channelSettings.readback.postRolesEmpty",
            )
          : t(
              isVoice
                ? "channelSettings.readback.speakRoles"
                : "channelSettings.readback.postRoles",
              { roles: joinRoleNames(recipeNames, locale) },
            );

  return (
    <div className="space-y-5">
      {canManageAccess && (
        <section ref={privateRef} className="space-y-3">
          <Switch
            checked={isPrivate}
            disabled={privateBusy}
            onCheckedChange={(next) => void onPrivateChange(next)}
            label={t("channelSettings.private")}
            description={t("channelSettings.privateHint")}
          />
          {isPrivate && (
            <div className="space-y-2">
              <p className="text-[15px] font-semibold text-paper">
                {t("channelSettings.whoSees", { count: channelMembers.length })}
              </p>
              <Input
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                placeholder={t("channelSettings.searchMember")}
                aria-label={t("channelSettings.searchMember")}
                className="h-9 rounded-xl border-0 bg-ink-2"
              />
              {holding.length === 0 && addableAllowlist.length === 0 ? (
                <p className="px-1 py-3 text-sm text-paper-muted">
                  {t("channelSettings.allowlistEmpty")}
                </p>
              ) : (
                <ul className="max-h-56 divide-y divide-ink-4/60 overflow-y-auto rounded-2xl bg-ink-2">
                  {holding.map((member) => (
                    <li
                      key={member.id}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
                      <UserAvatar
                        name={memberDisplayName(member)}
                        avatarUrl={member.avatarUrl}
                        className="h-8 w-8"
                        rounded="full"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {memberDisplayName(member)}
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
                        className="w-[6.25rem] shrink-0"
                        disabled={memberBusy === member.id}
                        onClick={() => void removeMember(member)}
                      >
                        {t("channelMembers.remove")}
                      </Button>
                    </li>
                  ))}
                  {addableAllowlist.map((member) => (
                    <li
                      key={member.id}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
                      <UserAvatar
                        name={memberDisplayName(member)}
                        avatarUrl={member.avatarUrl}
                        className="h-8 w-8"
                        rounded="full"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {memberDisplayName(member)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-[6.25rem] shrink-0"
                        disabled={memberBusy === member.id}
                        onClick={() => void addMember(member)}
                      >
                        {t("channelMembers.add")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {memberError && (
                <p className="text-sm text-danger" role="alert">
                  {memberError}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {canManageRoles && everyone && (
        <section ref={recipeRef} className="space-y-3">
          <div>
            <h3 className="text-[15px] font-semibold text-paper">
              {t(
                isVoice
                  ? "channelSettings.whoSpeaks"
                  : "channelSettings.whoPosts",
              )}
            </h3>
            <p className="mt-1 min-h-10 text-sm text-paper-muted">{readback}</p>
          </div>
          <div className="overflow-hidden rounded-2xl bg-ink-2">
            <button
              type="button"
              disabled={recipeBusy}
              aria-pressed={recipe.kind === "everyone"}
              onClick={() => chooseEveryone()}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left",
                recipe.kind === "everyone"
                  ? "bg-signal/12"
                  : "hover:bg-ink-3",
              )}
            >
              <span className="text-sm font-medium text-paper">
                {t("channelSettings.recipe.everyone")}
              </span>
              <span className="text-xs text-paper-muted">
                {t(
                  isVoice
                    ? "channelSettings.recipe.everyone.speakHint"
                    : "channelSettings.recipe.everyone.postHint",
                )}
              </span>
            </button>
            <button
              type="button"
              disabled={recipeBusy}
              aria-pressed={recipe.kind === "roles"}
              onClick={() =>
                chooseRoles(
                  recipe.roleIds.length > 0
                    ? recipe.roleIds
                    : roles
                        .filter((role) => role.systemKey === "moderator")
                        .map((role) => role.id),
                )
              }
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left",
                recipe.kind === "roles" ? "bg-signal/12" : "hover:bg-ink-3",
              )}
            >
              <span className="text-sm font-medium text-paper">
                {t("channelSettings.recipe.roles")}
              </span>
              <span className="text-xs text-paper-muted">
                {t(
                  isVoice
                    ? "channelSettings.recipe.roles.speakHint"
                    : "channelSettings.recipe.roles.postHint",
                )}
              </span>
            </button>
            <div
              className={cn(
                "max-h-64 overflow-y-auto overscroll-contain border-t border-ink-4/60 px-2 py-1",
                recipe.kind === "everyone" && "opacity-60",
              )}
            >
              {[
                ...roles.filter((role) => role.isEveryone),
                ...roles.filter((role) => !role.isEveryone),
              ].map((role) => {
                const isEveryone = Boolean(role.isEveryone);
                const locked = roleIgnoresChannelOverwrites(role);
                const everyoneMode = recipe.kind === "everyone";
                return (
                  <CheckRow
                    key={role.id}
                    checked={
                      isEveryone
                        ? everyoneMode
                        : locked ||
                          everyoneMode ||
                          recipe.roleIds.includes(role.id)
                    }
                    disabled={
                      recipeBusy || locked || everyoneMode || isEveryone
                    }
                    label={isEveryone ? "@everyone" : role.name}
                    title={
                      isEveryone && !everyoneMode
                        ? t("channelSettings.recipe.everyoneExcluded")
                        : locked
                          ? t("channelSettings.recipe.lockedStaff")
                          : undefined
                    }
                    swatch={role.color}
                    onCheckedChange={(checked) => {
                      const base =
                        recipe.kind === "roles" ? recipe.roleIds : [];
                      const next = checked
                        ? [...base, role.id]
                        : base.filter((id) => id !== role.id);
                      chooseRoles(next);
                    }}
                  />
                );
              })}
            </div>
          </div>
          {recipeError && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-danger" role="alert">
                {recipeError}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                disabled={recipeBusy}
                onClick={retryRecipe}
              >
                {t("channelSettings.recipeRetry")}
              </Button>
            </div>
          )}
        </section>
      )}

      {canManageRoles && (
        <section>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-left"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <span className="text-[15px] font-semibold text-paper">
              {t("channelSettings.advanced")}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-paper-muted transition-transform",
                advancedOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
          {!advancedOpen && (
            <p className="px-1 text-sm text-paper-muted">
              {t("channelSettings.advancedEmpty")}
            </p>
          )}
          {advancedOpen && (
            <div className="mt-2 space-y-3">
              <div className="flex min-h-0 flex-col gap-3 sm:flex-row">
                <ul className="max-h-64 w-full shrink-0 space-y-1 overflow-y-auto overscroll-contain sm:w-44">
                  {targets.map((row) => (
                    <li key={row.key}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(row.key)}
                        className={cn(
                          "w-full break-words rounded-md px-2 py-1.5 text-left text-sm",
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
                <div className="min-w-0 flex-1">
                  {selected && (
                    <div className="divide-y divide-ink-4/60 overflow-hidden rounded-2xl bg-ink-2">
                      <p className="min-h-8 px-3 py-2 text-xs text-paper-muted">
                        {selected.targetType === "role" &&
                        selected.targetId === everyone?.id
                          ? t("channelSettings.everyoneHint")
                          : selected.administrator
                            ? t("channelPerms.administratorHint")
                            : t("channelPerms.defaultHint")}
                      </p>
                      {bits.map((flag) => {
                        const bit = Permission[flag];
                        const viewLocked =
                          selected.targetType === "role" &&
                          selected.targetId === everyone?.id &&
                          flag === "VIEW_CHANNEL";
                        const state = viewLocked
                          ? isPrivate
                            ? "deny"
                            : "inherit"
                          : overwriteState(bit, selected.allow, selected.deny);
                        return (
                          <div
                            key={flag}
                            className="flex min-h-[4.25rem] items-center justify-between gap-3 px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-paper">
                                {t(permLabelKey(flag))}
                              </p>
                              <p className="min-h-8 text-xs text-paper-muted">
                                {viewLocked
                                  ? t("channelSettings.viewLocked")
                                  : PERM_HINTS[flag]
                                    ? t(PERM_HINTS[flag]!)
                                    : "\u00a0"}
                              </p>
                            </div>
                            <OverwriteStateControl
                              value={state}
                              disabled={viewLocked || rowBusy === selected.key}
                              labels={{
                                allow: t("channelPerms.allow"),
                                inherit: t("channelPerms.default"),
                                deny: t("channelPerms.deny"),
                              }}
                              clearLabel={t("channelPerms.clear")}
                              onChange={(next) => void setBit(flag, next)}
                            />
                          </div>
                        );
                      })}
                      {rowError && (
                        <p className="px-3 py-2 text-sm text-danger" role="alert">
                          {rowError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {(addableRoles.length > 0 || addableMembers.length > 0) && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {addableRoles.length > 0 && (
                    <AddTargetButton
                      label={t("channelPerms.addRole")}
                      open={addingTarget === "role"}
                      onOpenChange={(open) =>
                        setAddingTarget(open ? "role" : null)
                      }
                    >
                      {addableRoles.map((role) => (
                        <li key={role.id}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-paper hover:bg-ink-3"
                            onClick={() => {
                              setSelectedKey(`role:${role.id}`);
                              onOverwritesChange([
                                ...overwrites,
                                {
                                  targetType: "role",
                                  targetId: role.id,
                                  allow: "0",
                                  deny: "0",
                                },
                              ]);
                              setAddingTarget(null);
                            }}
                          >
                            {role.color ? (
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: role.color }}
                                aria-hidden
                              />
                            ) : null}
                            <span className="truncate">{role.name}</span>
                          </button>
                        </li>
                      ))}
                    </AddTargetButton>
                  )}
                  {addableMembers.length > 0 && (
                    <AddTargetButton
                      label={t("channelPerms.addMember")}
                      open={addingTarget === "member"}
                      onOpenChange={(open) =>
                        setAddingTarget(open ? "member" : null)
                      }
                    >
                      {addableMembers.map((member) => (
                        <li key={member.id}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-paper hover:bg-ink-3"
                            onClick={() => {
                              setSelectedKey(`member:${member.id}`);
                              onOverwritesChange([
                                ...overwrites,
                                {
                                  targetType: "member",
                                  targetId: member.id,
                                  allow: "0",
                                  deny: "0",
                                },
                              ]);
                              setAddingTarget(null);
                            }}
                          >
                            <span className="truncate">
                              {memberDisplayName(member)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </AddTargetButton>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
