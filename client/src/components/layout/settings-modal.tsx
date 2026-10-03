import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, Bell, Bug, CircleHelp, Database, Keyboard, Mic, Palette, ShieldCheck, Siren, UserRound, type LucideIcon } from "lucide-react";
import { type BlockedUser, type User } from "@pqp/shared";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SectionRail } from "@/components/ui/section-rail";
import { UserAvatar } from "@/components/user/user-avatar";
import { ConnectionsSection } from "@/components/connections/connections-section";
import { ensureCameraPermission, ensureMediaPermission, listAudioDevices, type MediaDeviceOption } from "@/lib/audio-devices";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { isVoiceCleanSettingsSeen, markVoiceCleanSettingsSeen, shouldShowVoiceCleanSettingsBadge } from "@/lib/voice-clean";
import { updateMe } from "@/lib/api";
import { AllReportsSection } from "@/components/layout/all-reports-section";
import { HelpSection } from "@/components/layout/help-section";
import { queuePreferenceSync } from "@/lib/preferences";
import { type FeedbackVoiceContext } from "@/lib/feedback-context";
import { cn } from "@/lib/utils";
import { LocalSettings, preferencesFromLocal, saveLocalSettings } from "@/components/settings/local-settings";
import { VoiceSection } from "@/components/settings/voice-section";
import { KeyboardSection } from "@/components/settings/keyboard-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { PrivacySection } from "@/components/settings/privacy-section";
import { DeleteAccountDialog, YourDataSection } from "@/components/settings/your-data-section";
import { ProfileSection } from "@/components/settings/profile-section";
import { FeedbackSection } from "@/components/settings/feedback-section";
import {
  SettingsBuildLine,
  SettingsPaneHeader,
  SettingsSectionContext,
  SettingsShellContext,
  type SettingsSectionId,
  type SettingsShellValue,
} from "@/components/settings/kit";

export * from "@/components/settings/local-settings";
export { displayMicLevel, sliderToVadThreshold } from "@/components/settings/voice-section";

interface SettingsModalProps {
  open: boolean;
  user: User | null;
  localSettings: LocalSettings;
  /** Live analyser from active voice session, if connected */
  voiceAnalyser?: AnalyserNode | null;
  blockedUsers: BlockedUser[];
  onClose: () => void;
  onLocalSave: (settings: LocalSettings) => void;
  onUserUpdated: (user: User) => void;
  onUnblockUser: (userId: string) => void;
  onAudioSettingsLive?: (settings: LocalSettings) => void;
  /**
   * A section to land on when the dialog opens — the user menu's "send
   * feedback" goes straight to that section. Null keeps the sticky
   * last-visited behaviour the dialog already has.
   */
  requestedSection?: SectionId | null;
  /** Open the shortcut map. Settings stays up; the overlay stacks on top. */
  onShowShortcutOverlay?: () => void;
  /** The call half of a feedback item's context, which only `App` knows. */
  feedbackVoice?: FeedbackVoiceContext | null;
}

/* ------------------------------------------------------------------ layout */

/**
 * The sections, in nav order, in three named groups and a divider.
 *
 * This list is the whole information architecture: settings used to be one
 * column that mixed a display name, a microphone gain slider and the button
 * that deletes your account, and finding anything meant scrolling past
 * everything. The groups say what a section is about: your account (who you
 * are, who can reach you, what we hold about you), the app on this device, and
 * how to reach us.
 *
 * "Your data" is its own section rather than the tail of Profile on purpose:
 * export and deletion are rights the privacy policy promises, and a promise
 * that is only reachable by scrolling to the bottom of the longest page in the
 * app is one nobody finds. As a named door it is more visible than it was.
 */
type SectionId = SettingsSectionId;

/** For callers that open the dialog at a particular section (the user menu). */
export type { SettingsSectionId };

type SectionGroup = "account" | "app" | "support" | "moderation";

