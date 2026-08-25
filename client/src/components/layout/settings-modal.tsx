import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Gamepad2, Bell, Bug, Database, Mic, Palette, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import {
  canRenameHandle,
  deleteConfirmationMatches,
  expectedDeleteConfirmation,
  HANDLE_MAX_LENGTH,
  handleRenameAvailableAt,
  MAX_USER_BANNER_BYTES,
  normalizeHandle,
  publicProfileDisplayUrl,
  publicProfilePath,
  USER_BANNER_HEIGHT,
  USER_BANNER_MIME_ALLOWLIST,
  USER_BANNER_WIDTH,
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_KINDS,
  type FeedbackKind,
  type BlockedUser,
  type DmPrivacy,
  type User,
  type UserBannerConfig,
  type UserPreferences,
} from "@pqp/shared";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AvatarPicker } from "@/components/user/avatar-picker";
import { ConnectionsSection } from "@/components/connections/connections-section";
import { useNotificationSettings } from "@/hooks/use-notifications";
import { useAccentHue } from "@/hooks/use-accent-hue";
import { useAppearance } from "@/hooks/use-appearance";
import { useContrast } from "@/hooks/use-contrast";
import { useTheme } from "@/hooks/use-theme";
import { KeyBindingField } from "@/components/voice/key-binding-field";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import {
  DEFAULT_VIDEO_QUALITY,
  parseVideoQuality,
  VIDEO_QUALITIES,
  type VideoQuality,
} from "@/lib/video-quality";
import {
  defaultPushToTalkBinding,
  formatBinding,
  parseBinding,
  supportsKeyBinding,
  type KeyBinding,
} from "@/components/voice/push-to-talk";
import type { VoiceInputMode } from "@/hooks/use-voice";
import {
  defaultMicProcessing,
  ensureMediaPermission,
  listAudioDevices,
  supportsAudioOutputSelection,
  type MediaDeviceOption,
  type MicProcessing,
} from "@/lib/audio-devices";
import { desktopContext, getDesktop } from "@/lib/desktop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  SUPPORTED_LOCALES,
  setLocalePreference,
  type Locale,
} from "@/lib/locale";
import {
  adoptNotificationPreferences,
  type NotificationLevel,
} from "@/lib/notifications";
import {
  adoptSoundPreferences,
  getSoundState,
  playCue,
  setSoundCueEnabled,
  setSoundEnabled,
  subscribeSounds,
  type SoundCue,
} from "@/lib/sounds";
import {
  disablePush,
  enablePush,
  getCurrentPushSubscription,
  getPushAvailability,
  getPushConfig,
  setPushDmDetails,
  type PushAvailability,
} from "@/lib/push";
import {
  ACCENT_SWATCHES,
  effectiveAccentHue,
  type AccentHuePreference,
} from "@/lib/accent";
import type { AppearancePreference } from "@/lib/appearance";
import type { ContrastPreference } from "@/lib/contrast";
import type { ThemePreference } from "@/lib/theme";
import {
  ApiError,
  deleteMyAccount,
  deleteUserBanner,
  exportMyData,
  fetchUserBannerConfig,
  sendFeedback,
  updateMe,
  OwnedServersError,
  type BlockingOwnedServer,
} from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { uploadUserBanner } from "@/lib/banner-upload";
import { queuePreferenceSync } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export interface LocalSettings {
  muteOnJoin: boolean;
  compactPeers: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  showLinkEmbeds: boolean;
  /**
   * Voice input mode and its key binding.
   *
   * DEVICE-LOCAL FOR NOW, and deliberately absent from `preferencesFromLocal`.
   * `userPreferencesSchema` in `@pqp/shared` has no key for either yet, and
   * that schema is not this change's to edit — the exact keys to add are listed
   * in the handover. Until they exist these live in `localStorage` alongside
   * the device ids, which is the right home for the *binding* in any case: a
   * `KeyboardEvent.code` is a physical key on the keyboard in front of you, and
   * syncing it to a phone or a different layout is meaningless.
   */
  inputMode: VoiceInputMode;
  pushToTalkKey: KeyBinding;
  /** getUserMedia processing flags. Also pending a shared-schema key. */
  micProcessing: MicProcessing;
  /**
   * What the camera is asked for. Device-local for the same reason the device
   * ids are: it describes this machine's webcam and this machine's uplink, and
   * syncing it to a phone would be meaningless.
   */
  videoQuality: VideoQuality;
}

/** Option labels, so the select and the catalogue cannot drift apart. */
const VIDEO_QUALITY_LABELS: Record<VideoQuality, MessageKey> = {
  auto: "settings.voice.videoQuality.auto",
  "1080p": "settings.voice.videoQuality.1080p",
  "720p": "settings.voice.videoQuality.720p",
  "480p": "settings.voice.videoQuality.480p",
  "360p": "settings.voice.videoQuality.360p",
};

const STORAGE_KEY = "pqp-local-settings";

export const defaultLocalSettings: LocalSettings = {
  muteOnJoin: false,
  compactPeers: false,
  inputDeviceId: "",
  outputDeviceId: "",
  inputVolume: 1,
  outputVolume: 1,
  showLinkEmbeds: true,
  // Voice activity stays the default: it is what every existing user already
  // has, and push-to-talk is a choice people make, not one made for them.
  inputMode: "voice-activity",
  pushToTalkKey: defaultPushToTalkBinding,
  micProcessing: defaultMicProcessing,
  // Auto, always. A default that pins a size would be a default that is wrong
  // on somebody's uplink.
  videoQuality: DEFAULT_VIDEO_QUALITY,
};

export function loadLocalSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultLocalSettings;
    }
    const parsed = JSON.parse(raw) as Partial<LocalSettings>;
    return {
      ...defaultLocalSettings,
      ...parsed,
      inputVolume:
        typeof parsed.inputVolume === "number"
          ? Math.min(2, Math.max(0, parsed.inputVolume))
          : defaultLocalSettings.inputVolume,
      outputVolume:
        typeof parsed.outputVolume === "number"
          ? Math.min(1, Math.max(0, parsed.outputVolume))
          : defaultLocalSettings.outputVolume,
      inputDeviceId:
        typeof parsed.inputDeviceId === "string"
          ? parsed.inputDeviceId
          : defaultLocalSettings.inputDeviceId,
      outputDeviceId:
        typeof parsed.outputDeviceId === "string"
          ? parsed.outputDeviceId
          : defaultLocalSettings.outputDeviceId,
      inputMode:
        parsed.inputMode === "push-to-talk" ? "push-to-talk" : "voice-activity",
      // A binding that no longer parses — hand-edited storage, or a key this
      // build has since started refusing — falls back rather than leaving
      // push-to-talk bound to nothing and the user apparently mute.
      pushToTalkKey:
        parseBinding(parsed.pushToTalkKey) ?? defaultLocalSettings.pushToTalkKey,
      micProcessing: {
        echoCancellation: parsed.micProcessing?.echoCancellation !== false,
        noiseSuppression: parsed.micProcessing?.noiseSuppression !== false,
        autoGainControl: parsed.micProcessing?.autoGainControl !== false,
      },
      // Hand-edited storage, or a level a later build stopped offering, falls
      // back to auto rather than to a size nothing knows how to ask for.
      videoQuality: parseVideoQuality(parsed.videoQuality),
    };
  } catch {
    return defaultLocalSettings;
  }
}

