import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Shield, Webhook } from "lucide-react";
import type { Channel } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SectionRail, type SectionRailItem } from "@/components/ui/section-rail";
import { ChannelIcon } from "@/components/layout/channel-icon";
import {
  ChannelOverviewSection,
  type ChannelOverviewDraft,
} from "@/components/layout/channel-overview-section";
import {
  ChannelPermissionsSection,
  readChannelRecipe,
} from "@/components/layout/channel-permissions-section";
import { WebhooksSection } from "@/components/layout/webhooks-section";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  fetchChannelMembers,
  fetchChannelOverwrites,
  fetchMembers,
  updateChannel,
  type ChannelOverwrite,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import {
  fromVoiceRoomSizeOption,
  showsVoiceRoomSize,
  toVoiceRoomSizeOption,
  validateChannelIconInput,
} from "@/lib/channel-meta";

export type ChannelSettingsSectionId =
  | "overview"
  | "permissions"
  | "webhooks";

function draftFromChannel(channel: Channel): ChannelOverviewDraft {
  return {
    name: channel.name,
    topic: channel.topic ?? "",
    imageUrl: channel.imageUrl ?? "",
    slowmodeSeconds: channel.slowmodeSeconds ?? 0,
    voiceRoomSize: toVoiceRoomSizeOption(channel.voiceTransport),
  };
}

function isOverviewDirty(
  draft: ChannelOverviewDraft,
  channel: Channel,
): boolean {
  const baseline = draftFromChannel(channel);
  return (
    draft.name.trim() !== baseline.name.trim() ||
    draft.topic.trim() !== baseline.topic.trim() ||
    draft.imageUrl.trim() !== baseline.imageUrl.trim() ||
    draft.slowmodeSeconds !== baseline.slowmodeSeconds ||
    draft.voiceRoomSize !== baseline.voiceRoomSize
  );
}

function hydrateMembers(
  slim: Array<{
    id: string;
    displayName: string;
    tag: string | null;
    username?: string | null;
  }>,
  serverMembers: ServerMember[],
): ServerMember[] {
  const byId = new Map(serverMembers.map((member) => [member.id, member]));
  return slim.map(
    (member) =>
      byId.get(member.id) ?? {
        id: member.id,
        displayName: member.displayName,
        tag: member.tag,
        role: "member",
        avatarUrl: null,
        username: member.username ?? null,
      },
  );
}