const GROUP_LABELS: Record<Exclude<SectionGroup, "moderation">, MessageKey> = {
  account: "settings.nav.group.account",
  app: "settings.nav.group.app",
  support: "settings.nav.group.support",
};

interface SectionDef {
  id: SectionId;
  label: MessageKey;
  description: MessageKey;
  icon: LucideIcon;
  group: SectionGroup;
  /** Drop the 40rem reading width: Moderação's report list wants the room. */
  wide?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    id: "profile",
    label: "settings.section.profile",
    description: "settings.profile.description",
    icon: UserRound,
    group: "account",
  },
  {
    id: "connections",
    label: "settings.section.connections",
    description: "settings.connections.description",
    icon: Gamepad2,
    group: "account",
  },
  {
    id: "privacy",
    label: "settings.section.privacy",
    description: "settings.privacy.description",
    icon: ShieldCheck,
    group: "account",
  },
  {
    id: "data",
    label: "settings.section.data",
    description: "settings.data.description",
    icon: Database,
    group: "account",
  },
  {
    id: "voice",
    label: "settings.section.voice",
    description: "settings.voice.description",
    icon: Mic,
    group: "app",
  },
  {
    id: "notifications",
    label: "settings.section.notifications",
    description: "settings.notifications.description",
    icon: Bell,
    group: "app",
  },
  {
    id: "appearance",
    label: "settings.section.appearance",
    description: "settings.appearance.description",
    icon: Palette,
    group: "app",
  },
  {
    id: "keyboard",
    label: "settings.section.keyboard",
    description: "settings.keyboard.description",
    icon: Keyboard,
    group: "app",
  },
  {
    id: "feedback",
    label: "settings.section.feedback",
    description: "settings.feedback.description",
    icon: Bug,
    group: "support",
  },
  {
    id: "help",
    label: "settings.section.help",
    description: "help.description",
    icon: CircleHelp,
    group: "support",
  },
  // Hidden from the rail unless `canModerateInstance` resolves true — see
  // `visibleSections` where `SettingsModal` filters this out for everyone
  // else. Kept last, after a divider, so the tab order for every existing
  // account never shifts and End still lands on Ajuda e contato for them.
  {
    id: "moderation",
    label: "settings.section.moderation",
    description: "settings.moderation.description",
    icon: Siren,
    group: "moderation",
    wide: true,
  },
];

/**
 * The rail's footer on `sm` and up: who you are signed in as, the way out, and
 * which build this is. The name is the saved account, never the draft, so an
 * unsaved rename does not look applied. Sign out renders nothing under the dev
 * auth bypass (see `SignOutButton`), and the card shows without it.
 */
function RailFooter({ user }: { user: User | null }) {
  return (
    <div className="flex flex-col gap-2">
      {user ? (
        <div className="flex items-center gap-2 pl-2">
          <UserAvatar
            name={user.displayName}
            avatarUrl={user.avatarUrl}
            rounded="full"
            className="h-6 w-6"
            fallbackClassName="bg-accent text-[10px] font-bold text-on-accent"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
            {user.displayName}
          </span>
          <SignOutButton className="h-[var(--control-sm)] shrink-0 px-2 text-xs" />
        </div>
      ) : null}
      <SettingsBuildLine className="self-start" />
    </div>
  );
}