export function saveLocalSettings(settings: LocalSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * The half of `LocalSettings` that describes the person rather than the
 * machine, ready to send to the server.
 *
 * Takes a partial so a single control change queues only the key it touched.
 * The device ids are what the filtering is for: they name hardware in this
 * browser profile and nowhere else, so they never leave the device.
 */
export function preferencesFromLocal(
  settings: Partial<LocalSettings>,
): UserPreferences {
  const preferences: UserPreferences = {};
  if (settings.muteOnJoin !== undefined) {
    preferences.muteOnJoin = settings.muteOnJoin;
  }
  if (settings.compactPeers !== undefined) {
    preferences.compactPeers = settings.compactPeers;
  }
  if (settings.inputVolume !== undefined) {
    preferences.inputVolume = settings.inputVolume;
  }
  if (settings.outputVolume !== undefined) {
    preferences.outputVolume = settings.outputVolume;
  }
  if (settings.showLinkEmbeds !== undefined) {
    preferences.showLinkEmbeds = settings.showLinkEmbeds;
  }
  return preferences;
}

/**
 * Overlay the account's settings onto this device's. The server wins on read —
 * it is the only copy that saw the change made on another device — while the
 * device keeps the parts the account does not carry.
 *
 * `theme`, `appearance`, `contrast` and `accentHue` are absent on purpose:
 * each lives in its own store under its own key, because the boot script
 * has to resolve them before this module exists.
 *
 * Notification levels are the same shape of thing — their own store, read by
 * the rail and the channel list rather than by any settings state — so this is
 * where the account's copy is handed over rather than returned.
 */
export function applyRemotePreferences(
  local: LocalSettings,
  preferences: UserPreferences | undefined,
): LocalSettings {
  if (!preferences) {
    return local;
  }
  adoptNotificationPreferences(preferences.notifications);
  adoptSoundPreferences(preferences.sounds);
  return {
    ...local,
    muteOnJoin: preferences.muteOnJoin ?? local.muteOnJoin,
    compactPeers: preferences.compactPeers ?? local.compactPeers,
    inputVolume: preferences.inputVolume ?? local.inputVolume,
    outputVolume: preferences.outputVolume ?? local.outputVolume,
    showLinkEmbeds: preferences.showLinkEmbeds ?? local.showLinkEmbeds,
  };
}

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
}

/* ------------------------------------------------------------------ layout */

/**
 * The sections, in nav order.
 *
 * This list is the whole information architecture: settings used to be one
 * column that mixed a display name, a microphone gain slider and the button
 * that deletes your account, and finding anything meant scrolling past
 * everything. The grouping below is what the old column already implied —
 * nothing moved between meanings, it was only given a name and a door.
 *
 * "Your data" is its own section rather than the tail of Profile on purpose:
 * export and deletion are rights the privacy policy promises, and a promise
 * that is only reachable by scrolling to the bottom of the longest page in the
 * app is one nobody finds. As a named door it is more visible than it was.
 */
type SectionId =
  | "profile"
  | "connections"
  | "voice"
  | "notifications"
  | "appearance"
  | "privacy"
  | "data"
  | "feedback";

/** For callers that open the dialog at a particular section (the user menu). */
export type SettingsSectionId = SectionId;

interface SectionDef {
  id: SectionId;
  label: MessageKey;
  description: MessageKey;
  icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
  {
    id: "profile",
    label: "settings.section.profile",
    description: "settings.profile.description",
    icon: UserRound,
  },
  {
    id: "connections",
    label: "settings.section.connections",
    description: "settings.connections.description",
    icon: Gamepad2,
  },
  {
    id: "voice",
    label: "settings.section.voice",
    description: "settings.voice.description",
    icon: Mic,
  },
  {
    id: "notifications",
    label: "settings.section.notifications",
    description: "settings.notifications.description",
    icon: Bell,
  },
  {
    id: "appearance",
    label: "settings.section.appearance",
    description: "settings.appearance.description",
    icon: Palette,
  },
  {
    id: "privacy",
    label: "settings.section.privacy",
    description: "settings.privacy.description",
    icon: ShieldCheck,
  },
  {
    id: "data",
    label: "settings.section.data",
    description: "settings.data.description",
    icon: Database,
  },
  {
    id: "feedback",
    label: "settings.section.feedback",
    description: "settings.feedback.description",
    icon: Bug,
  },
];

/**
 * The section rail — a vertical list beside the content on a desktop, a
 * horizontally scrolling strip above it on a phone.
 *
 * It is a real tablist: arrow keys move between sections and only the selected
 * tab is in the tab order, so a keyboard user crosses the rail with two
 * keystrokes rather than one per section. Both axes are accepted because the same control
 * is vertical at one width and horizontal at another, and a user should not
 * have to know which one the CSS picked.
 */
function SectionRail({
  active,
  onSelect,
  idFor,
  panelId,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  idFor: (id: SectionId) => string;
  panelId: string;
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);

  function move(to: number) {
    const index = (to + SECTIONS.length) % SECTIONS.length;
    const next = SECTIONS[index]!;
    onSelect(next.id);
    const tabs =
      railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = SECTIONS.findIndex((section) => section.id === active);
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(SECTIONS.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={t("settings.nav.label")}
      onKeyDown={handleKeyDown}
      className={cn(
        // The phone strip scrolls sideways *inside the panel*. That is the only
        // place sideways scrolling is allowed to exist here — the page itself
        // must never move, which is what the 390px layout test measures.
        "flex shrink-0 gap-1 overflow-x-auto border-b border-ink-4 px-3 py-2",
        "sm:w-56 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-3 sm:py-4",
      )}
    >
      {SECTIONS.map((section) => {
        const selected = section.id === active;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            id={idFor(section.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(section.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 sm:w-full",
              selected
                ? "bg-signal/12 font-medium text-paper"
                : "text-paper-muted hover:bg-ink-3 hover:text-paper",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t(section.label)}
          </button>
        );
      })}
    </div>
  );
}

/** Heading for the pane on the right, so a section always says what it is. */
function SectionHeader({ section }: { section: SectionDef }) {
  const { t } = useTranslation();
  return (
    <div className="mb-5">
      <h3 className="font-display text-lg font-bold text-paper">
        {t(section.label)}
      </h3>
      <p className="mt-1 text-xs text-paper-muted">{t(section.description)}</p>
    </div>
  );
}

/** A labelled group inside a section. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wide text-paper-muted">
        {label}
      </p>
      {children}
      {hint && <p className="mt-1.5 text-xs text-paper-muted">{hint}</p>}
    </div>
  );
}

const CHIP_BASE =
  "rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60";

function chipClass(selected: boolean): string {
  return cn(
    CHIP_BASE,
    selected
      ? "border-accent bg-accent/10 text-text"
      : "border-border text-text-muted hover:border-accent/50",
  );
}

/* ------------------------------------------------------------------- voice */

/**
 * Volume only scales how the level reads, so it is held in a ref: putting it in
 * the effect deps would tear down the preview stream and re-prompt
 * `getUserMedia` on every slider tick.
 */
function MicLevelMeter({
  deviceId,
  inputVolume,
  liveAnalyser,
  active,
}: {
  deviceId: string;
  inputVolume: number;
  liveAnalyser: AnalyserNode | null;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [level, setLevel] = useState(0);
  const volumeRef = useRef(inputVolume);

  useEffect(() => {
    volumeRef.current = inputVolume;
  }, [inputVolume]);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }

    let cancelled = false;
    let raf = 0;
    let preview: { stream: MediaStream; ctx: AudioContext } | null = null;

    function meter(analyser: AnalyserNode) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (cancelled) {
          return;
        }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) {
          sum += v;
        }
        const avg = sum / data.length / 255;
        setLevel(Math.min(1, avg * 1.8 * Math.max(0.15, volumeRef.current)));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }

    async function start() {
      if (liveAnalyser) {
        meter(liveAnalyser);
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
          video: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        preview = { stream, ctx };
        meter(analyser);
      } catch {
        setLevel(0);
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (preview) {
        for (const track of preview.stream.getTracks()) {
          track.stop();
        }
        void preview.ctx.close();
      }
    };
  }, [active, deviceId, liveAnalyser]);

  const label = t("settings.voice.inputLevel");

  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        {label}
      </span>
      <div
        className="h-2 overflow-hidden rounded-full bg-ink"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
      >
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-75"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
    </div>
  );
}

