import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Shield, Tag, Webhook } from "lucide-react";
import type { Channel, ForumSettings, ForumSort } from "@pqp/shared";
import { FORUM_SETTINGS_DEFAULTS, isVoiceRoomChannelType } from "@pqp/shared";
import { ForumTagsSection } from "@/components/layout/forum-tags-section";
import {
  draftFromServer,
  tagsChanged,
  toPutBody,
  unsavedChangeCount,
  draftProblems,
  type TagDraft,
} from "@/lib/forum-tag-draft";
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
  fetchForumSettings,
  fetchForumTags,
  fetchMembers,
  putForumTags,
  updateChannel,
  updateForumSettings,
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
  | "tags"
  | "permissions"
  | "webhooks";

const EMPTY_TAG_DRAFT: TagDraft = { rows: [], requireTag: false };

/**
 * What a forum's settings need beside the channel row: its tags and its two
 * switches (`forum_settings`). Loaded when the sheet opens on a forum. An API
 * that predates forum PR 1 answers 404 here, which is "error" with a retry:
 * the rest of the sheet (name, guidelines, permissions) works regardless.
 */
interface ForumSettingsState {
  status: "idle" | "loading" | "ready" | "error";
  settings: ForumSettings;
  baseline: TagDraft;
}

const FORUM_IDLE: ForumSettingsState = {
  status: "idle",
  settings: FORUM_SETTINGS_DEFAULTS,
  baseline: EMPTY_TAG_DRAFT,
};

function draftFromChannel(
  channel: Channel,
  defaultSort: ForumSort = FORUM_SETTINGS_DEFAULTS.defaultSort,
): ChannelOverviewDraft {
  return {
    name: channel.name,
    topic: channel.topic ?? "",
    imageUrl: channel.imageUrl ?? "",
    slowmodeSeconds: channel.slowmodeSeconds ?? 0,
    voiceRoomSize: toVoiceRoomSizeOption(channel.voiceTransport),
    defaultSort,
  };
}