export function ChannelSettingsDialog({
  open,
  channel,
  requestedSection,
  forceAdvanced,
  serverId,
  roles,
  canManageChannels,
  canManageRoles,
  onClose,
  onChannelUpdated,
}: {
  open: boolean;
  channel: Channel | null;
  requestedSection: ChannelSettingsSectionId;
  forceAdvanced: boolean;
  serverId: string | null;
  roles: ServerRole[];
  canManageChannels: boolean;
  canManageRoles: boolean;
  onClose: () => void;
  onChannelUpdated: (channel: Channel) => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] =
    useState<ChannelSettingsSectionId>("overview");
  const wasOpenRef = useRef(false);
  const seededChannelIdRef = useRef<string | null>(null);
  const tabIdPrefix = useId();
  const panelId = useId();
  const recipeRef = useRef<HTMLElement | null>(null);
  const privateRef = useRef<HTMLElement | null>(null);
  const [scrollTo, setScrollTo] = useState<"recipe" | "private" | null>(null);

  const [draft, setDraft] = useState<ChannelOverviewDraft>({
    name: "",
    topic: "",
    imageUrl: "",
    slowmodeSeconds: 0,
    voiceRoomSize: "auto",
  });
  const [iconOpen, setIconOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [overwrites, setOverwrites] = useState<ChannelOverwrite[]>([]);
  const [serverMembers, setServerMembers] = useState<ServerMember[]>([]);
  const [channelMembers, setChannelMembers] = useState<ServerMember[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [privateBusy, setPrivateBusy] = useState(false);

  const canSeeOverview = canManageChannels;
  const canSeePermissions = canManageRoles || canManageChannels;
  const canSeeWebhooks =
    canManageChannels && channel?.type === "text";

  const visible = useMemo(() => {
    const ids: ChannelSettingsSectionId[] = [];
    if (canSeeOverview) {
      ids.push("overview");
    }
    if (canSeePermissions) {
      ids.push("permissions");
    }
    if (canSeeWebhooks) {
      ids.push("webhooks");
    }
    return ids;
  }, [canSeeOverview, canSeePermissions, canSeeWebhooks]);

  const firstSection = visible[0] ?? "overview";
  const openingSection: ChannelSettingsSectionId =
    visible.includes(requestedSection) ? requestedSection : firstSection;

  if (open && !wasOpenRef.current && section !== openingSection) {
    setSection(openingSection);
  }
  const needsSeed =
    open && channel !== null && seededChannelIdRef.current !== channel.id;
  const viewDraft =
    needsSeed && channel ? draftFromChannel(channel) : draft;
  if (needsSeed && channel) {
    seededChannelIdRef.current = channel.id;
    setDraft(viewDraft);
    setConfirmLeave(false);
    setSaveError(null);
    setIconOpen(false);
  }
  if (!open) {
    seededChannelIdRef.current = null;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) {
      return;
    }
    setSection(openingSection);
  }, [open, channel?.id]);

  useEffect(() => {
    if (!open || !channel || !serverId) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setOverwrites([]);
    setServerMembers([]);
    setChannelMembers([]);

    void Promise.all([
      canManageChannels
        ? fetchChannelMembers(channel.id)
        : Promise.resolve({ members: [] }),
      fetchMembers(serverId),
      canManageRoles
        ? fetchChannelOverwrites(channel.id)
        : Promise.resolve({ overwrites: [] as ChannelOverwrite[] }),
    ])
      .then(([channelRes, serverRes, overwriteRes]) => {
        if (cancelled) {
          return;
        }
        setServerMembers(serverRes.members);
        setChannelMembers(
          hydrateMembers(channelRes.members, serverRes.members),
        );
        setOverwrites(overwriteRes.overwrites);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : t("channelSettings.loadFailed"),
          );
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
  }, [open, channel?.id, serverId, canManageChannels, canManageRoles, t]);

  useEffect(() => {
    if (section !== "permissions" || !scrollTo) {
      return;
    }
    const node = scrollTo === "recipe" ? recipeRef.current : privateRef.current;
    node?.scrollIntoView({ block: "start" });
    setScrollTo(null);
  }, [section, scrollTo]);

  if (!channel) {
    return null;
  }
  const current = channel;

  const dirty = isOverviewDirty(viewDraft, current);
  const everyone = roles.find((role) => role.isEveryone);
  const recipe = readChannelRecipe(overwrites, everyone?.id, current.type);
  const recipeRoleNames = roles
    .filter((role) => recipe.roleIds.includes(role.id))
    .map((role) => role.name);

  const sections: SectionRailItem<ChannelSettingsSectionId>[] = [];
  if (canSeeOverview) {
    sections.push({
      id: "overview",
      label: t("channelSettings.section.overview"),
      icon: ImageIcon,
      dirty,
    });
  }
  if (canSeePermissions) {
    sections.push({
      id: "permissions",
      label: t("channelSettings.section.permissions"),
      icon: Shield,
    });
  }
  if (canSeeWebhooks) {
    sections.push({
      id: "webhooks",
      label: t("channelSettings.section.webhooks"),
      icon: Webhook,
    });
  }

  const active =
    sections.find((row) => row.id === section) ?? sections[0] ?? null;

  function requestClose() {
    if (dirty && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    onClose();
  }

  function discardDraft() {
    setDraft(draftFromChannel(current));
    setSaveError(null);
    setConfirmLeave(false);
    setIconOpen(false);
  }

  async function saveOverview() {
    const name = draft.name.trim();
    if (!name) {
      setSaveError(t("channelSettings.nameEmpty"));
      return;
    }
    const iconError = validateChannelIconInput(draft.imageUrl);
    if (iconError) {
      setSaveError(t(iconError));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { channel: updated } = await updateChannel(current.id, {
        name,
        topic: draft.topic.trim() || null,
        imageUrl: draft.imageUrl.trim() || null,
        ...(current.kind === "server" &&
        (current.type === "text" || current.type === "voice")
          ? { slowmodeSeconds: draft.slowmodeSeconds }
          : {}),
        ...(showsVoiceRoomSize(current)
          ? { voiceTransport: fromVoiceRoomSizeOption(draft.voiceRoomSize) }
          : {}),
      });
      onChannelUpdated(updated);
      setDraft(draftFromChannel(updated));
      setConfirmLeave(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("channelSettings.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handlePrivateChange(next: boolean) {
    setPrivateBusy(true);
    try {
      const { channel: updated } = await updateChannel(current.id, {
        isPrivate: next,
      });
      onChannelUpdated(updated);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("channelSettings.saveFailed"),
      );
    } finally {
      setPrivateBusy(false);
    }
  }

  async function reloadOverwrites(): Promise<ChannelOverwrite[]> {
    const res = await fetchChannelOverwrites(current.id);
    setOverwrites(res.overwrites);
    return res.overwrites;
  }

  function jump(target: "recipe" | "private") {
    setSection("permissions");
    setScrollTo(target);
  }

  const eyebrowKey: MessageKey =
    current.type === "voice"
      ? "channelMeta.kind.voice"
      : "channelMeta.kind.text";

  const footer = confirmLeave ? (
    <>
      <p className="mr-auto min-w-0 text-sm text-paper-muted">
        {t("channelSettings.leaveTitle")}
      </p>
      <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Button variant="ghost" className="min-w-0" onClick={() => setConfirmLeave(false)}>
          {t("channelSettings.leaveStay")}
        </Button>
        <Button
          variant="danger"
          className="min-w-0"
          onClick={() => {
            discardDraft();
            onClose();
          }}
        >
          {t("channelSettings.leaveDiscard")}
        </Button>
      </div>
    </>
  ) : dirty ? (
    <>
      <p className="mr-auto min-w-0 animate-fade-in text-sm text-paper-muted">
        {t("channelSettings.unsaved")}
      </p>
      <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Button variant="ghost" className="min-w-0" onClick={discardDraft}>
          {t("channelSettings.discard")}
        </Button>
        <Button
          className="min-w-0"
          disabled={saving}
          onClick={() => void saveOverview()}
        >
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </>
  ) : (
    <Button variant="secondary" onClick={onClose}>
      {t("common.close")}
    </Button>
  );

  return (
    <Dialog
      open={open}
      eyebrow={t(eyebrowKey)}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ChannelIcon channel={channel} className="h-5 w-5 shrink-0" />
          <span className="truncate">{channel.name}</span>
        </span>
      }
      size="xl"
      fill
      closeOnBackdrop={!dirty}
      onClose={requestClose}
      footer={footer}
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <SectionRail
          sections={sections}
          active={active?.id ?? firstSection}
          onSelect={(id) => {
            setConfirmLeave(false);
            setSection(id);
          }}
          idFor={(id) => `${tabIdPrefix}-${id}`}
          panelId={panelId}
          label={t("channelSettings.nav")}
        />
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${tabIdPrefix}-${active?.id ?? firstSection}`}
          tabIndex={0}
          className="min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5 focus-visible:outline-none"
        >
          {loadError && (
            <p className="text-sm text-danger" role="alert">
              {loadError}
            </p>
          )}
          {saveError && (
            <p className="text-sm text-danger" role="alert">
              {saveError}
            </p>
          )}
          {loading && (
            <p className="text-sm text-paper-muted">{t("common.loading")}</p>
          )}
          {active?.id === "overview" && (
            <ChannelOverviewSection
              channel={channel}
              draft={viewDraft}
              onDraftChange={(next) => {
                setConfirmLeave(false);
                setDraft(next);
              }}
              iconOpen={iconOpen}
              onIconOpenChange={setIconOpen}
              showPrivateBridge={canSeePermissions}
              showRecipeBridge={canManageRoles}
              isPrivate={channel.isPrivate}
              recipeKind={recipe.kind}
              recipeRoleNames={recipeRoleNames}
              onJumpPrivate={() => jump("private")}
              onJumpRecipe={() => jump("recipe")}
            />
          )}
          {active?.id === "permissions" && (
            <ChannelPermissionsSection
              channelId={channel.id}
              channelType={channel.type}
              isPrivate={channel.isPrivate}
              roles={roles}
              overwrites={overwrites}
              onOverwritesChange={setOverwrites}
              reloadOverwrites={reloadOverwrites}
              serverMembers={serverMembers}
              channelMembers={channelMembers}
              onChannelMembersChange={setChannelMembers}
              canManageRoles={canManageRoles}
              canManageAccess={canManageChannels}
              forceAdvancedOpen={forceAdvanced}
              recipeRef={(node) => {
                recipeRef.current = node;
              }}
              privateRef={(node) => {
                privateRef.current = node;
              }}
              onPrivateChange={handlePrivateChange}
              privateBusy={privateBusy}
            />
          )}
          {active?.id === "webhooks" && (
            <WebhooksSection
              open={open && section === "webhooks"}
              channelId={channel.id}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}
