import { type UserPreferences } from "@pqp/shared";
import { parseShortcutOverrides, type ShortcutOverrides } from "@/lib/keyboard-shortcuts";
import { DEFAULT_VIDEO_QUALITY, parseVideoQuality, type VideoQuality } from "@/lib/video-quality";
import { DEFAULT_SCREEN_FRAME_RATE, parseScreenFrameRate, type ScreenFrameRate } from "@/lib/hls-capture-rate";
import { defaultPttBinding, parsePttBinding, type PttBinding } from "@/components/voice/push-to-talk";
import { clampReleaseDelayMs, DEFAULT_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import type { VoiceInputMode } from "@/hooks/use-voice";
import { parseVadThreshold, SPEAKING_THRESHOLD } from "@/lib/voice-audio";
import { defaultMicProcessing, type MicProcessing } from "@/lib/audio-devices";
import { parseNoiseSuppressionMode } from "../../lib/noise-suppression";
import { adoptNotificationPreferences } from "@/lib/notifications";
import { adoptSoundPreferences } from "@/lib/sounds";

export interface LocalSettings {
  muteOnJoin: boolean;
  compactPeers: boolean;
  inputDeviceId: string;
  /** Webcam on this machine. Device-local, same reason as the mic id. */
  cameraDeviceId: string;
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
  /**
   * Voice-activity sensitivity, 0..1 on the same scale as the speaking
   * tracker. Device-local with `inputMode`: it describes this mic in this
   * room, and `@pqp/shared` has no preference key for it yet.
   */
  vadThreshold: number;
  /**
   * `PttBinding` rather than plain `KeyBinding`: push-to-talk can be bound to
   * a mouse button (middle click, or one of the two "extra" side buttons) as
   * well as a key, on the desktop shell's native hook (Tier 2, see
   * `electron/lib/native-ptt-hook.js`). See `push-to-talk.ts` for why that
   * type stays separate from the `KeyBinding` every app shortcut still uses.
   */
  pushToTalkKey: PttBinding;
  /**
   * How long the mic stays open after the PHYSICAL release before actually
   * closing, on the desktop shell's native hook: 0 to 2000 ms, default 20.
   * Same idea as Discord's own release-delay slider: closing the instant the
   * key comes up clips the end of a word. Device-local for the same reason
   * `pushToTalkKey` is: this is a property of this machine's native hook, and
   * has no meaning at all on the web (there is no native hook there, see
   * `use-push-to-talk.ts`) or on a shell too old to carry the bridge.
   */
  pttReleaseDelayMs: number;
  /**
   * Short local tones when the PTT key opens and closes the mic. Device-local
   * with the binding: it is a cue for this machine, and it is not a synced
   * sound preference.
   */
  pttBeep: boolean;
  /**
   * Desktop only: whether the shell holds the push-to-talk binding while the
   * window is in the background (the native hook, or its `globalShortcut`
   * fallback). Off keeps push-to-talk in-window, which is what someone wants
   * when the same key means something in the game they are playing. On by
   * default: working outside the window is the point of the desktop app.
   */
  pttGlobal: boolean;
  /**
   * Remapped Discord-style shortcuts. Device-local for the same reason as
   * the PTT key: a `KeyboardEvent.code` is this keyboard. Absent keys keep
   * the platform default (Cmd on Apple, Ctrl elsewhere).
   */
  shortcuts: ShortcutOverrides;
  /** getUserMedia processing flags. Also pending a shared-schema key. */
  micProcessing: MicProcessing;
  /**
   * What the camera is asked for. Device-local for the same reason the device
   * ids are: it describes this machine's webcam and this machine's uplink, and
   * syncing it to a phone would be meaningless.
   */
  videoQuality: VideoQuality;
  /**
   * Capture cadence for a screen share. Device-local with videoQuality: it
   * describes this display's refresh and this machine's encoder.
   */
  screenFrameRate: ScreenFrameRate;
}

const STORAGE_KEY = "pqp-local-settings";

export const defaultLocalSettings: LocalSettings = {
  muteOnJoin: false,
  compactPeers: false,
  inputDeviceId: "",
  cameraDeviceId: "",
  outputDeviceId: "",
  inputVolume: 1,
  outputVolume: 1,
  showLinkEmbeds: true,
  // Voice activity stays the default: it is what every existing user already
  // has, and push-to-talk is a choice people make, not one made for them.
  inputMode: "voice-activity",
  vadThreshold: SPEAKING_THRESHOLD,
  pushToTalkKey: defaultPttBinding(),
  pttReleaseDelayMs: DEFAULT_RELEASE_DELAY_MS,
  pttBeep: true,
  pttGlobal: true,
  shortcuts: {},
  micProcessing: defaultMicProcessing,
  // Auto, always. A default that pins a size would be a default that is wrong
  // on somebody's uplink.
  videoQuality: DEFAULT_VIDEO_QUALITY,
  screenFrameRate: DEFAULT_SCREEN_FRAME_RATE,
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
      cameraDeviceId:
        typeof parsed.cameraDeviceId === "string"
          ? parsed.cameraDeviceId
          : defaultLocalSettings.cameraDeviceId,
      outputDeviceId:
        typeof parsed.outputDeviceId === "string"
          ? parsed.outputDeviceId
          : defaultLocalSettings.outputDeviceId,
      inputMode:
        parsed.inputMode === "push-to-talk" ? "push-to-talk" : "voice-activity",
      vadThreshold: parseVadThreshold(parsed.vadThreshold),
      // A binding that no longer parses — hand-edited storage, or a key this
      // build has since started refusing — falls back rather than leaving
      // push-to-talk bound to nothing and the user apparently mute. Absent
      // `device` (every blob stored before mouse buttons existed) reads as
      // `"keyboard"`, which is exactly what it always meant.
      pushToTalkKey:
        parsePttBinding(parsed.pushToTalkKey) ?? defaultLocalSettings.pushToTalkKey,
      pttReleaseDelayMs: clampReleaseDelayMs(parsed.pttReleaseDelayMs),
      pttBeep:
        typeof parsed.pttBeep === "boolean"
          ? parsed.pttBeep
          : defaultLocalSettings.pttBeep,
      pttGlobal:
        typeof parsed.pttGlobal === "boolean"
          ? parsed.pttGlobal
          : defaultLocalSettings.pttGlobal,
      shortcuts: parseShortcutOverrides(parsed.shortcuts),
      micProcessing: {
        echoCancellation: parsed.micProcessing?.echoCancellation !== false,
        // Was a boolean until Sep 2026: `true` and a missing value both read
        // as the browser's own suppressor, `false` as none, which is what
        // every stored blob out there says today.
        noiseSuppression: parseNoiseSuppressionMode(
          parsed.micProcessing?.noiseSuppression,
        ),
        autoGainControl: parsed.micProcessing?.autoGainControl !== false,
      },
      // Hand-edited storage, or a level a later build stopped offering, falls
      // back to auto rather than to a size nothing knows how to ask for.
      videoQuality: parseVideoQuality(parsed.videoQuality),
      screenFrameRate: parseScreenFrameRate(parsed.screenFrameRate),
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