const INPUT_MODES: {
  value: VoiceInputMode;
  label: MessageKey;
  description: MessageKey;
}[] = [
  {
    value: "voice-activity",
    label: "settings.voice.mode.activity",
    description: "settings.voice.mode.activityHint",
  },
  {
    value: "push-to-talk",
    label: "settings.voice.mode.ptt",
    description: "settings.voice.mode.pttHint",
  },
];

const MIC_PROCESSING_OPTIONS: {
  key: keyof MicProcessing;
  label: MessageKey;
  description: MessageKey;
}[] = [
  {
    key: "echoCancellation",
    label: "settings.voice.processing.echo",
    description: "settings.voice.processing.echoHint",
  },
  {
    key: "noiseSuppression",
    label: "settings.voice.processing.noise",
    description: "settings.voice.processing.noiseHint",
  },
  {
    key: "autoGainControl",
    label: "settings.voice.processing.gain",
    description: "settings.voice.processing.gainHint",
  },
];

/**
 * Devices, levels, input mode and microphone processing.
 *
 * Everything here applies live rather than on Save — the same behaviour it had
 * in the single column, kept because a level you cannot hear while you set it
 * is a level you set twice.
 */
function VoiceSection({
  draftLocal,
  patchLocal,
  inputs,
  outputs,
  devicesError,
  voiceAnalyser,
  metering,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
  devicesError: string | null;
  voiceAnalyser: AnalyserNode | null;
  metering: boolean;
}) {
  const { t } = useTranslation();
  const canSelectOutput = supportsAudioOutputSelection();
  // Probed once: whether this machine has a keyboard worth binding does not
  // change while the dialog is open, and re-evaluating it per render would run
  // a media query on every slider tick.
  const canBindKey = useMemo(() => supportsKeyBinding(), []);
  const selectClass =
    "h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper outline-none focus:border-signal";

  return (
    <div className="space-y-5">
      {devicesError && (
        <p className="text-xs text-warning" role="status">
          {devicesError}
        </p>
      )}

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.voice.inputDevice")}
        </span>
        <select
          value={draftLocal.inputDeviceId}
          onChange={(e) => patchLocal({ inputDeviceId: e.target.value })}
          className={selectClass}
        >
          <option value="">{t("settings.voice.systemDefault")}</option>
          {inputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.voice.inputVolume")}
        </span>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(draftLocal.inputVolume * 100)}
          onChange={(e) =>
            patchLocal({ inputVolume: Number(e.target.value) / 100 })
          }
          className="w-full accent-[var(--color-signal)]"
        />
        <span className="mt-0.5 block text-xs text-paper-muted">
          {t("settings.voice.percent", {
            percent: Math.round(draftLocal.inputVolume * 100),
          })}
        </span>
      </label>

      <MicLevelMeter
        deviceId={draftLocal.inputDeviceId}
        inputVolume={draftLocal.inputVolume}
        liveAnalyser={voiceAnalyser}
        active={metering}
      />

      <fieldset className="space-y-2">
        <legend className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.voice.inputMode")}
        </legend>
        {INPUT_MODES.map((mode) => (
          <label
            key={mode.value}
            className="flex cursor-pointer items-start gap-3"
          >
            <input
              type="radio"
              name="input-mode"
              className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
              checked={draftLocal.inputMode === mode.value}
              onChange={() => patchLocal({ inputMode: mode.value })}
            />
            <span className="min-w-0">
              <span className="block text-sm">{t(mode.label)}</span>
              <span className="block text-xs text-paper-muted">
                {t(mode.description)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {draftLocal.inputMode === "push-to-talk" &&
        (canBindKey ? (
          <div className="space-y-1.5">
            <KeyBindingField
              label={t("settings.voice.pttKey")}
              binding={draftLocal.pushToTalkKey}
              onChange={(pushToTalkKey) => patchLocal({ pushToTalkKey })}
            />
            {/* The honest limit, stated where the binding is set rather than
                discovered later by talking to nobody. A web page cannot receive
                a key pressed while another window has focus; there is no global
                hotkey short of the desktop shell. */}
            <p className="text-xs text-paper-muted">
              {t("settings.voice.pttHint", {
                key: formatBinding(draftLocal.pushToTalkKey),
              })}
            </p>
          </div>
        ) : (
          <p className="text-xs text-paper-muted">
            {t("settings.voice.pttNoKeyboard")}
          </p>
        ))}

      <fieldset className="space-y-2">
        <legend className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.voice.processing")}
        </legend>
        {MIC_PROCESSING_OPTIONS.map((option) => (
          <label
            key={option.key}
            className="flex cursor-pointer items-start gap-3"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
              checked={draftLocal.micProcessing[option.key]}
              onChange={(e) =>
                patchLocal({
                  micProcessing: {
                    ...draftLocal.micProcessing,
                    [option.key]: e.target.checked,
                  },
                })
              }
            />
            <span className="min-w-0">
              <span className="block text-sm">{t(option.label)}</span>
              <span className="block text-xs text-paper-muted">
                {t(option.description)}
              </span>
            </span>
          </label>
        ))}
        <p className="text-xs text-paper-muted">
          {t("settings.voice.processing.note")}
        </p>
      </fieldset>

      {canSelectOutput ? (
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.voice.outputDevice")}
          </span>
          <select
            value={draftLocal.outputDeviceId}
            onChange={(e) => patchLocal({ outputDeviceId: e.target.value })}
            className={selectClass}
          >
            <option value="">{t("settings.voice.systemDefault")}</option>
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-paper-muted">
          {t("settings.voice.outputUnsupported", desktopContext())}
        </p>
      )}

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.voice.outputVolume")}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(draftLocal.outputVolume * 100)}
          onChange={(e) =>
            patchLocal({ outputVolume: Number(e.target.value) / 100 })
          }
          className="w-full accent-[var(--color-signal)]"
        />
        <span className="mt-0.5 block text-xs text-paper-muted">
          {t("settings.voice.percent", {
            percent: Math.round(draftLocal.outputVolume * 100),
          })}
        </span>
      </label>

      <div>
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.voice.videoQuality")}
          </span>
          <select
            value={draftLocal.videoQuality}
            onChange={(e) =>
              patchLocal({ videoQuality: parseVideoQuality(e.target.value) })
            }
            className={selectClass}
          >
            {VIDEO_QUALITIES.map((quality) => (
              <option key={quality} value={quality}>
                {t(VIDEO_QUALITY_LABELS[quality])}
              </option>
            ))}
          </select>
        </label>
        {/* The number beside the control that asks for it. Without this a
            person can pick 720p, receive 320x240 and have no way to know. */}
        <OutboundVideoReadout />
        <p className="mt-1 text-xs text-paper-muted">
          {t("settings.voice.videoQuality.hint")}
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={draftLocal.muteOnJoin}
          onChange={(e) => patchLocal({ muteOnJoin: e.target.checked })}
          className="h-4 w-4 accent-[var(--color-signal)]"
        />
        <span className="text-sm">{t("settings.voice.muteOnJoin")}</span>
      </label>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={draftLocal.compactPeers}
          onChange={(e) => patchLocal({ compactPeers: e.target.checked })}
          className="h-4 w-4 accent-[var(--color-signal)]"
        />
        <span className="text-sm">{t("settings.voice.compactPeers")}</span>
      </label>
    </div>
  );
}

/* -------------------------------------------------------------- appearance */

function SettingBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium text-text">{label}</h4>
        {hint ? (
          <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function segmentClass(selected: boolean, disabled = false): string {
  return cn(
    "rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
    selected
      ? "bg-surface-0 text-text shadow-sm"
      : "text-text-muted hover:text-text",
    disabled && "cursor-not-allowed opacity-40 hover:text-text-muted",
  );
}

const APPEARANCE_OPTIONS: {
  value: AppearancePreference;
  label: MessageKey;
}[] = [
  { value: "signal", label: "settings.appearance.preset.signal" },
  { value: "harmony", label: "settings.appearance.preset.harmony" },
  { value: "hearth", label: "settings.appearance.preset.hearth" },
  { value: "night", label: "settings.appearance.preset.night" },
];

function AppearancePicker() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useAppearance();

  function choose(next: AppearancePreference) {
    setAppearance(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = APPEARANCE_OPTIONS.findIndex(
      (option) => option.value === appearance,
    );
    const nextIndex =
      (current + step + APPEARANCE_OPTIONS.length) % APPEARANCE_OPTIONS.length;
    choose(APPEARANCE_OPTIONS[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <SettingBlock label={t("settings.appearance.preset")}>
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.preset")}
        className="grid grid-cols-2 gap-2"
        onKeyDown={handleKeyDown}
      >
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = option.value === appearance;
          const darkOnly = option.value === "night";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(option.value)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                selected
                  ? "border-accent bg-surface-2 text-text"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text",
              )}
            >
              <span
                aria-hidden
                className="appearance-preview"
                style={
                  {
                    "--preview-rail": `var(--swatch-${option.value}-rail)`,
                    "--preview-list": `var(--swatch-${option.value}-list)`,
                    "--preview-surface": `var(--swatch-${option.value}-surface)`,
                    "--preview-accent": `var(--swatch-${option.value}-accent)`,
                  } as CSSProperties
                }
              >
                <span className="appearance-preview-rail" />
                <span className="appearance-preview-list">
                  <span className="appearance-preview-channel" />
                  <span className="appearance-preview-channel" />
                  <span className="appearance-preview-channel" />
                </span>
                <span className="appearance-preview-chat">
                  <span className="appearance-preview-message" />
                  <span className="appearance-preview-message" />
                  <span className="appearance-preview-message" />
                  <span className="appearance-preview-composer" />
                </span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t(option.label)}</span>
                {darkOnly ? (
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                    {t("settings.appearance.preset.nightOnly")}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

function AccentHuePicker() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, setPreference } = useAccentHue();
  const sliderHue = effectiveAccentHue(preference, appearance);
  const isCustom = preference !== "default";

  return (
    <SettingBlock
      label={t("settings.appearance.accent")}
      hint={
        isCustom ? undefined : t("settings.appearance.accentDefaultHint")
      }
    >
      <div className="flex flex-col gap-2.5">
        <input
          type="range"
          min={0}
          max={360}
          value={sliderHue}
          aria-label={t("settings.appearance.accent")}
          onChange={(event) =>
            setPreference(Number(event.target.value) as AccentHuePreference)
          }
          className="accent-hue-slider"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {ACCENT_SWATCHES.map((hue) => (
            <button
              key={hue}
              type="button"
              aria-label={t("settings.appearance.accentHue", { hue })}
              aria-pressed={preference === hue}
              onClick={() => setPreference(hue)}
              className={cn(
                "accent-hue-dot h-7 w-7 rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                preference === hue
                  ? "border-text"
                  : "border-transparent hover:border-border-strong",
              )}
              style={{ "--swatch-hue": String(hue) } as CSSProperties}
            />
          ))}
          <button
            type="button"
            onClick={() => setPreference("default")}
            disabled={!isCustom}
            className="ml-1 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-40"
          >
            {t("settings.appearance.accentReset")}
          </button>
        </div>
      </div>
    </SettingBlock>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.theme.light" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "system", label: "settings.appearance.theme.system" },
];

/**
 * Theme is not part of `LocalSettings`: it applies on click rather than on
 * Save, and it persists under its own key so the boot script can read it
 * without parsing the audio blob.
 */
function ThemePicker() {
  const { t } = useTranslation();
  const { appearance } = useAppearance();
  const { preference, resolved, setPreference } = useTheme();
  const nightLocked = appearance === "night";
  const shown = nightLocked ? "dark" : preference;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const enabled = THEME_OPTIONS.filter(
      (option) => !nightLocked || option.value === "dark",
    );
    const current = enabled.findIndex((option) => option.value === shown);
    const nextIndex = (current + step + enabled.length) % enabled.length;
    setPreference(enabled[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const visualIndex = THEME_OPTIONS.findIndex(
      (option) => option.value === enabled[nextIndex].value,
    );
    radios[visualIndex]?.focus();
  }

  return (
    <SettingBlock
      label={t("settings.appearance.theme")}
      hint={
        nightLocked
          ? t("settings.appearance.themeNightLocked")
          : preference === "system"
            ? t("settings.appearance.themeFollowing", {
                theme: t(
                  resolved === "light"
                    ? "settings.appearance.resolved.light"
                    : "settings.appearance.resolved.dark",
                ),
              })
            : undefined
      }
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.theme")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-surface-2 p-0.5"
        onKeyDown={handleKeyDown}
      >
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === shown;
          const disabled = nightLocked && option.value !== "dark";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!disabled) {
                  setPreference(option.value);
                }
              }}
              className={segmentClass(selected, disabled)}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

const CONTRAST_OPTIONS: { value: ContrastPreference; label: MessageKey }[] = [
  { value: "default", label: "settings.appearance.contrast.default" },
  { value: "more", label: "settings.appearance.contrast.more" },
  { value: "system", label: "settings.appearance.contrast.system" },
];

function ContrastPicker() {
  const { t } = useTranslation();
  const { preference, resolved, setPreference } = useContrast();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const current = CONTRAST_OPTIONS.findIndex(
      (option) => option.value === preference,
    );
    const nextIndex =
      (current + step + CONTRAST_OPTIONS.length) % CONTRAST_OPTIONS.length;
    setPreference(CONTRAST_OPTIONS[nextIndex].value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  }

  return (
    <SettingBlock
      label={t("settings.appearance.contrast")}
      hint={
        preference === "system"
          ? t("settings.appearance.contrastFollowing", {
              contrast: t(
                resolved === "more"
                  ? "settings.appearance.resolved.more"
                  : "settings.appearance.resolved.default",
              ),
            })
          : t("settings.appearance.contrastHint")
      }
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.contrast")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-surface-2 p-0.5"
        onKeyDown={handleKeyDown}
      >
        {CONTRAST_OPTIONS.map((option) => {
          const selected = option.value === preference;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPreference(option.value)}
              className={segmentClass(selected)}
            >
              {t(option.label)}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

const LOCALE_LABELS: Record<Locale, MessageKey> = {
  en: "settings.appearance.language.en",
  "pt-BR": "settings.appearance.language.ptBR",
};

/**
 * The language switch `lib/locale.ts` has always been written for — it exposes
 * `setLocalePreference` with a comment saying "once there is UI to set one",
 * and this is that UI.
 *
 * Switching reloads rather than swapping strings under the mounted tree.
 * `I18nProvider` reads the locale once at boot on purpose, and Clerk's own
 * catalogue is wired at the provider in `main.tsx` — changing it in place would
 * leave the sign-in and account modals speaking the old language, which is a
 * worse answer than a reload. It is also what the legal pages already do.
 *
 * `?lang=` is dropped from the URL on the way out: it outranks the stored
 * preference, so a visitor who arrived on a `?lang=pt` link would otherwise
 * click "English" and get Portuguese back.
 */
function LanguagePicker() {
  const { t, locale } = useTranslation();

  async function choose(next: Locale) {
    if (next === locale) {
      return;
    }
    setLocalePreference(next);
    await getDesktop()?.setLocale?.(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("lang");
      window.location.replace(url.toString());
    } catch {
      window.location.reload();
    }
  }

  return (
    <SettingBlock
      label={t("settings.appearance.language")}
      hint={t("settings.appearance.languageHint")}
    >
      <div
        role="radiogroup"
        aria-label={t("settings.appearance.language")}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {SUPPORTED_LOCALES.map((option) => {
          const selected = option === locale;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => void choose(option)}
              className={segmentClass(selected)}
            >
              {t(LOCALE_LABELS[option])}
            </button>
          );
        })}
      </div>
    </SettingBlock>
  );
}

function AppearanceSection({
  showLinkEmbeds,
  onShowLinkEmbeds,
}: {
  showLinkEmbeds: boolean;
  onShowLinkEmbeds: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <p className="text-xs text-text-muted">
        {t("settings.appearance.syncHint")}
      </p>
      <ThemePicker />
      <AppearancePicker />
      <AccentHuePicker />
      <ContrastPicker />
      <div className="space-y-6 border-t border-border pt-6">
        <LanguagePicker />
        <SettingBlock label={t("settings.appearance.chat")}>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={showLinkEmbeds}
              onChange={(e) => onShowLinkEmbeds(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>{t("settings.appearance.linkPreviews")}</span>
          </label>
        </SettingBlock>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- notifications */

const LEVEL_OPTIONS: { value: NotificationLevel; label: MessageKey }[] = [
  { value: "all", label: "settings.notifications.level.all" },
  { value: "mentions", label: "settings.notifications.level.mentions" },
  { value: "none", label: "settings.notifications.level.none" },
];

const SOUND_CUE_OPTIONS: { cue: SoundCue; label: MessageKey }[] = [
  { cue: "mention", label: "settings.notifications.sounds.mention" },
  { cue: "voiceJoin", label: "settings.notifications.sounds.voiceJoin" },
  { cue: "voiceLeave", label: "settings.notifications.sounds.voiceLeave" },
  { cue: "incomingCall", label: "settings.notifications.sounds.incomingCall" },
  { cue: "outgoingCall", label: "settings.notifications.sounds.outgoingCall" },
];

/**
 * The account-wide notification default, plus the opt-in itself.
 *
 * Permission is requested from the button and nowhere else. Browsers penalise
 * pages that ask on load, a refusal cannot be taken back from script, and there
 * is no second prompt to fall back on — so the ask has to be worth spending.
 */
function NotificationsSection() {
  const { t } = useTranslation();
  const { state, permission, enable, disable, setDefaultLevel } =
    useNotificationSettings();
  const sounds = useSyncExternalStore(
    subscribeSounds,
    getSoundState,
    getSoundState,
  );
  const active = state.desktop && permission === "granted";

  return (
    <div className="space-y-6">
      <div>
        {permission === "unsupported" ? (
          <p className="text-xs text-paper-muted">
            {t("settings.notifications.unsupported", desktopContext())}
          </p>
        ) : permission === "denied" ? (
          <p className="text-xs text-warning" role="status">
            {t("settings.notifications.denied", desktopContext())}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={active ? "secondary" : "default"}
              size="sm"
              onClick={() => (active ? disable() : void enable())}
            >
              {active
                ? t("settings.notifications.turnOff")
                : t("settings.notifications.enable")}
            </Button>
            <span className="text-xs text-paper-muted">
              {active
                ? t("settings.notifications.on")
                : t("settings.notifications.willAsk", desktopContext())}
            </span>
          </div>
        )}
      </div>

      <Field
        label={t("settings.notifications.levelLabel")}
        hint={t("settings.notifications.levelHint")}
      >
        <div
          role="radiogroup"
          aria-label={t("settings.notifications.levelLabel")}
          className="flex flex-wrap gap-1.5"
        >
          {LEVEL_OPTIONS.map((option) => {
            const selected = option.value === state.default;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDefaultLevel(option.value)}
                className={chipClass(selected)}
              >
                {t(option.label)}
              </button>
            );
          })}
        </div>
      </Field>

      <Field
        label={t("settings.notifications.soundsLabel")}
        hint={t("settings.notifications.soundsHint")}
      >
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
              checked={sounds.enabled}
              onChange={(e) => setSoundEnabled(e.target.checked)}
            />
            <span className="text-sm">{t("settings.notifications.sounds.enabled")}</span>
          </label>
          {SOUND_CUE_OPTIONS.map((option) => (
            <label
              key={option.cue}
              className="flex cursor-pointer items-center gap-3 pl-7"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-signal)]"
                checked={sounds[option.cue]}
                disabled={!sounds.enabled}
                onChange={(e) =>
                  setSoundCueEnabled(option.cue, e.target.checked)
                }
              />
              <span className="min-w-0 flex-1 text-sm">{t(option.label)}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!sounds.enabled || !sounds[option.cue]}
                onClick={() => playCue(option.cue)}
              >
                {t("settings.notifications.sounds.preview")}
              </Button>
            </label>
          ))}
        </div>
      </Field>

      <PushNotificationsSection />
    </div>
  );
}

/**
 * Web Push — notifications that reach this device with the app fully closed.
 *
 * Subscribing happens behind the button and nowhere else: it needs the
 * browser's notification permission, and both Chrome's heuristics and iOS
 * outright require the request to originate from a user gesture. Nothing here
 * runs on app start.
 *
 * On iOS the API only exists inside an installed home-screen app, so a plain
 * Safari tab gets the install instruction instead of a button that cannot
 * work.
 */
function PushNotificationsSection() {
  const { t } = useTranslation();
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [dmDetails, setDmDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const availability = getPushAvailability();
    setAvailability(availability);
    if (availability !== "available") {
      return;
    }
    void (async () => {
      try {
        const [config, subscription] = await Promise.all([
          getPushConfig(),
          getCurrentPushSubscription(),
        ]);
        if (cancelled) {
          return;
        }
        setServerEnabled(config.enabled);
        setDmDetails(config.dmDetails);
        setSubscribed(subscription !== null);
      } catch {
        // The section renders nothing rather than a broken toggle.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        const result = await enablePush();
        if (result === "enabled") {
          setSubscribed(true);
        } else if (result === "denied") {
          setError(t("settings.push.denied", desktopContext()));
        } else {
          setError(t("settings.push.failed"));
        }
      }
    } catch {
      setError(t("settings.push.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const toggleDmDetails = async () => {
    const next = !dmDetails;
    // Optimistic — it is a checkbox, and the server answer below corrects it.
    setDmDetails(next);
    try {
      const saved = await setPushDmDetails(next);
      setDmDetails(saved.dmDetails);
    } catch {
      setDmDetails(!next);
    }
  };

  if (availability === null) {
    return null;
  }

  return (
    <Field label={t("settings.push.title")}>
      {availability === "needs-install" ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.needsInstall")}
        </p>
      ) : availability === "unsupported" ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.unsupported", desktopContext())}
        </p>
      ) : serverEnabled === false ? (
        <p className="text-xs text-paper-muted">
          {t("settings.push.notConfigured")}
        </p>
      ) : serverEnabled === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={subscribed ? "secondary" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {subscribed
                ? t("settings.push.turnOff")
                : t("settings.push.enable")}
            </Button>
            <span className="text-xs text-paper-muted">
              {subscribed ? t("settings.push.on") : t("settings.push.off")}
            </span>
          </div>
          {error ? (
            <p className="mt-1.5 text-xs text-warning" role="status">
              {error}
            </p>
          ) : null}
          {subscribed ? (
            <label className="mt-3 flex items-start gap-2 text-sm text-paper">
              <input
                type="checkbox"
                checked={dmDetails}
                onChange={() => void toggleDmDetails()}
                className="mt-0.5 accent-accent"
              />
              <span>
                {t("settings.push.dmDetails")}
                <span className="block text-xs text-paper-muted">
                  {t("settings.push.dmDetailsHint")}
                </span>
              </span>
            </label>
          ) : null}
        </>
      )}
    </Field>
  );
}

/* ----------------------------------------------------------------- privacy */

const DM_PRIVACY_OPTIONS: { value: DmPrivacy; label: MessageKey }[] = [
  { value: "everyone", label: "settings.privacy.dm.everyone" },
  { value: "server_members", label: "settings.privacy.dm.serverMembers" },
  { value: "nobody", label: "settings.privacy.dm.nobody" },
];

/**
 * Who may open a conversation with this account, and who has been blocked.
 *
 * Both apply the moment they are clicked rather than on Save, unlike the
 * profile fields in their own section. A privacy control that silently did
 * nothing because the dialog was dismissed with Cancel is the one failure this
 * section cannot have: the user believes they are closed off and they are not.
 *
 * The rule is enforced on the server on every attempt to open a conversation.
 * Nothing here is the enforcement — this is the switch, not the lock.
 */
function PrivacySection({
  user,
  blockedUsers,
  onUserUpdated,
  onUnblockUser,
}: {
  user: User | null;
  blockedUsers: BlockedUser[];
  onUserUpdated: (user: User) => void;
  onUnblockUser: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = user?.dmPrivacy ?? "server_members";

  async function choose(value: DmPrivacy) {
    if (!user || busy || value === current) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onUserUpdated(await updateMe({ dmPrivacy: value }));
    } catch (err) {
      setError(messageOf(err, t("settings.privacy.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Field
        label={t("settings.privacy.dmLabel")}
        hint={t("settings.privacy.dmHint")}
      >
        <div
          role="radiogroup"
          aria-label={t("settings.privacy.dmLabel")}
          className="flex flex-wrap gap-1.5"
        >
          {DM_PRIVACY_OPTIONS.map((option) => {
            const selected = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || !user}
                onClick={() => void choose(option.value)}
                className={chipClass(selected)}
              >
                {t(option.label)}
              </button>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </Field>

      <Field label={t("settings.privacy.blocked")}>
        {blockedUsers.length === 0 ? (
          <p className="text-xs text-paper-muted">
            {t("settings.privacy.blockedEmpty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {blockedUsers.map((blocked) => (
              <li
                key={blocked.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-paper">
                    {blocked.displayName}
                  </p>
                  {blocked.tag && (
                    <p className="truncate font-mono text-[11px] text-paper-muted">
                      {blocked.tag}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onUnblockUser(blocked.id)}
                >
                  {t("settings.privacy.unblock")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Field>
    </div>
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/* --------------------------------------------------------------- your data */

/**
 * The two rights the privacy policy promises, as buttons.
 *
 * Until these existed the only route was emailing an address and waiting for
 * somebody to run SQL by hand inside a 15-day statutory deadline. They have a
 * section of their own now rather than a footer at the end of a scroll: the
 * right to leave belongs somewhere a person can find it on purpose.
 */
function YourDataSection({
  user,
  onRequestDelete,
}: {
  user: User | null;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportMyData();
      // A Blob has no URL of its own, so one is minted just long enough for the
      // click to fire — the same mechanism the server export uses.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pqp-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(messageOf(err, t("settings.data.exportFailed")));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void download()}
            disabled={exporting || !user}
          >
            {exporting
              ? t("settings.data.exporting")
              : t("settings.data.export")}
          </Button>
          <span className="text-xs text-paper-muted">
            {t("settings.data.exportHint")}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-paper-muted">
          {t("settings.data.exportBody")}
        </p>
        {exportError && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {exportError}
          </p>
        )}
      </div>

      <div className="rounded-md border border-danger/30 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="border border-danger/40 text-danger hover:bg-danger/10"
            onClick={onRequestDelete}
            disabled={!user}
          >
            {t("settings.data.delete")}
          </Button>
          <span className="text-xs text-paper-muted">
            {t("settings.data.deleteHint")}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation itself.
 *
 * Deliberately not a browser `confirm()` and deliberately not a single button.
 * The user has to read what goes and what stays, and then type their own handle
 * — the same value `deleteConfirmationMatches` checks on the server, so the
 * button being enabled and the request being accepted can never disagree.
 *
 * It states what survives as plainly as what is destroyed. A deletion screen
 * that only lists what disappears is quietly misleading: audit entries, bans
 * this account issued, and reports filed about it all remain, and somebody
 * deleting their account specifically to erase a moderation record deserves to
 * learn that here rather than afterwards.
 */
function DeleteAccountDialog({
  open,
  user,
  onCancel,
  onDeleted,
}: {
  open: boolean;
  user: User | null;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingServers, setBlockingServers] = useState<
    BlockingOwnedServer[] | null
  >(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBlockingServers(null);
    }
  }, [open]);

  const expected = expectedDeleteConfirmation(user?.tag);
  const confirmed = deleteConfirmationMatches(typed, user?.tag);

  async function submit() {
    if (!confirmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setBlockingServers(null);
    try {
      await deleteMyAccount(typed);
      onDeleted();
    } catch (err) {
      if (err instanceof OwnedServersError) {
        setBlockingServers(err.servers);
        setError(null);
      } else {
        setError(messageOf(err, t("settings.delete.failed")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("settings.delete.eyebrow")}
      title={t("settings.delete.title")}
      size="sm"
      onClose={onCancel}
      // A stray click on the backdrop must not be able to dismiss the one
      // screen in the app whose next action cannot be undone.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("settings.delete.keep")}
          </Button>
          <Button
            className="bg-danger text-white hover:bg-danger/90"
            onClick={() => void submit()}
            disabled={!confirmed || busy}
          >
            {busy ? t("settings.delete.deleting") : t("settings.delete.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <p className="text-paper">{t("settings.delete.lead")}</p>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.whatGoes")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-paper-muted">
            <li>{t("settings.delete.goes.profile")}</li>
            <li>{t("settings.delete.goes.messages")}</li>
            <li>{t("settings.delete.goes.files")}</li>
            <li>{t("settings.delete.goes.memberships")}</li>
            <li>{t("settings.delete.goes.signIn")}</li>
            <li>{t("settings.delete.goes.servers")}</li>
          </ul>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.whatStays")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-paper-muted">
            <li>{t("settings.delete.stays.moderation")}</li>
            <li>{t("settings.delete.stays.bans")}</li>
            <li>{t("settings.delete.stays.reports")}</li>
          </ul>
          <p className="mt-2 text-xs text-paper-muted">
            {t("settings.delete.staysNote")}
          </p>
        </div>

        {blockingServers && blockingServers.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/10 p-3"
          >
            <p className="font-medium text-paper">
              {t("settings.delete.ownedTitle")}
            </p>
            <p className="mt-1 text-xs text-paper-muted">
              {t("settings.delete.ownedBody")}
            </p>
            <ul className="mt-2 space-y-1">
              {blockingServers.map((server) => (
                <li key={server.id} className="text-sm text-paper">
                  {server.name}{" "}
                  <span className="text-xs text-paper-muted">
                    {t("settings.delete.ownedMembers", {
                      count: server.otherMemberCount,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.typeLabel")}
          </span>
          <span className="mb-1 block font-mono text-sm text-signal">
            {expected}
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t("settings.delete.typeAria", { handle: expected })}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- profile */

/**
 * Name, handle and avatar — the only part of settings that waits for Save.
 *
 * The avatar control is `AvatarPicker` rather than anything local, because
 * onboarding renders the same one; a second picker is how the two lists of
 * presets start to differ.
 */
function ProfileSection({
  user,
  displayName,
  onDisplayName,
  username,
  onUsername,
  handle,
  onHandle,
  avatarUrl,
  onAvatarUrl,
  onUserUpdated,
}: {
  user: User | null;
  displayName: string;
  onDisplayName: (next: string) => void;
  username: string;
  onUsername: (next: string) => void;
  handle: string;
  onHandle: (next: string) => void;
  avatarUrl: string;
  onAvatarUrl: (next: string) => void;
  onUserUpdated: (user: User) => void;
}) {
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Null while the account has never claimed one, or once the window is over.
  const renameAvailableAt = canRenameHandle(user?.handleChangedAt, user?.handle)
    ? null
    : handleRenameAvailableAt(user?.handleChangedAt, user?.handle);

  const publicUrl = user?.handle ? publicProfileDisplayUrl(user.handle) : null;

  function copyPublicUrl() {
    if (!publicUrl) return;
    void navigator.clipboard
      ?.writeText(`https://${publicUrl}`)
      .then(() => setCopied(true))
      .catch(() => {
        // No clipboard (plain http, an embedded webview). The link is right
        // there in plain text, which is the fallback.
      });
  }

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="space-y-5">
      {user?.tag && (
        <Field label={t("settings.profile.handle")}>
          <p className="rounded-md border border-ink-4 bg-ink px-3 py-2 font-mono text-sm text-signal">
            {user.tag}
          </p>
        </Field>
      )}

      {/*
        The public link, immediately under the tag it is constantly confused
        with. Two name fields in one form is a design smell, so the two are put
        side by side and each says what it is for: `name#1234` is how somebody
        adds you inside the app, `pqp.gg/@name` is a page you can hand to
        somebody who has never heard of pqp.

        The claimed link is rendered as TEXT WITH A COPY BUTTON rather than as
        the input's value, because the two are different objects: the input is a
        thing you are editing and can abandon with Cancel, and the link is a
        thing you own and want on your clipboard. Collapsing them would mean the
        copy button copies a draft.
      */}
      <Field
        label={t("settings.profile.publicHandle")}
        hint={t("settings.profile.publicHandle.hint")}
      >
        <div className="flex items-stretch gap-0 rounded-md border border-ink-4 bg-ink focus-within:ring-2 focus-within:ring-signal/50">
          <span className="flex select-none items-center pl-3 font-mono text-sm text-paper-muted">
            pqp.gg/@
          </span>
          <input
            value={handle}
            maxLength={HANDLE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={renameAvailableAt !== null}
            placeholder={t("settings.profile.publicHandle.placeholder")}
            onChange={(event) => onHandle(normalizeHandle(event.target.value))}
            className="min-w-0 flex-1 bg-transparent px-1 py-2 font-mono text-sm text-paper outline-none placeholder:text-paper-muted/60 disabled:opacity-60"
          />
        </div>

        {renameAvailableAt && (
          <p className="mt-1.5 text-xs text-warning">
            {t("settings.profile.publicHandle.cooldown", {
              date: renameAvailableAt.toLocaleDateString(
                locale === "pt-BR" ? "pt-BR" : "en",
                { day: "numeric", month: "long", year: "numeric" },
              ),
            })}
          </p>
        )}

        {publicUrl && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-ink-3 px-2 py-1 font-mono text-xs text-signal">
              {publicUrl}
            </code>
            <button
              type="button"
              onClick={copyPublicUrl}
              className="inline-flex items-center gap-1 text-xs text-paper-muted underline underline-offset-2 hover:text-paper"
            >
              {copied
                ? t("settings.profile.publicHandle.copied")
                : t("settings.profile.publicHandle.copy")}
            </button>
            <a
              href={publicProfilePath(user!.handle!)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-paper-muted underline underline-offset-2 hover:text-paper"
            >
              {t("settings.profile.publicHandle.view")}
            </a>
          </div>
        )}
      </Field>

      {/* Above the avatar, matching the page it feeds: on `pqp.gg/@you` the
          banner is the first thing anybody sees and the avatar overlaps it.
          A settings form whose order contradicts the thing it edits is a form
          people scroll past looking for the control they can already picture. */}
      <BannerField user={user} onUserUpdated={onUserUpdated} />

      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.avatar")}
        </span>
        <AvatarPicker
          value={avatarUrl}
          onChange={onAvatarUrl}
          fallbackName={displayName}
          labels={{
            urlPlaceholder: t("settings.profile.avatar.urlPlaceholder"),
            urlLabel: t("settings.profile.avatar.urlLabel"),
            presetLabel: t("settings.profile.avatar.preset"),
            clear: t("settings.profile.avatar.clear"),
            upload: t("settings.profile.avatar.upload"),
            uploading: t("settings.profile.avatar.uploading"),
          }}
          // The claim already wrote it, so the app's copy of the account is
          // updated here rather than waiting for Save — otherwise the sidebar
          // keeps the old picture until the dialog closes, and Cancel would
          // look like it undid an upload it cannot.
          onUploaded={onUserUpdated}
        />
      </div>

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.displayName")}
        </span>
        <Input
          value={displayName}
          onChange={(e) => onDisplayName(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.username")}
        </span>
        <Input
          value={username}
          onChange={(e) =>
            onUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
          }
          placeholder={t("settings.profile.usernamePlaceholder")}
        />
        <span className="mt-1 block text-xs text-paper-muted">
          {t("settings.profile.usernameHint")}
        </span>
      </label>

      {/* Said once, here, because this section is the only one where Save means
          anything — everywhere else a control has already taken effect by the
          time the user looks away from it. */}
      <p className="text-xs text-paper-muted">{t("settings.profile.saveNote")}</p>
    </div>
  );
}

/**
 * The profile banner, uploaded and claimed the moment it is picked.
 *
 * NOT A DRAFT, unlike the three fields under it, and the asymmetry is the same
 * one `ServerIdentitySection` lives with: the bytes are already in the bucket
 * and the row already points at them, so there is nothing a later Save could
 * apply and nothing Cancel could take back. The control therefore reports what
 * HAPPENED rather than what is pending, and hands the updated account upward so
 * the preview here changes while the dialog is still open.
 *
 * The config is memoised for the life of the tab, exactly as the avatar picker
 * and the server identity section memoise theirs: storage is either configured
 * on this deployment or it is not, and re-asking every time the dialog opens is
 * a round trip somebody spends looking at a blank slot.
 */
let bannerConfigPromise: Promise<UserBannerConfig> | null = null;

function bannerUploadConfig(): Promise<UserBannerConfig> {
  bannerConfigPromise ??= fetchUserBannerConfig().catch(() => ({
    enabled: false,
    maxBytes: MAX_USER_BANNER_BYTES,
    width: USER_BANNER_WIDTH,
    height: USER_BANNER_HEIGHT,
  }));
  return bannerConfigPromise;
}

function BannerField({
  user,
  onUserUpdated,
}: {
  user: User | null;
  onUserUpdated: (user: User) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bannerUploadConfig().then((config) => {
      if (!cancelled) {
        setEnabled(config.enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bannerUrl = resolveUploadedImageUrl(user?.bannerUrl ?? null);

  async function handleFile(file: File) {
    setBusy("upload");
    setError(null);
    try {
      onUserUpdated(await uploadUserBanner(file));
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("settings.profile.banner.failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy("remove");
    setError(null);
    try {
      const res = await deleteUserBanner();
      onUserUpdated(res.user);
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("settings.profile.banner.removeFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" data-profile-banner>
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        {t("settings.profile.banner")}
      </span>

      {/* The preview is a 3:1 strip rather than a thumbnail, because that is
          the crop the upload will apply — a square preview would show a photo
          that is not the photo the page ends up with. */}
      <div className="aspect-[3/1] w-full overflow-hidden rounded-lg border border-ink-4 bg-ink">
        {bannerUrl ? (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-paper-muted">
            {t("settings.profile.banner.empty")}
          </div>
        )}
      </div>

      {!enabled ? (
        <p className="text-xs text-paper-muted">
          {t("settings.profile.banner.unconfigured")}
        </p>
      ) : (
        <>
          <p className="text-xs text-paper-muted">
            {t("settings.profile.banner.hint", {
              width: USER_BANNER_WIDTH,
              height: USER_BANNER_HEIGHT,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper hover:border-signal/50 disabled:opacity-60"
              onClick={() => fileRef.current?.click()}
            >
              {busy === "upload"
                ? t("settings.profile.banner.uploading")
                : bannerUrl
                  ? t("settings.profile.banner.replace")
                  : t("settings.profile.banner.upload")}
            </button>
            {bannerUrl && (
              <button
                type="button"
                disabled={busy !== null}
                className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper-muted hover:border-danger/50 hover:text-danger disabled:opacity-60"
                onClick={() => void handleRemove()}
              >
                {busy === "remove"
                  ? t("settings.profile.banner.removing")
                  : t("settings.profile.banner.remove")}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              aria-label={t("settings.profile.banner")}
              // A hint to the picker, never a check: the real gate is that
              // `createImageBitmap` refuses to decode anything that is not an
              // image, and what is uploaded is a JPEG this browser produced
              // rather than the bytes that were chosen.
              accept={USER_BANNER_MIME_ALLOWLIST.join(",")}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared before the upload, so picking the same file twice
                // after a failure still fires a change event.
                event.target.value = "";
                if (file) {
                  void handleFile(file);
                }
              }}
            />
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- modal */

/**
 * The feedback box — bugs, ideas, gripes. A confirmed bug earns the caça-bugs
 * badge, which is the entire gamification budget of this feature: one fun
 * consequence, no points, no leaderboard.
 */
function FeedbackSection() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-paper" role="status">
          {t("settings.feedback.done")}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setSent(false);
            setBody("");
            setError(null);
          }}
        >
          {t("settings.feedback.again")}
        </Button>
      </div>
    );
  }

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      await sendFeedback({ kind, body: body.trim() });
      setSent(true);
    } catch {
      setError(t("settings.feedback.error"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-paper-muted">{t("settings.feedback.intro")}</p>

      <Field label={t("settings.feedback.kind.label")}>
        <div
          role="radiogroup"
          aria-label={t("settings.feedback.kind.label")}
          className="flex flex-wrap gap-1.5"
        >
          {FEEDBACK_KINDS.map((option) => {
            const selected = option === kind;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setKind(option)}
                className={chipClass(selected)}
              >
                {t(FEEDBACK_KIND_LABELS[option])}
              </button>
            );
          })}
        </div>
      </Field>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={FEEDBACK_BODY_MAX_LENGTH}
        rows={5}
        placeholder={t("settings.feedback.placeholder")}
        aria-label={t("settings.section.feedback")}
        className="w-full resize-y rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper placeholder:text-paper-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      />

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={sending || body.trim().length === 0}
          onClick={() => void submit()}
        >
          {t("settings.feedback.send")}
        </Button>
        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kind.bug",
  idea: "settings.feedback.kind.idea",
  other: "settings.feedback.kind.other",
};

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
  const [outputs, setOutputs] = useState<MediaDeviceOption[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Which section is showing. Deliberately NOT reset when the dialog closes:
  // somebody adjusting a level, listening, and coming back should land where
  // they were rather than at the top of the tree every time.
  const [section, setSection] = useState<SectionId>("profile");
  const settingsRef = useRef(localSettings);
  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0]!;
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

  useEffect(() => {
    if (!open) {
      setConfirmingDelete(false);
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
      const { inputs: nextInputs, outputs: nextOutputs } =
        await listAudioDevices();
      if (cancelled) {
        return;
      }
      setInputs(nextInputs);
      setOutputs(nextOutputs);
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
    setSaving(true);
    setError(null);
    try {
      onLocalSave(draftLocal);
      saveLocalSettings(draftLocal);
      if (user) {
        const updated = await updateMe({
          displayName: displayName.trim() || undefined,
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

  return (
    <>
      <Dialog
        open={settingsOpen}
        eyebrow={t("settings.eyebrow")}
        title={t("settings.title")}
        size="xl"
        fill
        onClose={onClose}
        footer={
          <>
            {/* `mr-auto` pushes it away from Cancel and Save. Sign out is not a
                third way to finish editing settings, and sitting next to the
                two buttons that are would make it look like one. */}
            <SignOutButton className="mr-auto" />
            <Button variant="ghost" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? t("settings.saving") : t("settings.save")}
            </Button>
          </>
        }
      >
        <div className="flex h-full min-h-0 flex-col sm:flex-row">
          <SectionRail
            active={section}
            onSelect={setSection}
            idFor={(id) => `${tabIdPrefix}-${id}`}
            panelId={panelId}
          />

          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={`${tabIdPrefix}-${section}`}
            tabIndex={0}
            className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 focus-visible:outline-none"
          >
            <SectionHeader section={active} />

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
                devicesError={devicesError}
                voiceAnalyser={voiceAnalyser}
                metering={voiceVisible}
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

            {section === "feedback" && <FeedbackSection />}

            {error && (
              <p className="mt-4 text-sm text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
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