function isOverviewDirty(
  draft: ChannelOverviewDraft,
  channel: Channel,
  defaultSort: ForumSort,
): boolean {
  const baseline = draftFromChannel(channel, defaultSort);
  return (
    draft.name.trim() !== baseline.name.trim() ||
    draft.topic.trim() !== baseline.topic.trim() ||
    draft.imageUrl.trim() !== baseline.imageUrl.trim() ||
    draft.slowmodeSeconds !== baseline.slowmodeSeconds ||
    draft.voiceRoomSize !== baseline.voiceRoomSize ||
    (channel.type === "forum" && draft.defaultSort !== baseline.defaultSort)
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
    defaultSort: FORUM_SETTINGS_DEFAULTS.defaultSort,
  });
  // --- forums ---
  const [forum, setForum] = useState<ForumSettingsState>(FORUM_IDLE);
  const [tagDraft, setTagDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT);
  const [forumLoadNonce, setForumLoadNonce] = useState(0);
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

  const isForum = channel?.type === "forum";
  const canSeeOverview = canManageChannels;
  const canSeeTags = canManageChannels && isForum;
  const canSeePermissions = canManageRoles || canManageChannels;
  // A forum takes webhooks too: an RSS or a release feed posting one post per
  // item is half of what a forum is for (forum PR 4 teaches the execute path
  // to make posts; until then the section lists and creates them as usual).
  const canSeeWebhooks =
    canManageChannels && (channel?.type === "text" || isForum);

  const visible = useMemo(() => {
    const ids: ChannelSettingsSectionId[] = [];
    if (canSeeOverview) {
      ids.push("overview");
    }
    if (canSeeTags) {
      ids.push("tags");
    }
    if (canSeePermissions) {
      ids.push("permissions");
    }
    if (canSeeWebhooks) {
      ids.push("webhooks");
    }
    return ids;
  }, [canSeeOverview, canSeeTags, canSeePermissions, canSeeWebhooks]);

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
    setForum(FORUM_IDLE);
    setTagDraft(EMPTY_TAG_DRAFT);
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

  // --- forums --- tags and the two switches, read once per opening (and on
  // "Tentar de novo"), and only for someone who can change them: the Tags
  // section and the default sort are MANAGE_CHANNELS, and a sheet opened
  // for permissions alone has no use for either.
  const forumChannelId =
    open && isForum && canManageChannels ? (channel?.id ?? null) : null;
  useEffect(() => {
    if (!forumChannelId) {
      return;
    }
    let cancelled = false;
    setForum((previous) => ({ ...previous, status: "loading" }));
    void Promise.all([fetchForumTags(forumChannelId), fetchForumSettings(forumChannelId)])
      .then(([{ tags }, { settings }]) => {
        if (cancelled) {
          return;
        }
        const baseline = draftFromServer(tags, settings.requireTag);
        setForum({ status: "ready", settings, baseline });
        setTagDraft(baseline);
        // The overview draft was seeded before this landed; give it the
        // forum's real default sort unless the person already picked one.
        setDraft((previous) =>
          previous.defaultSort === FORUM_SETTINGS_DEFAULTS.defaultSort
            ? { ...previous, defaultSort: settings.defaultSort }
            : previous,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setForum((previous) => ({ ...previous, status: "error" }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [forumChannelId, forumLoadNonce]);
  const retryForumLoad = useCallback(() => setForumLoadNonce((n) => n + 1), []);

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

  const overviewDirty = isOverviewDirty(
    viewDraft,
    current,
    forum.settings.defaultSort,
  );
  const tagChangeCount =
    current.type === "forum" && forum.status === "ready"
      ? unsavedChangeCount(forum.baseline, tagDraft)
      : 0;
  const tagsDirty = tagChangeCount > 0;
  const dirty = overviewDirty || tagsDirty;
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
      dirty: overviewDirty,
    });
  }
  if (canSeeTags) {
    sections.push({
      id: "tags",
      label: t("forum.settings.tags"),
      icon: Tag,
      dirty: tagsDirty,
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
    setDraft(draftFromChannel(current, forum.settings.defaultSort));
    setSaveError(null);
    setConfirmLeave(false);
    setIconOpen(false);
  }

  function discardTags() {
    setTagDraft(forum.baseline);
    setSaveError(null);
    setConfirmLeave(false);
  }

  /**
   * One PUT for the tag list (only when it changed) and one PATCH for the
   * switch (only when it changed), in that order: a list the server refuses
   * must not leave "Exigir pelo menos uma tag" on over a forum with no tags.
   */
  async function saveTags() {
    if (draftProblems(tagDraft).size > 0) {
      setSaveError(t("forum.settings.fixRows"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    // Each write is folded into the sheet as soon as it lands, so a switch
    // that fails after the list saved leaves only the switch unsaved, and
    // "Salvar" again sends only the switch.
    //
    // An edit made while a write is out is the person's newest word: the
    // saved state replaces the draft only if the draft is still the one that
    // was sent, otherwise the edit stays and counts against the new baseline.
    let baseline = forum.baseline;
    let sent = tagDraft;
    const wantsRequireTag = tagDraft.requireTag;
    try {
      if (tagsChanged(baseline, tagDraft)) {
        const { tags } = await putForumTags(current.id, toPutBody(tagDraft));
        baseline = draftFromServer(tags, baseline.requireTag);
        const saved = baseline;
        const next = { ...saved, requireTag: wantsRequireTag };
        const expected = sent;
        setForum((previous) => ({ ...previous, status: "ready", baseline: saved }));
        setTagDraft((draftNow) => (draftNow === expected ? next : draftNow));
        sent = next;
      }
      if (wantsRequireTag !== baseline.requireTag) {
        const { settings } = await updateForumSettings(current.id, {
          requireTag: wantsRequireTag,
        });
        baseline = { ...baseline, requireTag: settings.requireTag };
        const saved = baseline;
        const expected = sent;
        setForum({ status: "ready", settings, baseline: saved });
        setTagDraft((draftNow) => (draftNow === expected ? saved : draftNow));
      }
      setConfirmLeave(false);
    } catch {
      setSaveError(t("forum.saveFailed"));
    } finally {
      setSaving(false);
    }
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
    // Two writes, each reconciled the moment it lands: the channel row first,
    // then (a forum only) the default sort. A sort that fails after the row
    // saved leaves only the sort unsaved, never a saved name the sheet still
    // calls unsaved, which a "Desfazer" would then appear to undo.
    const sortChanged =
      current.type === "forum" &&
      forum.status === "ready" &&
      draft.defaultSort !== forum.settings.defaultSort;
    const channelChanged = isOverviewDirty(
      { ...draft, defaultSort: forum.settings.defaultSort },
      current,
      forum.settings.defaultSort,
    );
    let channel = current;
    let sent = draft;
    try {
      if (channelChanged) {
        ({ channel } = await updateChannel(current.id, {
          // Only a changed name is sent. A channel copied from a Discord
          // template can carry a name the rename rules never allowed, and
          // resending it would refuse a save that only touched the topic.
          ...(name !== current.name ? { name } : {}),
          topic: draft.topic.trim() || null,
          imageUrl: draft.imageUrl.trim() || null,
          ...(current.kind === "server" &&
          (current.type === "text" ||
            current.type === "forum" ||
            isVoiceRoomChannelType(current.type))
            ? { slowmodeSeconds: draft.slowmodeSeconds }
            : {}),
          ...(showsVoiceRoomSize(current)
            ? { voiceTransport: fromVoiceRoomSizeOption(draft.voiceRoomSize) }
            : {}),
        }));
        onChannelUpdated(channel);
        // The sort the person picked stays in the draft until it is saved
        // too, and an edit typed while this was out is never overwritten.
        const next = draftFromChannel(channel, draft.defaultSort);
        const expected = sent;
        setDraft((draftNow) => (draftNow === expected ? next : draftNow));
        sent = next;
      }
      if (sortChanged) {
        const { settings } = await updateForumSettings(current.id, {
          defaultSort: draft.defaultSort,
        });
        setForum((previous) => ({ ...previous, settings }));
        const next = draftFromChannel(channel, settings.defaultSort);
        const expected = sent;
        setDraft((draftNow) => (draftNow === expected ? next : draftNow));
      }
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
      : current.type === "forum"
        ? "channel.type.forum"
        : "channelMeta.kind.text";

  // The Tags section saves on its own footer; so does the overview. Whichever
  // is on screen and has changes owns the bar, and the other one's changes
  // still hold the sheet open (`dirty` above) so nothing is lost on Escape.
  const tagsFooter =
    tagsDirty && (active?.id === "tags" || !overviewDirty);

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
            discardTags();
            onClose();
          }}
        >
          {t("channelSettings.leaveDiscard")}
        </Button>
      </div>
    </>
  ) : tagsFooter ? (
    <>
      <p
        className="mr-auto min-w-0 animate-fade-in text-sm text-text-tertiary"
        aria-live="polite"
        data-forum-tags-unsaved=""
      >
        {t("forum.settings.unsaved", { count: tagChangeCount })}
      </p>
      <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Button variant="ghost" className="min-w-0" onClick={discardTags}>
          {t("channelSettings.discard")}
        </Button>
        <Button
          className="min-w-0"
          disabled={saving}
          onClick={() => void saveTags()}
        >
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </>
  ) : overviewDirty ? (
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
              forumSettingsReady={forum.status === "ready"}
              showPrivateBridge={canSeePermissions}
              showRecipeBridge={canManageRoles}
              isPrivate={channel.isPrivate}
              recipeKind={recipe.kind}
              recipeRoleNames={recipeRoleNames}
              onJumpPrivate={() => jump("private")}
              onJumpRecipe={() => jump("recipe")}
            />
          )}
          {active?.id === "tags" && (
            <ForumTagsSection
              channelName={channel.name}
              draft={tagDraft}
              onDraftChange={(next) => {
                setConfirmLeave(false);
                setSaveError(null);
                setTagDraft(next);
              }}
              status={
                forum.status === "ready"
                  ? "ready"
                  : forum.status === "error"
                    ? "error"
                    : "loading"
              }
              onRetry={retryForumLoad}
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
