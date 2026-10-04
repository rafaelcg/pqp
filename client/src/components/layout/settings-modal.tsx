import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, Bell, Bug, CircleHelp, Database, Keyboard, Mic, Palette, ShieldCheck, Siren, UserRound, type LucideIcon } from "lucide-react";
import { type BlockedUser, type User } from "@pqp/shared";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { SectionRail } from "@/components/ui/section-rail";
import { UserAvatar } from "@/components/user/user-avatar";
import { ConnectionsSection } from "@/components/connections/connections-section";
import { ensureCameraPermission, ensureMediaPermission, listAudioDevices, type MediaDeviceOption } from "@/lib/audio-devices";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { isVoiceCleanSettingsSeen, markVoiceCleanSettingsSeen, shouldShowVoiceCleanSettingsBadge } from "@/lib/voice-clean";
import { updateMe } from "@/lib/api";
import { isApplePlatform } from "@/lib/composer-formatting";
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
  buildProfilePatch,
  isHandleTakenError,
  isProfileDirty,
  pendingHandleChange,
  profileDraftsFrom,
  type ProfileDrafts,
} from "@/components/settings/profile-patch";
import { flashSettingsRow } from "@/components/settings/kit/flash-row";
import {
  SettingsBuildLine,
  SettingsPaneHeader,
  SettingsSectionContext,
  SettingsShellContext,
  UnsavedChangesBar,
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

const EMPTY_DRAFTS: ProfileDrafts = {
  displayName: "",
  username: "",
  handle: "",
  avatarUrl: "",
};

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
  // The profile is the only staged state in Settings (spec section C). The
  // four drafts are seeded once per open and never again from `user` while
  // the dialog is up: an avatar upload, a banner or a DM privacy change all
  // hand a new `user` down mid-edit, and reseeding then silently threw away a
  // half-typed display name.
  const [drafts, setDrafts] = useState<ProfileDrafts>(EMPTY_DRAFTS);
  const seededRef = useRef(false);
  const [draftLocal, setDraftLocal] = useState(localSettings);
  // Mirrors `draftLocal` so `patchLocal` can compose off the latest values
  // without doing its work inside a render-phase state updater.
  const draftRef = useRef(draftLocal);
  const [saving, setSaving] = useState(false);
  // "Salvo" in the bar for a moment after a save, then the bar goes.
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // The public link is somebody else's: said under the link field in Perfil
  // (through the shell context) and in the bar, in the reader's language.
  const [handleError, setHandleError] = useState<string | null>(null);
  // A close was refused while the profile was dirty.
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [focusSaveNonce, setFocusSaveNonce] = useState(0);
  // The 30-day handle lock asks before a save claims or changes the link.
  const [handleConfirm, setHandleConfirm] = useState<"claim" | "change" | null>(null);
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

  // Seeded on the open transition only, or the first moment an account is
  // there to seed from. Reset on close so the next open starts clean.
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (user && !seededRef.current) {
      seededRef.current = true;
      setDrafts(profileDraftsFrom(user));
      setSaveError(null);
      setNameError(null);
      setHandleError(null);
      setCloseBlocked(false);
      setSavedFlash(false);
    }
  }, [open, user]);

  const profileDirty = isProfileDirty(user, drafts);

  // Back to clean by any route (Descartar, a save, retyping the old value):
  // nothing is blocking a close any more.
  useEffect(() => {
    if (!profileDirty) {
      setCloseBlocked(false);
      setSaveError(null);
      setHandleError(null);
    }
  }, [profileDirty]);

  useEffect(() => {
    if (!savedFlash) return;
    const timer = window.setTimeout(() => setSavedFlash(false), 1500);
    return () => window.clearTimeout(timer);
  }, [savedFlash]);

  // Seeded from a ref so live audio edits, which flow back in as a new
  // `localSettings` prop, do not restart the draft mid-session.
  useEffect(() => {
    if (open) {
      setDraftLocal(settingsRef.current);
      draftRef.current = settingsRef.current;
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
    if (onAudioSettingsLive) {
      onAudioSettingsLive(next);
    } else {
      // Nothing upstream is listening live (a test mounts the dialog bare),
      // so persist here. Save used to do this; there is no Save now.
      onLocalSave(next);
      saveLocalSettings(next);
    }
    // These already apply and persist locally as they are edited rather than on
    // Save, so the account copy follows the same moment. Device-only changes
    // queue nothing, and a slider drag coalesces into one request.
    queuePreferenceSync(preferencesFromLocal(partial));
  }

  function setDraft<K extends keyof ProfileDrafts>(key: K, value: ProfileDrafts[K]) {
    setDrafts((current) => ({ ...current, [key]: value }));
    if (key === "displayName" && value.trim() !== "") {
      setNameError(null);
    }
    if (key === "handle") {
      setHandleError(null);
    }
  }

  function discardProfile() {
    if (user) {
      setDrafts(profileDraftsFrom(user));
    }
    setSaveError(null);
    setNameError(null);
    setHandleError(null);
    setCloseBlocked(false);
  }

  /**
   * "Salvar alterações", Cmd/Ctrl+S and the handle confirm all end here. It
   * saves the profile and nothing else (`LocalSettings` persisted as it was
   * edited), and it does not close the dialog.
   */
  async function commitProfile() {
    if (!user) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setHandleError(null);
    const patch = buildProfilePatch(user, drafts);
    try {
      const updated = await updateMe(patch);
      onUserUpdated(updated);
      // The one reseed while open: the server may have normalised what was
      // sent (a regenerated tag number), and the bar must read clean.
      setDrafts(profileDraftsFrom(updated));
      setSavedFlash(true);
    } catch (err) {
      if (isHandleTakenError(err, patch)) {
        // Never the server's English sentence for this one: it is the one
        // failure a person fixes by typing, so it is said where they type.
        const message = t("settings.unsaved.handle.taken");
        setSection("profile");
        setHandleError(message);
        setSaveError(message);
      } else {
        setSaveError(err instanceof Error ? err.message : t("settings.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  }

  function saveProfile() {
    if (!user || saving || !profileDirty) {
      return;
    }
    // Checked before anything is sent. A blank name used to be dropped from
    // the request, so the save looked like it worked and kept the old name.
    if (drafts.displayName.trim() === "") {
      const message = t("settings.profile.displayNameRequired");
      setSection("profile");
      setSaveError(message);
      setNameError(message);
      return;
    }
    const handleChange = pendingHandleChange(user, drafts);
    if (handleChange) {
      setHandleConfirm(handleChange);
      return;
    }
    void commitProfile();
  }

  /**
   * Escape, the X and the backdrop all come here. With staged profile edits
   * the dialog does not close: it goes to Perfil, the bar says to save or
   * discard, and focus lands on Salvar alterações. Every attempt does the same.
   */
  function requestClose() {
    if (profileDirty) {
      setSection("profile");
      setCloseBlocked(true);
      setFocusSaveNonce((n) => n + 1);
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (focusSaveNonce === 0) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>("[data-unsaved-save]")?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusSaveNonce]);

  // Cmd+S on Apple platforms, Ctrl+S elsewhere: the same path as the button,
  // handle confirm included. Swallowed while Settings is the top dialog even
  // with nothing staged, so the browser's "save page" never opens over it.
  // Read through a ref so the listener is not re-added on every keystroke.
  const saveProfileRef = useRef(saveProfile);
  saveProfileRef.current = saveProfile;
  useEffect(() => {
    if (!settingsOpen || handleConfirm) {
      return;
    }
    const apple = isApplePlatform();
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const chord = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!chord || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") {
        return;
      }
      event.preventDefault();
      saveProfileRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, handleConfirm]);

  const barVisible = profileDirty || savedFlash;

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
    let attempts = 0;
    let retry: number | undefined;
    let stop: (() => void) | null = null;
    const find = () => {
      stop = flashSettingsRow(scrollerRef.current, pendingRow.id);
      if (!stop && ++attempts < 20) {
        retry = window.setTimeout(find, 50);
      }
    };
    find();
    return () => {
      window.clearTimeout(retry);
      stop?.();
    };
  }, [pendingRow]);

  // Where a tab's `SettingsHeaderActions` land. State, not a ref, so the
  // context updates once the header has mounted.
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLDivElement | null>(null);

  const shell = useMemo<SettingsShellValue>(
    () => ({
      profileDirty,
      openSection,
      headerActionsSlot,
      profileHandleError: handleError,
    }),
    [profileDirty, openSection, headerActionsSlot, handleError],
  );

  const railItems = visibleSections.map((entry) => ({
    id: entry.id,
    label: t(entry.label),
    icon: entry.icon,
    group: entry.group,
    // The dot that says Perfil has edits the bar is waiting on, so the
    // unsaved state is visible from any tab, not only from the bar.
    dirty: entry.id === "profile" && profileDirty,
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
        onClose={requestClose}
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
                className={cn(
                  "min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none",
                  // The footer used to carry the home-indicator inset. With the
                  // bar up the bar carries it, and the scroller otherwise.
                  // With the bar up, a focused field scrolls clear of it.
                  barVisible ? "scroll-pb-24" : "safe-pb",
                )}
              >
                <div
                  className={cn(
                    "@container mx-auto w-full px-4 pt-5 sm:px-8 sm:pt-8",
                    // Room for the last group to scroll clear of the bar.
                    barVisible ? "pb-24" : "pb-5 sm:pb-8",
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
                          displayName={drafts.displayName}
                          onDisplayName={(next) => setDraft("displayName", next)}
                          displayNameError={nameError}
                          username={drafts.username}
                          onUsername={(next) => setDraft("username", next)}
                          handle={drafts.handle}
                          onHandle={(next) => setDraft("handle", next)}
                          avatarUrl={drafts.avatarUrl}
                          onAvatarUrl={(next) => setDraft("avatarUrl", next)}
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
                    </div>
                  </SettingsSectionContext.Provider>
                </div>
              </div>

              <UnsavedChangesBar
                visible={barVisible}
                saving={saving}
                saved={savedFlash && !profileDirty}
                blocked={closeBlocked}
                error={saveError}
                onDiscard={discardProfile}
                onSave={saveProfile}
              />
            </div>
          </div>
        </SettingsShellContext.Provider>
      </Dialog>

      <ConfirmDialog
        open={settingsOpen && handleConfirm !== null}
        title={t(
          handleConfirm === "claim"
            ? "settings.unsaved.handle.claimTitle"
            : "settings.unsaved.handle.changeTitle",
          { handle: drafts.handle.trim() },
        )}
        description={t("settings.unsaved.handle.body")}
        confirmLabel={t(
          handleConfirm === "claim"
            ? "settings.unsaved.handle.claim"
            : "settings.unsaved.handle.change",
        )}
        cancelLabel={t("settings.unsaved.handle.keep")}
        destructive={false}
        onConfirm={() => void commitProfile()}
        // Runs after `onConfirm` too, so it only closes; Manter keeps the drafts
        // and the bar exactly as they were.
        onClose={() => setHandleConfirm(null)}
      />

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