export function SettingsModal({
  open,
  user,
  localSettings,
  voiceAnalyser = null,
  blockedUsers,
  onClose,
  onLocalSave,
  onUserUpdated,
  onUnblockUser,
  onAudioSettingsLive,
  requestedSection = null,
  onShowShortcutOverlay,
  feedbackVoice = null,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [handle, setHandle] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [draftLocal, setDraftLocal] = useState(localSettings);
  // Mirrors `draftLocal` so `patchLocal` can compose off the latest values
  // without doing its work inside a render-phase state updater.
  const draftRef = useRef(draftLocal);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceOption[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceOption[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Which section is showing. Deliberately NOT reset when the dialog closes:
  // somebody adjusting a level, listening, and coming back should land where
  // they were rather than at the top of the tree every time.
  const [section, setSection] = useState<SectionId>("profile");
  const settingsRef = useRef(localSettings);
  // Camera permission is asked once per open Settings session. Tabbing
  // through the Voice form must not blink the webcam LED on every focus.
  const camerasAskedRef = useRef(false);
  // Whether this account is an instance moderator — `user.isInstanceModerator`
  // rides down on every `/api/me`-shaped response (see `toOwnUser` on the
  // server), computed server-side from `INSTANCE_MODERATOR_CLERK_IDS` and
  // nothing the client can influence. This is an AFFORDANCE ONLY: it decides
  // whether the nav shows the door, nothing more. Every route behind it
  // (`GET /api/reports/all`, `PATCH /api/reports/:id`,
  // `POST /api/reports/:id/remove-message`) re-checks `isInstanceModerator`
  // itself and does not trust this flag.
  //
  // Deliberately NOT learned by probing a route that answers 404 for
  // everyone else: firing that probe on every Settings open, for every
  // account, would put a 404 in the network console of the near-totality of
  // people who are not moderators — exactly the console noise
  // `theme-switching.spec.ts`'s "no console errors" check exists to catch.
  const canModerateInstance = user?.isInstanceModerator ?? false;

  // A stale `requestedSection="moderation"` (the dashboard deep link landing
  // on an account the flag says no to) must not strand the dialog on a door
  // that does not exist for it — bounce to the same target ("profile") the
  // rail's own out-of-bounds guard below uses.
  useEffect(() => {
    if (!canModerateInstance && section === "moderation") {
      setSection("profile");
    }
  }, [canModerateInstance, section]);

  // The whole nav, minus the moderation door for every account it did not
  // open for. Derived per render rather than mutating the module-level
  // `SECTIONS` constant, which every other settings dialog instance shares.
  const visibleSections = useMemo(
    () =>
      canModerateInstance
        ? SECTIONS
        : SECTIONS.filter((entry) => entry.id !== "moderation"),
    [canModerateInstance],
  );

  // A caller (or a stale sticky section from a previous session) pointing at
  // "moderation" before the gate resolves true must not show a blank pane —
  // land on Profile instead, exactly like an unknown section id would.
  const active =
    visibleSections.find((entry) => entry.id === section) ??
    visibleSections[0]!;
  const tabIdPrefix = "settings-tab";
  const panelId = "settings-panel";

  // One dialog at a time rather than two stacked ones: `Dialog` installs a
  // focus trap and an Escape handler per instance, and two live traps fight
  // over which one Tab belongs to. Settings steps aside while the confirmation
  // is up and comes back if it is cancelled.
  const settingsOpen = open && !confirmingDelete;
  // The microphone is only opened while the section that shows a level meter is
  // actually on screen. Under the old single column, merely opening settings to
  // change a display name prompted for the mic.
  const voiceVisible = settingsOpen && section === "voice";
  // The NOVO dot on the noise-suppression row: owed until this section has
  // been opened once, or the Voz limpa nudge card was acted on — whichever
  // comes first (`lib/voice-clean.ts`).
  const [showVoiceCleanBadge, setShowVoiceCleanBadge] = useState(() =>
    shouldShowVoiceCleanSettingsBadge({
      settingsSeen: isVoiceCleanSettingsSeen(),
      nudgeDismissed: Boolean(user?.preferences?.voiceCleanNudgeDismissedAt),
    }),
  );
  useEffect(() => {
    if (voiceVisible) {
      markVoiceCleanSettingsSeen();
      setShowVoiceCleanBadge(false);
    }
  }, [voiceVisible]);
  useEffect(() => {
    if (user?.preferences?.voiceCleanNudgeDismissedAt) {
      setShowVoiceCleanBadge(false);
    }
  }, [user?.preferences?.voiceCleanNudgeDismissedAt]);

  useEffect(() => {
    if (!open) {
      setConfirmingDelete(false);
      camerasAskedRef.current = false;
    }
  }, [open]);

  // A caller that asked for a particular section wins over the sticky
  // last-visited one — but only while it is asking; the gear passes null and
  // keeps the old behaviour.
  useEffect(() => {
    if (open && requestedSection) {
      setSection(requestedSection);
    }
  }, [open, requestedSection]);

  useEffect(() => {
    settingsRef.current = localSettings;
  }, [localSettings]);

  useEffect(() => {
    if (open && user) {
      setDisplayName(user.displayName);
      setUsername(user.username ?? "");
      setHandle(user.handle ?? "");
      setAvatarUrl(user.avatarUrl ?? "");
    }
  }, [open, user]);

  // Seeded from a ref so live audio edits, which flow back in as a new
  // `localSettings` prop, do not restart the draft mid-session.
  useEffect(() => {
    if (open) {
      setDraftLocal(settingsRef.current);
      draftRef.current = settingsRef.current;
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!voiceVisible) {
      return;
    }

    let cancelled = false;

    async function loadDevices() {
      setDevicesError(null);
      const granted = await ensureMediaPermission();
      if (!granted) {
        if (!cancelled) {
          setDevicesError(t("settings.voice.permissionNeeded"));
        }
        return;
      }
      const { inputs: nextInputs, outputs: nextOutputs, cameras: nextCameras } =
        await listAudioDevices();
      if (cancelled) {
        return;
      }
      setInputs(nextInputs);
      setOutputs(nextOutputs);
      setCameras(nextCameras);
    }

    void loadDevices();

    function onDeviceChange() {
      void loadDevices();
    }
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      );
    };
    // `t` is stable per locale and the locale cannot change without a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceVisible]);

  async function revealCameras() {
    // Labels stay blank until the browser has seen a video permission.
    // Asked on focus of the camera select, not when Voice opens, so a
    // volume tweak does not light the webcam. Once per open session:
    // every Tab through this select used to open a second capture.
    if (camerasAskedRef.current) {
      return;
    }
    camerasAskedRef.current = true;
    const granted = await ensureCameraPermission();
    if (!granted) {
      camerasAskedRef.current = false;
    }
    const { cameras: nextCameras } = await listAudioDevices();
    setCameras(nextCameras);
  }

  function patchLocal(partial: Partial<LocalSettings>) {
    // Composed off a ref rather than inside a `setDraftLocal` updater.
    //
    // `onAudioSettingsLive` reaches back into the app and sets state there, and
    // a state updater runs *during render* — React warns about exactly this
    // ("cannot update a component while rendering a different component"), and
    // it stopped being merely untidy once the callback grew a `getUserMedia`
    // on it: an updater that React re-runs would re-open the microphone. The
    // ref is what lets two patches in one tick still compose.
    const next = { ...draftRef.current, ...partial };
    draftRef.current = next;
    setDraftLocal(next);
    onAudioSettingsLive?.(next);
    // These already apply and persist locally as they are edited rather than on
    // Save, so the account copy follows the same moment. Device-only changes
    // queue nothing, and a slider drag coalesces into one request.
    queuePreferenceSync(preferencesFromLocal(partial));
  }

  async function handleSave() {
    // Checked before anything is saved. A blank name used to be dropped from
    // the request, so the dialog closed as if it had worked and kept the old
    // name. Device settings are not written either: a Save that fails should
    // leave nothing half applied.
    if (user && displayName.trim() === "") {
      setSection("profile");
      setError(t("settings.profile.displayNameRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onLocalSave(draftLocal);
      saveLocalSettings(draftLocal);
      if (user) {
        const updated = await updateMe({
          // Only when it changed. An account whose name predates the limit
          // would otherwise fail every save of an unrelated field.
          displayName:
            displayName.trim() !== user.displayName
              ? displayName.trim()
              : undefined,
          username: username.trim() || undefined,
          avatarUrl: avatarUrl.trim() || null,
          // Omitted rather than sent empty when the field is blank. An absent
          // key means "leave it alone"; there is deliberately no way to
          // RELEASE a handle from this form, because releasing one hands
          // somebody else a URL that is already in a hundred screenshots.
          ...(handle ? { handle } : {}),
        });
        onUserUpdated(updated);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // The pane is the only scroller. A section always opens at its top: the
  // pane used to keep the previous section's offset, so Voz opened 136px down
  // because Perfil had been scrolled 100px.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = 0;
    }
  }, [section]);

  // `openSection(section, rowId)`: switch, then find the row once the tab has
  // rendered it, bring it to the middle of the pane and flash it once. Tabs
  // that load their rows asynchronously get a second until the row shows.
  const [pendingRow, setPendingRow] = useState<{ id: string; nonce: number } | null>(null);
  const openSection = useCallback((next: SectionId, rowId?: string) => {
    setSection(next);
    setPendingRow(rowId ? { id: rowId, nonce: Date.now() } : null);
  }, []);
  useEffect(() => {
    if (!pendingRow) {
      return;
    }
    const FLASH = ["bg-accent-soft", "transition-colors", "duration-[var(--duration-base)]"];
    let attempts = 0;
    let retry: number | undefined;
    let clear: number | undefined;
    let flashed: HTMLElement | null = null;
    const find = () => {
      const row = scrollerRef.current?.querySelector<HTMLElement>(
        `[data-settings-row="${CSS.escape(pendingRow.id)}"]`,
      );
      if (!row) {
        if (++attempts < 20) {
          retry = window.setTimeout(find, 50);
        }
        return;
      }
      row.scrollIntoView?.({ block: "center" });
      row.classList.add(...FLASH);
      flashed = row;
      clear = window.setTimeout(() => row.classList.remove(...FLASH), 1000);
    };
    find();
    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(clear);
      flashed?.classList.remove(...FLASH);
    };
  }, [pendingRow]);

  // Where a tab's `SettingsHeaderActions` land. State, not a ref, so the
  // context updates once the header has mounted.
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLDivElement | null>(null);

  const shell = useMemo<SettingsShellValue>(
    () => ({ profileDirty: false, openSection, headerActionsSlot }),
    [openSection, headerActionsSlot],
  );

  const railItems = visibleSections.map((entry) => ({
    id: entry.id,
    label: t(entry.label),
    icon: entry.icon,
    group: entry.group,
  }));
  const groupLabels = {
    account: t(GROUP_LABELS.account),
    app: t(GROUP_LABELS.app),
    support: t(GROUP_LABELS.support),
  };

  return (
    <>
      <Dialog
        open={settingsOpen}
        title={t("settings.title")}
        size="xl"
        fill
        // 56px: the band only names the dialog, the pane title names the page.
        headerClassName="h-14 shrink-0 items-center py-0 [&_h2]:text-lg"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? t("settings.saving") : t("settings.save")}
            </Button>
          </>
        }
      >
        <SettingsShellContext.Provider value={shell}>
          <div className="flex h-full min-h-0 flex-col sm:flex-row">
            <SectionRail
              sections={railItems}
              active={active.id}
              onSelect={setSection}
              idFor={(id) => `${tabIdPrefix}-${id}`}
              panelId={panelId}
              label={t("settings.nav.label")}
              groupLabels={groupLabels}
              footer={<RailFooter user={user} />}
              className="h-14 sm:h-auto sm:w-60"
              fadeEnd
            />

            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-1">
              <div
                ref={scrollerRef}
                id={panelId}
                role="tabpanel"
                aria-labelledby={`${tabIdPrefix}-${active.id}`}
                tabIndex={0}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none"
              >
                <div
                  className={cn(
                    "@container mx-auto w-full px-4 py-5 sm:px-8 sm:py-8",
                    active.wide ? "max-w-none" : "max-w-[40rem]",
                  )}
                >
                  <SettingsPaneHeader
                    title={t(active.label)}
                    description={t(active.description)}
                    actionsRef={setHeaderActionsSlot}
                  />

                  <SettingsSectionContext.Provider value={active.id}>
                    <div className="space-y-6">
                      {section === "profile" && (
                        <ProfileSection
                          user={user}
                          displayName={displayName}
                          onDisplayName={setDisplayName}
                          username={username}
                          onUsername={setUsername}
                          handle={handle}
                          onHandle={setHandle}
                          avatarUrl={avatarUrl}
                          onAvatarUrl={setAvatarUrl}
                          onUserUpdated={onUserUpdated}
                        />
                      )}

                      {section === "connections" && <ConnectionsSection />}

                      {section === "voice" && (
                        <VoiceSection
                          draftLocal={draftLocal}
                          patchLocal={patchLocal}
                          inputs={inputs}
                          outputs={outputs}
                          cameras={cameras}
                          onRevealCameras={() => {
                            void revealCameras();
                          }}
                          devicesError={devicesError}
                          voiceAnalyser={voiceAnalyser}
                          metering={voiceVisible}
                          showVoiceCleanBadge={showVoiceCleanBadge}
                        />
                      )}

                      {section === "keyboard" && (
                        <KeyboardSection
                          draftLocal={draftLocal}
                          patchLocal={patchLocal}
                          onShowOverlay={() => onShowShortcutOverlay?.()}
                        />
                      )}

                      {section === "notifications" && <NotificationsSection />}

                      {section === "appearance" && (
                        <AppearanceSection
                          showLinkEmbeds={draftLocal.showLinkEmbeds}
                          onShowLinkEmbeds={(showLinkEmbeds) =>
                            patchLocal({ showLinkEmbeds })
                          }
                        />
                      )}

                      {section === "privacy" && (
                        <PrivacySection
                          user={user}
                          blockedUsers={blockedUsers}
                          onUserUpdated={onUserUpdated}
                          onUnblockUser={onUnblockUser}
                        />
                      )}

                      {section === "data" && (
                        <YourDataSection
                          user={user}
                          onRequestDelete={() => setConfirmingDelete(true)}
                        />
                      )}

                      {section === "feedback" && <FeedbackSection voice={feedbackVoice} />}

                      {section === "help" && (
                        <HelpSection onOpenFeedback={() => openSection("feedback")} />
                      )}

                      {section === "moderation" &&
                        (canModerateInstance ? (
                          <AllReportsSection />
                        ) : (
                          // Only reachable for the one render before the effect above
                          // bounces off this section — a deep link can land here before
                          // React has run its effects. The nav entry itself never
                          // exists for an account the flag says no to.
                          <p role="status" aria-live="polite" className="text-sm text-text-tertiary">
                            {t("common.loading")}
                          </p>
                        ))}

                      {error && (
                        <p className="mt-4 text-sm text-danger" role="alert">
                          {error}
                        </p>
                      )}
                    </div>
                  </SettingsSectionContext.Provider>
                </div>
              </div>
            </div>
          </div>
        </SettingsShellContext.Provider>
      </Dialog>

      <DeleteAccountDialog
        open={open && confirmingDelete}
        user={user}
        onCancel={() => setConfirmingDelete(false)}
        // A full reload rather than a Clerk `signOut()` call: `ClerkProvider`
        // is not mounted at all under the dev auth bypass, so a Clerk hook here
        // would throw in local development. Reloading works in both modes — the
        // identity is gone at Clerk, so the session cannot be re-established and
        // the app boots signed out.
        onDeleted={() => window.location.replace("/")}
      />
    </>
  );
}
