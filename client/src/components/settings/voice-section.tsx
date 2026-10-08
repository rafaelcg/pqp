import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Keyboard, Lock, Mic, MicOff, Square, Video, Volume2, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  SETTINGS_BUSY,
  SettingsBadge,
  SettingsChoiceGrid,
  SettingsGroup,
  SettingsHeaderActions,
  SettingsInlineStatus,
  SettingsLinkRow,
  SettingsNotice,
  SettingsPreview,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
} from "@/components/settings/kit";
import { ACTION_LABEL } from "@/components/layout/shortcut-overlay";
import { findBindingConflict } from "@/lib/keyboard-shortcuts";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { dismissObsVirtualCameraHint, isObsVirtualCameraHintDismissed, isObsVirtualCameraLabel } from "@/lib/obs-virtual-camera";
import { parseVideoQuality, VIDEO_QUALITIES, type VideoQuality } from "@/lib/video-quality";
import { parseScreenFrameRate, SCREEN_FRAME_RATES, type ScreenFrameRate } from "@/lib/hls-capture-rate";
import {
  bindingTypesText,
  formatBinding,
  modifierName,
  modifierOfCode,
  supportsKeyBinding,
  type PttBinding,
} from "@/components/voice/push-to-talk";
import { clampReleaseDelayMs, MAX_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import { KeyBindingRefusalStatus, PttBindingField, type KeyBindingRefusal } from "@/components/voice/key-binding-field";
import { getPttReleaseStuck, subscribePttReleaseStuck } from "@/components/voice/shell-unbind";
import { pttHintMessageKey, usePttNativeSupport } from "@/lib/ptt-native-support";
import type { VoiceInputMode } from "@/hooks/use-voice";
import { parseVadThreshold } from "@/lib/voice-audio";
import {
  applyAudioOutputDevice,
  buildAudioConstraints,
  listAudioDevices,
  probeMicrophone,
  setMicTestRunning,
  supportsAudioOutputSelection,
  type MediaDeviceOption,
  type MicProcessing,
} from "@/lib/audio-devices";
import {
  ADVANCED_SAMPLE_RATE,
  advancedNoiseSuppressionSupported,
  connectMicChain,
  createRnnoiseNode,
  loadRnnoiseBinary,
  NOISE_SUPPRESSION_MODES,
  parseNoiseSuppressionMode,
  type NoiseSuppressionMode,
} from "../../lib/noise-suppression";
import { desktopContext, isDesktopApp } from "@/lib/desktop";
import { useInCall } from "@/lib/in-call-state";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { usePreferenceSyncFailed } from "@/lib/preferences";
import { setMusicAutoJoin, setMusicDucking, useMusicAutoJoin, useMusicDucking } from "@/lib/music-prefs";
import {
  setAutoHideStageControls,
  useAutoHideStageControls,
} from "@/lib/stage-controls-pref";
import { getSoundState, previewPttBeeps, setPttBeepEnabled, subscribeSounds, type SoundState } from "@/lib/sounds";
import { requestConnectionCheck } from "@/lib/settings-request";
import { isApplePlatform } from "@/lib/composer-formatting";
import { cn } from "@/lib/utils";
import { LocalSettings } from "@/components/settings/local-settings";
import { bindableMap } from "@/components/settings/keyboard-section";

/** Option labels, so the select and the catalogue cannot drift apart. */
const VIDEO_QUALITY_LABELS: Record<VideoQuality, MessageKey> = {
  auto: "settings.voice.videoQuality.auto",
  "1080p": "settings.voice.videoQuality.1080p",
  "720p": "settings.voice.videoQuality.720p",
  "480p": "settings.voice.videoQuality.480p",
  "360p": "settings.voice.videoQuality.360p",
};

const SCREEN_FRAME_RATE_LABELS: Record<ScreenFrameRate, MessageKey> = {
  auto: "settings.voice.screenFrameRate.auto",
  "30": "settings.voice.screenFrameRate.30",
  "60": "settings.voice.screenFrameRate.60",
};

/* ------------------------------------------------------------ device lists */

/** The id Chrome gives the "same as the system" entry in a device list. */
const BROWSER_DEFAULT_ID = "default";

/** Seconds as the buttons say them: 5000 ms is "5 s". */
function wholeSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

export interface MergedDevices {
  /** The list without the browser's own "default" entry. */
  devices: MediaDeviceOption[];
  /** The device the system default points at, when the browser says. */
  defaultName: string | null;
}

/**
 * The browser lists "Default - <device>" next to the device itself, which is
 * two entries for one piece of hardware beside our own "Padrão do sistema".
 * Drops that entry and hands back the device name, so the empty option can
 * read "Padrão do sistema (MacBook Pro)".
 */
export function mergeDefaultDevice(devices: MediaDeviceOption[]): MergedDevices {
  const entry = devices.find((device) => device.deviceId === BROWSER_DEFAULT_ID);
  if (!entry) {
    return { devices, defaultName: null };
  }
  // The prefix is the browser's own word in its own language ("Default - ",
  // "Padrão - "), so split on the first separator rather than match words.
  const separator = entry.label.indexOf(" - ");
  const name = (
    separator > 0 ? entry.label.slice(separator + 3) : entry.label
  ).trim();
  return {
    devices: devices.filter((device) => device.deviceId !== BROWSER_DEFAULT_ID),
    defaultName: name && name.toLowerCase() !== "default" ? name : null,
  };
}

/** The select value for a saved id: the browser default is "Padrão do sistema". */
export function deviceSelectValue(savedId: string): string {
  return savedId === BROWSER_DEFAULT_ID ? "" : savedId;
}

/**
 * True when a device was chosen and is no longer in a list that was read.
 * An empty list is "not read yet" or "none connected", never "missing".
 */
export function savedDeviceMissing(
  savedId: string,
  devices: readonly MediaDeviceOption[],
): boolean {
  return (
    deviceSelectValue(savedId) !== "" &&
    devices.length > 0 &&
    !devices.some((device) => device.deviceId === savedId)
  );
}

type DeviceKind = "input" | "output" | "camera";
const DEVICE_LABELS_KEY = "pqp:voice:device-labels";

/**
 * Only the id is saved with the settings, so a device that was unplugged has
 * no name left to show. The name is remembered here, in this browser, the last
 * time the saved device was seen, purely to say which one went missing.
 */
function readDeviceLabels(): Partial<Record<DeviceKind, { id: string; label: string }>> {
  try {
    const raw = window.localStorage.getItem(DEVICE_LABELS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberDeviceLabel(kind: DeviceKind, id: string, label: string): void {
  try {
    const labels = readDeviceLabels();
    if (labels[kind]?.id === id && labels[kind]?.label === label) {
      return;
    }
    labels[kind] = { id, label };
    window.localStorage.setItem(DEVICE_LABELS_KEY, JSON.stringify(labels));
  } catch {
    // Private mode or blocked storage: the notice just loses the name.
  }
}

export function recallDeviceLabel(kind: DeviceKind, id: string): string | null {
  const entry = readDeviceLabels()[kind];
  return entry && entry.id === id && entry.label ? entry.label : null;
}

/* ------------------------------------------------------------ push-to-talk key */

/**
 * The short name of a key that is bound on its own and is a modifier, or null.
 * Holding Ctrl for Ctrl+C holds the push-to-talk key too, so every shortcut
 * opens the microphone. Right Alt is left out: it is AltGr, and the typing
 * note already covers it. The fourth modifier is Cmd on Apple and the Windows
 * key elsewhere, whichever name the binding was saved with.
 */
export function loneModifierName(
  binding: PttBinding,
  apple: boolean = isApplePlatform(),
): string | null {
  if (binding.device !== "keyboard" || binding.code === "AltRight") {
    return null;
  }
  const modifier = modifierOfCode(binding.code);
  return modifier ? modifierName(modifier, apple) : null;
}

/** Enough of `navigator.keyboard.getLayoutMap()` for a key name. */
export interface KeyboardLayout {
  get(code: string): string | undefined;
}

/**
 * The factory binding is stored as a backquote, which is where that key sits
 * on a US keyboard. On an ABNT2 keyboard the same physical key types an
 * apostrophe, so the stock binding is drawn with the name the person's own
 * keyboard prints. A key the person bound themselves already carries the name
 * it had when they pressed it. Display only: the saved binding is untouched.
 */
export function relabelStockBinding(
  binding: PttBinding,
  layout: KeyboardLayout | null,
): PttBinding {
  const stock =
    binding.device === "keyboard" &&
    binding.code === "Backquote" &&
    binding.label === "`" &&
    !binding.ctrl &&
    !binding.alt &&
    !binding.shift &&
    !binding.meta;
  const name = stock ? layout?.get(binding.code) : undefined;
  if (!name || name.length !== 1 || name === binding.label) {
    return binding;
  }
  return { ...binding, label: name.toUpperCase() };
}

function useKeyboardLayout(): KeyboardLayout | null {
  const [layout, setLayout] = useState<KeyboardLayout | null>(null);
  useEffect(() => {
    // Chromium only, and not every build of it makes `keyboard` a full event
    // target, so each piece is checked before it is used. Anything missing
    // leaves the label as it was saved.
    const keyboard = (
      navigator as Navigator & {
        keyboard?: Partial<EventTarget> & {
          getLayoutMap?: () => Promise<KeyboardLayout>;
        };
      }
    ).keyboard;
    if (typeof keyboard?.getLayoutMap !== "function") {
      return;
    }
    let cancelled = false;
    const read = () => {
      try {
        void keyboard
          .getLayoutMap?.()
          .then((map) => {
            if (!cancelled) {
              setLayout(map);
            }
          })
          .catch(() => {});
      } catch {
        // A locked-down frame refuses the call; keep the saved label.
      }
    };
    read();
    const canListen = typeof keyboard.addEventListener === "function";
    if (canListen) {
      keyboard.addEventListener?.("layoutchange", read);
    }
    return () => {
      cancelled = true;
      if (canListen) {
        keyboard.removeEventListener?.("layoutchange", read);
      }
    };
  }, []);
  return layout;
}

/* ------------------------------------------------------------------- voice */

/**
 * The live bar and the voice-activity line share this scale, so the marker
 * sits on the same coordinates as the level the person is watching.
 *
 * The 1.8 gain is how the existing meter made a typical speaking level fill
 * more than a sliver of the bar. The volume floor stops a dragged-down
 * input volume from pinning the line to the left edge.
 *
 * This is the Settings bar, not the gate. The gate reads
 * `pipeline.analyser` (after the input-volume gain). The preview stream
 * here is raw getUserMedia. The marker matches this bar; a quiet talker
 * still has to move the line until their bar crosses it.
 */
const MIC_LEVEL_DISPLAY_GAIN = 1.8;
const MIC_LEVEL_VOLUME_FLOOR = 0.15;

export function displayMicLevel(raw: number, volume: number): number {
  return Math.min(
    1,
    raw * MIC_LEVEL_DISPLAY_GAIN * Math.max(MIC_LEVEL_VOLUME_FLOOR, volume),
  );
}

/**
 * The furthest right the sensitivity line can sit, as a percent of the bar.
 * The threshold stops at 1, and on this scale 1 is only as far as the bar
 * reaches at the current input volume (54% at 30%). The slider ends there, so
 * what a screen reader is told and where the line stops agree.
 */
export function maxSensitivityPercent(volume: number): number {
  return Math.round(displayMicLevel(1, volume) * 100);
}

export function sliderToVadThreshold(percent: number, volume: number): number {
  const scale =
    MIC_LEVEL_DISPLAY_GAIN * Math.max(MIC_LEVEL_VOLUME_FLOOR, volume);
  return parseVadThreshold(percent / 100 / scale);
}

/* ---------------------------------------------------------- mic loopback */

/** How long "Ouvir meu microfone" plays the microphone back before it stops itself. */
export const MIC_TEST_MS = 5000;

export interface MicLoopbackOptions {
  deviceId: string;
  processing: MicProcessing;
  /** 0 to 2, the same gain the call applies. */
  inputVolume: number;
  outputDeviceId: string;
  /** 0 to 1. */
  outputVolume: number;
  durationMs?: number;
  /** Called once, however it ended: the timer, `stop()`, or a failure. */
  onEnd: () => void;
}

/** The browser surface the loopback touches, so a test can hand it fakes. */
export interface MicLoopbackDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** `advanced` asks for the 48 kHz context RNNoise needs. */
  createContext: (advanced: boolean) => AudioContext;
  advancedSupported: () => boolean;
  /** RNNoise for this context; throws when the worklet or wasm refuses. */
  createSuppressor: (
    context: AudioContext,
  ) => Promise<AudioNode & { destroy(): void }>;
  createAudio: () => HTMLAudioElement;
  setSink: (element: HTMLMediaElement, deviceId: string) => Promise<void>;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const browserLoopbackDeps: MicLoopbackDeps = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createContext: (advanced) =>
    advanced
      ? new AudioContext({ sampleRate: ADVANCED_SAMPLE_RATE })
      : new AudioContext(),
  advancedSupported: advancedNoiseSuppressionSupported,
  createSuppressor: async (context) =>
    createRnnoiseNode(context, await loadRnnoiseBinary()),
  createAudio: () => new Audio(),
  setSink: applyAudioOutputDevice,
  setTimer: (run, ms) => window.setTimeout(run, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
};

export interface MicLoopback {
  stop: () => void;
  /** Settles once the loop is playing; rejects when the mic could not open. */
  ready: Promise<void>;
  /**
   * The loop's own level, before the input volume, once it is playing: the
   * meter reads this during the test instead of opening a second capture.
   */
  analyser: () => AnalyserNode | null;
  /**
   * The volumes apply to the running loop. Before it is playing they are kept
   * and used when it starts, so a slider moved during the permission prompt is
   * not lost.
   */
  setInputVolume: (volume: number) => void;
  setOutputVolume: (volume: number) => void;
}

/**
 * Plays the microphone back through the chosen output, processed the way the
 * call processes it: the same capture constraints, Voz limpa when it is on,
 * and the input volume. Client-only; nothing leaves the machine.
 *
 * It stops by itself after `durationMs`, and `stop()` may be called at any
 * point, including while the permission prompt is still open: the tracks that
 * arrive afterwards are released on arrival.
 */
export function startMicLoopback(
  options: MicLoopbackOptions,
  deps: MicLoopbackDeps = browserLoopbackDeps,
): MicLoopback {
  let stopped = false;
  let timer: unknown = null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let suppressor: (AudioNode & { destroy(): void }) | null = null;
  let audio: HTMLAudioElement | null = null;
  let analyser: AnalyserNode | null = null;
  let gainNode: GainNode | null = null;
  let inputVolume = options.inputVolume;
  let outputVolume = options.outputVolume;

  const release = () => {
    analyser = null;
    gainNode = null;
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio = null;
    }
    try {
      suppressor?.destroy();
    } catch {
      // Already gone with its context.
    }
    suppressor = null;
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
    if (context) {
      void context.close().catch(() => {});
      context = null;
    }
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    release();
    options.onEnd();
  };

  async function run() {
    const wantsAdvanced = options.processing.noiseSuppression === "advanced";
    let advanced = wantsAdvanced && deps.advancedSupported();
    const processing: MicProcessing =
      wantsAdvanced && !advanced
        ? { ...options.processing, noiseSuppression: "browser" }
        : options.processing;

    const opened = await deps.getUserMedia({
      audio: buildAudioConstraints(options.deviceId || undefined, processing),
      video: false,
    });
    if (stopped) {
      for (const track of opened.getTracks()) {
        track.stop();
      }
      return;
    }
    stream = opened;

    const fallBackToBrowserSuppression = () => {
      advanced = false;
      for (const track of opened.getAudioTracks()) {
        void track.applyConstraints({ noiseSuppression: true }).catch(() => {});
      }
    };

    try {
      context = deps.createContext(advanced);
    } catch (err) {
      if (!advanced) {
        throw err;
      }
      fallBackToBrowserSuppression();
      context = deps.createContext(false);
    }

    if (advanced) {
      try {
        suppressor = await deps.createSuppressor(context);
      } catch {
        suppressor = null;
        fallBackToBrowserSuppression();
      }
      if (stopped) {
        release();
        return;
      }
    }

    const source = context.createMediaStreamSource(opened);
    try {
      const tap = context.createAnalyser();
      tap.fftSize = 256;
      source.connect(tap);
      analyser = tap;
    } catch {
      // No level to show; the loop itself still plays.
      analyser = null;
    }
    const gain = context.createGain();
    gain.gain.value = Math.min(2, Math.max(0, inputVolume));
    gainNode = gain;
    const destination = context.createMediaStreamDestination();
    connectMicChain({ source, suppressor, gain });
    gain.connect(destination);

    const element = deps.createAudio();
    audio = element;
    element.srcObject = destination.stream;
    element.volume = Math.min(1, Math.max(0, outputVolume));
    await deps.setSink(element, options.outputDeviceId);
    if (stopped) {
      release();
      return;
    }
    timer = deps.setTimer(stop, options.durationMs ?? MIC_TEST_MS);
    await element.play();
  }

  const ready = run().catch((err: unknown) => {
    stop();
    throw err;
  });

  return {
    stop,
    ready,
    analyser: () => analyser,
    setInputVolume: (volume) => {
      inputVolume = volume;
      if (gainNode) {
        gainNode.gain.value = Math.min(2, Math.max(0, volume));
      }
    },
    setOutputVolume: (volume) => {
      outputVolume = volume;
      if (audio) {
        audio.volume = Math.min(1, Math.max(0, volume));
      }
    },
  };
}

/**
 * The "Ouvir meu microfone" state. `active` is whether the test may hold the
 * microphone at all: Voz is on screen and this person is not in a call. The
 * button cannot open the microphone while it is not, and a running test stops
 * the moment that changes (the tab is hidden, or a call starts).
 */
function useMicTest(active: boolean) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  // Whole seconds until the test stops itself. Null until the microphone is
  // really playing: while the permission prompt is open nothing is counting.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  // The loop's level while it plays, for the meter.
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const handle = useRef<MicLoopback | null>(null);
  const ticker = useRef<number | null>(null);
  // Loops somebody (or the hook) stopped on purpose. A permission prompt that
  // rejects after Parar was pressed is not a failure to report.
  const stoppedOnPurpose = useRef(new WeakSet<MicLoopback>());

  const clearTicker = useCallback(() => {
    if (ticker.current !== null) {
      window.clearInterval(ticker.current);
      ticker.current = null;
    }
    setSecondsLeft(null);
  }, []);

  const stop = useCallback(() => {
    const loop = handle.current;
    handle.current = null;
    if (loop) {
      stoppedOnPurpose.current.add(loop);
      loop.stop();
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stop();
    }
  }, [active, stop]);

  useEffect(() => stop, [stop]);

  const start = (options: Omit<MicLoopbackOptions, "onEnd">) => {
    if (!active || handle.current) {
      return;
    }
    setFailed(false);
    setPlaying(true);
    setMicTestRunning(true);
    const loop = startMicLoopback({
      ...options,
      onEnd: () => {
        if (handle.current === loop) {
          handle.current = null;
        }
        setMicTestRunning(false);
        clearTicker();
        setAnalyser(null);
        setPlaying(false);
      },
    });
    handle.current = loop;
    loop.ready.then(
      () => {
        if (handle.current !== loop) {
          return;
        }
        setAnalyser(loop.analyser());
        setSecondsLeft(wholeSeconds(options.durationMs ?? MIC_TEST_MS));
        ticker.current = window.setInterval(() => {
          setSecondsLeft((left) => (left === null ? null : Math.max(0, left - 1)));
        }, 1000);
      },
      () => {
        if (!stoppedOnPurpose.current.has(loop)) {
          setFailed(true);
        }
      },
    );
  };

  // Volumes are read by the running loop. Processing and devices are not:
  // they are chosen when the microphone opens, so a change restarts the test.
  const setVolumes = useCallback((inputVolume: number, outputVolume: number) => {
    handle.current?.setInputVolume(inputVolume);
    handle.current?.setOutputVolume(outputVolume);
  }, []);
  const startRef = useRef(start);
  startRef.current = start;
  const restart = useCallback(
    (options: Omit<MicLoopbackOptions, "onEnd">) => {
      if (!handle.current) {
        return;
      }
      stop();
      startRef.current(options);
    },
    [stop],
  );

  return { playing, failed, secondsLeft, analyser, start, stop, setVolumes, restart };
}

/* --------------------------------------------------------------- meter */

function useMicLevel({
  deviceId,
  inputVolume,
  liveAnalyser,
  active,
}: {
  deviceId: string;
  inputVolume: number;
  liveAnalyser: AnalyserNode | null;
  active: boolean;
}): number {
  const [level, setLevel] = useState(0);
  // Volume only scales how the level reads, so it is held in a ref: putting it
  // in the effect deps would tear down the preview stream and re-prompt
  // `getUserMedia` on every slider tick.
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
        setLevel(displayMicLevel(avg, volumeRef.current));
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

  return level;
}

/**
 * The level meter, 12px tall. With `onThresholdChange` it also carries the
 * voice-activity sensitivity marker: a 2px line drawn on the meter with a
 * small grabber on top of it, and an invisible `Slider` stretched over the
 * whole strip so anywhere on it is the grab target, and the arrow keys move
 * it. `disabled` is the microphone being blocked: an empty bar, no marker, and
 * nothing to operate until the person allows the microphone.
 */
/**
 * The meter plus its level source. The level updates every animation frame,
 * so it lives here: held by `VoiceSection` it re-rendered the whole pane 60
 * times a second while the tab was open.
 */
function LiveMicLevelMeter({
  deviceId,
  liveAnalyser,
  active,
  ...meter
}: {
  deviceId: string;
  liveAnalyser: AnalyserNode | null;
  active: boolean;
} & Omit<Parameters<typeof MicLevelMeter>[0], "level">) {
  // In a call the meter reads the call's own analyser and opens nothing.
  const level = useMicLevel({
    deviceId,
    inputVolume: meter.inputVolume,
    liveAnalyser,
    active,
  });
  return <MicLevelMeter level={level} {...meter} />;
}

function MicLevelMeter({
  level,
  inputVolume,
  threshold,
  onThresholdChange,
  disabled = false,
}: {
  level: number;
  inputVolume: number;
  threshold?: number;
  onThresholdChange?: (value: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const gated = threshold !== undefined && onThresholdChange !== undefined;
  const operable = gated && !disabled;
  const levelPct = disabled ? 0 : Math.round(level * 100);
  const thresholdPct =
    threshold !== undefined
      ? Math.round(displayMicLevel(threshold, inputVolume) * 100)
      : 0;
  const maxPct = maxSensitivityPercent(inputVolume);

  return (
    <div className={cn("space-y-2", disabled && "opacity-45")}>
      <div
        className={cn(
          "relative h-7 rounded-[var(--radius-control)]",
          operable &&
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-ring-offset",
        )}
      >
        <div
          role="progressbar"
          aria-label={t("settings.voice.inputLevel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={levelPct}
          className="absolute inset-x-0 top-3 h-3 overflow-hidden rounded-full border border-border bg-surface-0"
        >
          <div
            className="h-full rounded-full bg-success transition-[width] duration-75"
            style={{ width: `${levelPct}%` }}
          />
        </div>
        {operable ? (
          <>
            {/* The grabber: drawn only, the Slider below takes the pointer. */}
            <div
              aria-hidden
              data-sensitivity-grabber=""
              className="pointer-events-none absolute inset-y-0 w-4 -translate-x-1/2"
              style={{ left: `${thresholdPct}%` }}
            >
              <div className="absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 bg-text" />
              <div className="absolute inset-x-0 top-0 flex h-3 items-center justify-center gap-0.5 rounded bg-text">
                <span className="h-1.5 w-0.5 rounded-sm bg-surface-card" />
                <span className="h-1.5 w-0.5 rounded-sm bg-surface-card" />
              </div>
            </div>
            {/* As wide as the part of the bar the line can reach, so the
                pointer and the line stay on the same spot. */}
            <Slider
              variant="volume"
              className="absolute inset-y-0 left-0 h-7 cursor-ew-resize opacity-0"
              style={{ width: `${maxPct}%` }}
              value={thresholdPct}
              min={0}
              max={maxPct}
              step={1}
              aria-label={t("settings.voice.sensitivity")}
              aria-valuetext={t("settings.voice.sensitivityValueText", {
                percent: thresholdPct,
              })}
              onValueChange={(percent) =>
                onThresholdChange?.(sliderToVadThreshold(percent, inputVolume))
              }
            />
          </>
        ) : null}
      </div>
      {gated ? (
        <div
          aria-hidden
          className="flex justify-between gap-2 text-xs text-text-tertiary"
        >
          <span>{t("settings.voice.sensitivityMore")}</span>
          {operable ? (
            <span className="tabular-nums">
              {t("settings.voice.sensitivityOpensAt", { percent: thresholdPct })}
            </span>
          ) : null}
          <span>{t("settings.voice.sensitivityLess")}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A volume on a `Slider`, read out beside it. Local to Voz rather than the
 * kit's `SettingsSliderRow` because the touch strip is 40px tall (the kit's is
 * the 16px of the thumb, small for a finger), and the input volume needs a
 * mark at 100% and a line under it. `tickAt` draws the mark.
 */
function VolumeRow({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  tickAt,
  tickLabel,
  hint,
  readoutTone,
  onValueChange,
  format,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  tickAt?: number;
  tickLabel?: string;
  hint?: string;
  readoutTone?: "danger";
  onValueChange: (value: number) => void;
  format: (value: number) => string;
  children?: ReactNode;
}) {
  const readout = format(value);
  const tickPct =
    tickAt === undefined ? null : ((tickAt - min) / (max - min)) * 100;
  return (
    <SettingsRow
      id={id}
      label={label}
      description={description}
      stacked
      control={
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Slider
                variant="volume"
                className="h-10"
                value={value}
                min={min}
                max={max}
                step={step}
                aria-label={label}
                aria-valuetext={readout}
                onValueChange={onValueChange}
              />
              {tickPct !== null ? (
                <>
                  <div
                    aria-hidden
                    data-volume-tick=""
                    className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-border-strong"
                    style={{ left: `${tickPct}%` }}
                  />
                  {tickLabel ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute bottom-0 -translate-x-1/2 text-xs text-text-tertiary"
                      style={{ left: `${tickPct}%` }}
                    >
                      {tickLabel}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
            <span
              aria-hidden
              className={cn(
                "w-12 shrink-0 text-right text-xs tabular-nums",
                readoutTone === "danger" ? "text-danger" : "text-text-secondary",
              )}
            >
              {readout}
            </span>
          </div>
          {hint ? <p className="text-xs text-text-tertiary">{hint}</p> : null}
          {children}
        </div>
      }
    />
  );
}

/* ----------------------------------------------------------- input mode */

const INPUT_MODE_ICON: Record<VoiceInputMode, typeof Mic> = {
  "voice-activity": Mic,
  "push-to-talk": Keyboard,
};

const INPUT_MODES: {
  value: VoiceInputMode;
  label: MessageKey;
  hint: MessageKey;
}[] = [
  {
    value: "voice-activity",
    label: "settings.voice.mode.activity",
    hint: "settings.voice.mode.activityHint",
  },
  {
    value: "push-to-talk",
    label: "settings.voice.mode.ptt",
    hint: "settings.voice.mode.pttHint",
  },
];

/** Labels for the three suppressors, in the order the select offers them. */
const NOISE_SUPPRESSION_LABELS: Record<NoiseSuppressionMode, MessageKey> = {
  off: "settings.voice.processing.noise.off",
  browser: "settings.voice.processing.noise.browser",
  advanced: "settings.voice.processing.noise.advanced",
};

/* ------------------------------------------------------------- push to talk */

function PttBeepRow({
  enabled,
  soundsOn,
  onEnabledChange,
}: {
  enabled: boolean;
  soundsOn: boolean;
  onEnabledChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSwitchRow
      id="ptt-beep"
      label={t("settings.voice.pttBeep")}
      // The switch keeps its value, so the beep is back as it was when sounds
      // are; the line says why the test button does nothing meanwhile.
      description={t(
        soundsOn ? "settings.voice.pttBeepHint" : "settings.voice.pttBeepSoundsOff",
      )}
      checked={enabled}
      onCheckedChange={onEnabledChange}
      trailing={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!soundsOn || !enabled}
          onClick={() => previewPttBeeps()}
        >
          {t("settings.voice.pttBeepTest")}
        </Button>
      }
    />
  );
}

/**
 * The push-to-talk rows, sized to whatever this shell can actually do. The
 * desktop-only pieces (release delay, the background switch, the permission
 * notice) need `usePttNativeSupport`'s state, and that state has nothing to say
 * on the web build.
 *
 * The row names the key field, so the field hides its own label, and a
 * refused key (already used by a shortcut) is said in the row's status slot,
 * the same way Atalhos does it.
 */
function PttRows({
  draftLocal,
  patchLocal,
  sounds,
  onBeepChange,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  sounds: SoundState;
  onBeepChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const isDesktop = isDesktopApp();
  const native = usePttNativeSupport();
  const releaseStuck = useSyncExternalStore(
    subscribePttReleaseStuck,
    getPttReleaseStuck,
    () => false,
  );
  const hintKey = pttHintMessageKey({
    isDesktop,
    platformSupported: native.platformSupported,
    platformReason: native.platformReason,
    permission: native.permission,
    global: draftLocal.pttGlobal,
  });
  const keyLabel = t(
    isDesktop ? "settings.voice.pttKeyOrMouse" : "settings.voice.pttKey",
  );
  const [refusal, setRefusal] = useState<KeyBindingRefusal | null>(null);
  const layout = useKeyboardLayout();
  // Stable between frames: the field forgets its refusal whenever the binding
  // it is handed changes identity, and the level meter re-renders Voz every
  // frame.
  const shownBinding = useMemo(
    () => relabelStockBinding(draftLocal.pushToTalkKey, layout),
    [draftLocal.pushToTalkKey, layout],
  );
  const typesText =
    draftLocal.pushToTalkKey.device === "keyboard" &&
    bindingTypesText(draftLocal.pushToTalkKey);
  const modifierName = loneModifierName(draftLocal.pushToTalkKey);

  // A combo another shortcut already owns. The field says so and stays armed
  // for another try, as the Atalhos fields do, and the button keeps showing
  // the key that is really bound.
  const takenBy = (binding: PttBinding) => {
    if (binding.device === "mouse") {
      // A mouse button cannot collide with a keyboard-only app shortcut. See
      // the note on `PttBinding` in push-to-talk.ts.
      return null;
    }
    const taken = findBindingConflict(bindableMap(draftLocal), "pushToTalk", binding);
    return taken ? t(ACTION_LABEL[taken]) : null;
  };

  // A shortcut may take this key while the mode is voice activity (the key is
  // off then). Back in push-to-talk both would fire on one press, so say so.
  const sharedWith =
    draftLocal.pushToTalkKey.device === "keyboard"
      ? findBindingConflict(
          bindableMap({ ...draftLocal, inputMode: "push-to-talk" }),
          "pushToTalk",
          draftLocal.pushToTalkKey,
        )
      : null;

  return (
    <>
      <SettingsRow
        id="ptt"
        label={keyLabel}
        description={`${t(hintKey, { key: formatBinding(shownBinding, t) })} ${t(
          isDesktop
            ? "settings.voice.pttRecommendDesktop"
            : "settings.voice.pttRecommend",
        )}`}
        status={
          refusal ? (
            <div id={refusal.id}>
              <KeyBindingRefusalStatus message={refusal.message} />
            </div>
          ) : undefined
        }
        control={
          <PttBindingField
            label={keyLabel}
            hideLabel
            onRefusedChange={setRefusal}
            binding={shownBinding}
            allowMouse={isDesktop}
            takenBy={takenBy}
            onChange={(pushToTalkKey) => patchLocal({ pushToTalkKey })}
          />
        }
      />

      {sharedWith ? (
        <SettingsNotice tone="warning" inGroup>
          {t("settings.voice.pttConflict", {
            combo: formatBinding(shownBinding, t),
            action: t(ACTION_LABEL[sharedWith]),
          })}
        </SettingsNotice>
      ) : null}

      {modifierName ? (
        <SettingsNotice tone="warning" inGroup>
          {t(
            isDesktop
              ? "settings.voice.pttModifierWarningDesktop"
              : "settings.voice.pttModifierWarning",
            { key: modifierName },
          )}
        </SettingsNotice>
      ) : null}

      {typesText ? (
        <SettingsNotice tone="info" inGroup>
          {t("settings.voice.pttTypingNote", {
            key: formatBinding(draftLocal.pushToTalkKey, t),
          })}
        </SettingsNotice>
      ) : null}

      {!isDesktop ? (
        <SettingsLinkRow
          id="ptt-desktop"
          label={t("settings.voice.pttGetDesktop")}
          href="/download"
          external
        />
      ) : null}

      {isDesktop && native.available ? (
        <VolumeRow
          id="ptt-release-delay"
          label={t("settings.voice.pttReleaseDelay")}
          description={t("settings.voice.pttReleaseDelayHint")}
          value={draftLocal.pttReleaseDelayMs}
          min={0}
          max={MAX_RELEASE_DELAY_MS}
          step={10}
          format={(ms) => t("settings.voice.pttReleaseDelayMs", { ms })}
          onValueChange={(ms) =>
            patchLocal({ pttReleaseDelayMs: clampReleaseDelayMs(ms) })
          }
        />
      ) : null}

      {isDesktop ? (
        <SettingsSwitchRow
          id="ptt-global"
          label={t("settings.voice.pttGlobal")}
          description={t("settings.voice.pttGlobalHint")}
          checked={draftLocal.pttGlobal}
          onCheckedChange={(pttGlobal) => patchLocal({ pttGlobal })}
          status={
            draftLocal.pttGlobal && native.permission === "denied" ? (
              <SettingsNotice
                tone="warning"
                title={t("settings.voice.pttPermissionTitle")}
                action={
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={native.openSettings}
                  >
                    {t("settings.voice.pttPermissionOpenSettings")}
                  </Button>
                }
              >
                {t("settings.voice.pttPermissionBody")}
              </SettingsNotice>
            ) : undefined
          }
        />
      ) : null}

      {isDesktop && releaseStuck ? (
        // An alert, as before the redesign: the key may be held down in
        // another app right now, which is news the moment it happens.
        <SettingsNotice tone="warning" inGroup role="alert">
          {t("settings.voice.pttGlobalReleaseFailed")}
        </SettingsNotice>
      ) : null}

      <PttBeepRow
        enabled={draftLocal.pttBeep}
        soundsOn={sounds.enabled}
        onEnabledChange={onBeepChange}
      />
    </>
  );
}

/* ------------------------------------------------------------ camera test */

/** The picture from the camera, set once per stream. */
function CameraPreview({ stream }: { stream: MediaStream | null }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    element.srcObject = stream;
    if (stream) {
      void Promise.resolve(element.play?.()).catch(() => {});
    }
  }, [stream]);
  return (
    <div className="relative aspect-video w-full max-w-60 overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-0">
      <video
        ref={video}
        muted
        playsInline
        autoPlay
        aria-label={t("settings.voice.cameraPreview")}
        // Mirrored, like a mirror: what people expect from a self-view.
        className="h-full w-full -scale-x-100 object-cover"
      />
      <span className="absolute bottom-2 left-2 rounded-full bg-surface-0/80 px-2 py-0.5 text-xs text-text">
        {t("settings.voice.cameraPreviewPrivate")}
      </span>
    </div>
  );
}

/**
 * "Testar câmera": opens the chosen camera for a preview that only this
 * person sees, and closes it when they press the button again, change the
 * camera, leave Voz, or a call starts. Nothing is sent anywhere.
 */
function useCameraTest(deviceId: string, allowed: boolean, onOpened: () => void) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  useEffect(() => {
    if (!allowed) {
      setOn(false);
    }
  }, [allowed]);

  useEffect(() => {
    if (!on) {
      return;
    }
    let cancelled = false;
    let opened: MediaStream | null = null;
    void Promise.resolve()
      .then(() =>
        navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
          audio: false,
        }),
      )
      .then((next) => {
        if (cancelled) {
          for (const track of next.getTracks()) {
            track.stop();
          }
          return;
        }
        opened = next;
        setStream(next);
        // Labels of the other cameras are readable now.
        onOpenedRef.current();
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setOn(false);
        }
      });
    return () => {
      cancelled = true;
      for (const track of opened?.getTracks() ?? []) {
        track.stop();
      }
      setStream(null);
    };
  }, [on, deviceId]);

  return {
    on,
    failed,
    stream,
    toggle: () => {
      setFailed(false);
      setOn((value) => !value);
    },
  };
}

/**
 * The saved device against the list that was read: whether it is gone, and the
 * name it had the last time it was seen (the settings keep only an id).
 */
function useSavedDevice(
  kind: DeviceKind,
  savedId: string,
  devices: readonly MediaDeviceOption[],
  ready: boolean,
): { missing: boolean; name: string | null } {
  const found = devices.find((device) => device.deviceId === savedId);
  const foundLabel = found?.label;
  useEffect(() => {
    if (ready && foundLabel && deviceSelectValue(savedId) !== "") {
      rememberDeviceLabel(kind, savedId, foundLabel);
    }
  }, [ready, foundLabel, savedId, kind]);
  const missing = ready && savedDeviceMissing(savedId, devices);
  const name = useMemo(
    () => (missing ? recallDeviceLabel(kind, savedId) : null),
    [missing, kind, savedId],
  );
  return { missing, name };
}

/**
 * The saved device that is gone, kept as the selected option so the select
 * says what is saved and choosing the default is a real change. Without it
 * the select already showed the default, and picking it fired nothing.
 */
function MissingDeviceOption({
  saved,
  savedId,
}: {
  saved: { missing: boolean; name: string | null };
  savedId: string;
}) {
  const { t } = useTranslation();
  if (!saved.missing) {
    return null;
  }
  return (
    <option value={savedId} disabled>
      {saved.name
        ? t("settings.voice.deviceGone", { name: saved.name })
        : t("settings.voice.deviceGoneUnnamed")}
    </option>
  );
}

/** The account preferences Voz writes: the notice reads their sync. */
const VOICE_SYNCED_KEYS = ["inputVolume", "outputVolume", "muteOnJoin", "compactPeers"] as const;

/* -------------------------------------------------------------- section */

/**
 * Devices, levels, input mode, processing, video and call preferences.
 *
 * Everything here applies live, because a level you cannot hear while you set
 * it is a level you set twice.
 */
export function VoiceSection({
  draftLocal,
  patchLocal,
  inputs,
  outputs,
  cameras,
  onRevealCameras,
  devicesError,
  devicesLoaded,
  voiceAnalyser,
  metering,
  showVoiceCleanBadge,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
  cameras: MediaDeviceOption[];
  /**
   * Re-read the camera list with labels. `true` when the caller already holds
   * the camera (the preview), so no permission capture is opened.
   */
  onRevealCameras: (alreadyGranted?: boolean) => void;
  devicesError: string | null;
  /** The device list has been read this visit (not still waiting on a prompt). */
  devicesLoaded: boolean;
  voiceAnalyser: AnalyserNode | null;
  metering: boolean;
  /** NOVO chip on the noise-suppression row; see `lib/voice-clean.ts`. */
  showVoiceCleanBadge: boolean;
}) {
  const { t } = useTranslation();
  // The parts of Voz that follow the account (see `preferencesFromLocal`).
  const voiceSyncFailed = usePreferenceSyncFailed(VOICE_SYNCED_KEYS);
  const ids = useId();
  const musicAutoJoin = useMusicAutoJoin();
  const musicDucking = useMusicDucking();
  const autoHideControls = useAutoHideStageControls();
  const canSelectOutput = supportsAudioOutputSelection();
  const sounds = useSyncExternalStore(subscribeSounds, getSoundState, getSoundState);
  // Probed once: whether this machine has a keyboard worth binding does not
  // change while the dialog is open, and re-evaluating it per render would run
  // a media query on every slider tick.
  const canBindKey = useMemo(() => supportsKeyBinding(), []);
  const [obsHintDismissed, setObsHintDismissed] = useState(
    isObsVirtualCameraHintDismissed,
  );

  // "Permitir microfone". The shell asks once when Voz opens and has no way to
  // ask again, so the retry is made here, on a click, and the lists it reads
  // are held here until the shell's own catch up.
  const [allowed, setAllowed] = useState<Awaited<
    ReturnType<typeof listAudioDevices>
  > | null>(null);
  const [asking, setAsking] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  // Set once the lists are read; the effect that sees the select on the page
  // takes it and moves focus there.
  const focusInputOnceShown = useRef(false);
  useEffect(() => {
    if (devicesError === null) {
      setAllowed(null);
    }
  }, [devicesError]);
  const blocked = devicesError !== null && allowed === null;
  const loaded = devicesLoaded || allowed !== null;
  const allowMicrophone = async () => {
    if (asking) {
      return;
    }
    setAsking(true);
    try {
      // A machine with no microphone is answered too: the list comes back
      // empty and the row says so, which is the news the person asked for. A
      // microphone another app still holds is not: the notice stays.
      const probe = await probeMicrophone();
      // Another app holds it: the notice says so now, whatever it said before
      // (it said permission was needed, and the person just gave it).
      setMicBusy(probe === "busy");
      if (probe === "granted" || probe === "none") {
        setAllowed(await listAudioDevices());
        // The notice holding the pressed button goes away: the effect below
        // hands the keyboard to the select that takes its place, once it is
        // on the page.
        focusInputOnceShown.current = true;
      }
    } finally {
      setAsking(false);
    }
  };

  const inputList = mergeDefaultDevice(inputs.length > 0 ? inputs : (allowed?.inputs ?? []));
  const outputList = mergeDefaultDevice(outputs.length > 0 ? outputs : (allowed?.outputs ?? []));
  const cameraList = cameras.length > 0 ? cameras : (allowed?.cameras ?? []);
  const systemDefault = (name: string | null) =>
    name
      ? t("settings.voice.systemDefaultNamed", { name })
      : t("settings.voice.systemDefault");

  const voiceActivity = draftLocal.inputMode === "voice-activity";
  // The analyser alone is not the signal: a listen-only join (no mic, or the
  // mic refused) and an audience seat are in the call with no pipeline. The
  // voice controller's own status covers both; the analyser covers a test
  // harness that renders this tab without `App`.
  const inCall = useInCall() || voiceAnalyser !== null;
  // Never a second capture during a call, and never the mic played into the
  // speakers a live call is listening through.
  const micTest = useMicTest(metering && !inCall);
  // Only after the list was really read: while the permission prompt is up
  // the list is empty too, and that is not "no microphone".
  const noInputs =
    metering && loaded && !blocked && inputList.devices.length === 0;
  const inputSaved = useSavedDevice(
    "input",
    draftLocal.inputDeviceId,
    inputList.devices,
    metering && loaded && !blocked,
  );
  const outputSaved = useSavedDevice(
    "output",
    draftLocal.outputDeviceId,
    outputList.devices,
    metering && loaded && !blocked && canSelectOutput,
  );
  const cameraSaved = useSavedDevice(
    "camera",
    draftLocal.cameraDeviceId,
    cameraList,
    metering,
  );
  // What the previews open. A saved device that is gone falls back to the
  // default, as the notices under the selects say and as a call does.
  const inputInUse = inputSaved.missing ? "" : draftLocal.inputDeviceId;
  const outputInUse = outputSaved.missing ? "" : draftLocal.outputDeviceId;
  const cameraInUse = cameraSaved.missing ? "" : draftLocal.cameraDeviceId;
  const cameraTest = useCameraTest(cameraInUse, metering && !inCall, () =>
    onRevealCameras(true),
  );

  const micTestOptions = (): Omit<MicLoopbackOptions, "onEnd"> => ({
    deviceId: inputInUse,
    processing: draftLocal.micProcessing,
    inputVolume: draftLocal.inputVolume,
    outputDeviceId: canSelectOutput ? outputInUse : "",
    outputVolume: draftLocal.outputVolume,
  });
  // The running test follows the volume sliders as they move. It cannot follow
  // the sound processing, which is chosen when the microphone opens, so a
  // change there starts the test again with the new settings.
  const { setVolumes, restart: restartMicTest } = micTest;
  useEffect(() => {
    setVolumes(draftLocal.inputVolume, draftLocal.outputVolume);
  }, [setVolumes, draftLocal.inputVolume, draftLocal.outputVolume]);
  const { noiseSuppression, echoCancellation, autoGainControl } = draftLocal.micProcessing;
  const processingKey = `${noiseSuppression}|${echoCancellation}|${autoGainControl}`;
  const lastProcessingKey = useRef(processingKey);
  const micTestOptionsRef = useRef(micTestOptions);
  micTestOptionsRef.current = micTestOptions;
  useEffect(() => {
    if (lastProcessingKey.current === processingKey) {
      return;
    }
    lastProcessingKey.current = processingKey;
    restartMicTest(micTestOptionsRef.current());
  }, [processingKey, restartMicTest]);

  const onBeepChange = (pttBeep: boolean) => {
    setPttBeepEnabled(pttBeep);
    patchLocal({ pttBeep });
  };

  const showObsHint =
    !obsHintDismissed &&
    isObsVirtualCameraLabel(
      cameraList.find((device) => device.deviceId === draftLocal.cameraDeviceId)
        ?.label ?? "",
    );

  const inputId = `${ids}-input`;
  useEffect(() => {
    if (!focusInputOnceShown.current || blocked) {
      return;
    }
    focusInputOnceShown.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) {
      document.getElementById(inputId)?.focus();
    }
  }, [allowed, blocked, inputId]);
  const outputId = `${ids}-output`;
  const noiseId = `${ids}-noise`;
  const cameraId = `${ids}-camera`;
  const qualityId = `${ids}-quality`;
  const frameRateId = `${ids}-fps`;

  const testSeconds = wholeSeconds(MIC_TEST_MS);
  const micTestLabel = micTest.playing
    ? micTest.secondsLeft === null
      ? t("settings.voice.micTestStop")
      : t("settings.voice.micTestStopIn", { seconds: micTest.secondsLeft })
    : t("settings.voice.micTestWithTime", { seconds: testSeconds });
  // The label the button is not showing, so it keeps the wider of the two.
  const micTestSpare = micTest.playing
    ? t("settings.voice.micTestWithTime", { seconds: testSeconds })
    : t("settings.voice.micTestStopIn", { seconds: testSeconds });

  const noiseHintKey = {
    off: "settings.voice.processing.noise.offHint",
    browser: "settings.voice.processing.noiseHint",
    advanced: "settings.voice.processing.noise.advancedHint",
  } as const satisfies Record<NoiseSuppressionMode, MessageKey>;

  return (
    <div className="space-y-6">
      {voiceSyncFailed ? (
        // Sticky, as in Aparência: the control that failed is usually
        // further down the tab.
        <div className="sticky top-2 z-10">
          <SettingsNotice tone="warning" role="alert">
            {t("settings.syncFailed")}
          </SettingsNotice>
        </div>
      ) : null}
      <SettingsHeaderActions>
        {/* The way out of "stuck on connecting": five checks and the fix. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => requestConnectionCheck()}
          data-settings-check-connection
        >
          <Wifi className="h-3.5 w-3.5" aria-hidden />
          {t("connection.check")}
        </Button>
      </SettingsHeaderActions>

      <SettingsGroup title={t("settings.voice.group.mic.title")}>
        <SettingsRow
          id="input-device"
          label={t("settings.voice.inputDevice")}
          htmlFor={blocked || noInputs ? undefined : inputId}
          description={
            inCall && !blocked && !noInputs
              ? t("settings.voice.micTestInCall")
              : undefined
          }
          stacked
          status={
            micTest.failed ? (
              <SettingsInlineStatus
                state={{ kind: "error", message: t("settings.voice.micTestFailed") }}
              />
            ) : undefined
          }
          control={
            blocked ? undefined : noInputs ? (
              <SettingsNotice tone="info">{t("settings.voice.noInputs")}</SettingsNotice>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 @lg:flex-row @lg:items-center">
                  <SettingsSelect
                    id={inputId}
                    className="min-w-0 @lg:flex-1"
                    value={deviceSelectValue(draftLocal.inputDeviceId)}
                    onChange={(e) => patchLocal({ inputDeviceId: e.target.value })}
                  >
                    <option value="">{systemDefault(inputList.defaultName)}</option>
                    <MissingDeviceOption
                      saved={inputSaved}
                      savedId={draftLocal.inputDeviceId}
                    />
                    {inputList.devices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </SettingsSelect>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={cn(
                      "self-start @lg:self-auto",
                      inCall && SETTINGS_BUSY,
                    )}
                    disabled={!metering}
                    // Busy but focusable: a call starting while this has focus
                    // must not drop the keyboard on the page.
                    aria-disabled={inCall || undefined}
                    data-mic-test=""
                    // A steady name while it plays: the countdown ticks every
                    // second, and a focused button whose name changes is read
                    // again by some screen readers.
                    aria-label={micTest.playing ? t("settings.voice.micTestStop") : undefined}
                    onClick={() => {
                      if (inCall) {
                        return;
                      }
                      if (micTest.playing) {
                        micTest.stop();
                      } else {
                        micTest.start(micTestOptions());
                      }
                    }}
                  >
                    {micTest.playing ? (
                      <Square className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {/* Both labels share one grid cell, so the button is as wide
                        as the longer one and the select beside it never resizes
                        when the test starts or stops. The hidden one is out of
                        the accessible name. */}
                    <span className="grid tabular-nums">
                      <span className="col-start-1 row-start-1">{micTestLabel}</span>
                      <span aria-hidden className="invisible col-start-1 row-start-1">
                        {micTestSpare}
                      </span>
                    </span>
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary">
                  {t("settings.voice.micTestHint", { seconds: testSeconds })}
                </p>
                {inputSaved.missing ? (
                  <SettingsNotice tone="warning">
                    {inputSaved.name
                      ? t("settings.voice.inputMissing", { name: inputSaved.name })
                      : t("settings.voice.inputMissingUnnamed")}
                  </SettingsNotice>
                ) : null}
              </div>
            )
          }
        />

        {blocked ? (
          <>
            <SettingsNotice
              tone="warning"
              inGroup
              action={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  // Busy but focusable: a disabled button drops keyboard
                  // focus on the page while the browser asks.
                  aria-disabled={asking || undefined}
                  className={asking ? SETTINGS_BUSY : undefined}
                  onClick={() => void allowMicrophone()}
                  data-allow-microphone=""
                >
                  {t("settings.voice.allowMic")}
                </Button>
              }
            >
              {micBusy ? t("settings.voice.micBusy") : devicesError}
            </SettingsNotice>
            <SettingsNotice tone="info" inGroup role="note" icon={Lock}>
              {t("settings.voice.allowMicSteps", desktopContext())}
            </SettingsNotice>
          </>
        ) : null}

        <VolumeRow
          id="input-volume"
          label={t("settings.voice.inputVolume")}
          value={Math.round(draftLocal.inputVolume * 100)}
          min={0}
          max={200}
          tickAt={100}
          tickLabel={t("settings.voice.percent", { percent: 100 })}
          hint={t("settings.voice.inputVolumeHint")}
          readoutTone={draftLocal.inputVolume === 0 ? "danger" : undefined}
          format={(percent) => t("settings.voice.percent", { percent })}
          onValueChange={(percent) => patchLocal({ inputVolume: percent / 100 })}
        >
          {draftLocal.inputVolume === 0 ? (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-danger"
            >
              <MicOff aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {t("settings.voice.inputVolumeZero")}
            </p>
          ) : null}
        </VolumeRow>

        <SettingsRow
          id={voiceActivity ? "sensitivity" : "input-level"}
          label={t(
            voiceActivity ? "settings.voice.sensitivity" : "settings.voice.inputLevel",
          )}
          description={
            voiceActivity
              ? t(
                  blocked
                    ? "settings.voice.sensitivityBlocked"
                    : noInputs
                      ? "settings.voice.sensitivityNoMic"
                      : "settings.voice.sensitivityHint",
                )
              : undefined
          }
          stacked
          control={
            // Not decorative: the sensitivity handle is operated in place.
            // The meter names its progress bar and slider itself and hides
            // the captions.
            <SettingsPreview decorative={false}>
              <div className="px-3 py-2">
                <LiveMicLevelMeter
                  deviceId={inputInUse}
                  // During the mic test the bar reads the test's own loop:
                  // a second capture of one microphone can mute the first on
                  // Safari, so the meter's preview is closed meanwhile.
                  liveAnalyser={voiceAnalyser ?? micTest.analyser}
                  active={
                    metering &&
                    !blocked &&
                    !noInputs &&
                    (!micTest.playing || micTest.analyser !== null)
                  }
                  inputVolume={draftLocal.inputVolume}
                  disabled={blocked || noInputs}
                  threshold={voiceActivity ? draftLocal.vadThreshold : undefined}
                  onThresholdChange={
                    voiceActivity
                      ? (vadThreshold) => patchLocal({ vadThreshold })
                      : undefined
                  }
                />
              </div>
            </SettingsPreview>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.voice.group.output.title")}>
        <SettingsRow
          id="output-device"
          label={t("settings.voice.outputDevice")}
          htmlFor={canSelectOutput ? outputId : undefined}
          stacked={!canSelectOutput || outputSaved.missing}
          control={
            canSelectOutput ? (
              <div className="flex flex-col gap-2">
                <SettingsSelect
                  id={outputId}
                  className="@lg:w-64"
                  value={deviceSelectValue(draftLocal.outputDeviceId)}
                  onChange={(e) => patchLocal({ outputDeviceId: e.target.value })}
                >
                  <option value="">{systemDefault(outputList.defaultName)}</option>
                  <MissingDeviceOption
                    saved={outputSaved}
                    savedId={draftLocal.outputDeviceId}
                  />
                  {outputList.devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </SettingsSelect>
                {outputSaved.missing ? (
                  <SettingsNotice tone="warning">
                    {outputSaved.name
                      ? t("settings.voice.outputMissing", { name: outputSaved.name })
                      : t("settings.voice.outputMissingUnnamed")}
                  </SettingsNotice>
                ) : null}
              </div>
            ) : (
              <SettingsNotice tone="info">
                {t("settings.voice.outputUnsupported", desktopContext())}
              </SettingsNotice>
            )
          }
        />
        <VolumeRow
          id="output-volume"
          label={t("settings.voice.outputVolume")}
          value={Math.round(draftLocal.outputVolume * 100)}
          min={0}
          max={100}
          format={(percent) => t("settings.voice.percent", { percent })}
          onValueChange={(percent) => patchLocal({ outputVolume: percent / 100 })}
        />
      </SettingsGroup>

      <SettingsGroup
        // Atalhos links to "ptt". With voice activity selected there is no
        // key row, so the jump lands on the choice that brings it.
        id={voiceActivity ? "ptt" : undefined}
        title={t("settings.voice.inputMode")}
        surface="plain"
      >
        <SettingsChoiceGrid
          label={t("settings.voice.inputMode")}
          value={draftLocal.inputMode}
          onValueChange={(inputMode) => patchLocal({ inputMode })}
          columns={2}
          options={INPUT_MODES.map((mode) => {
            const Icon = INPUT_MODE_ICON[mode.value];
            return {
              value: mode.value,
              label: t(mode.label),
              description: t(mode.hint),
              preview: (
                <Icon
                  className={cn(
                    "m-1 h-5 w-5",
                    draftLocal.inputMode === mode.value
                      ? "text-accent"
                      : "text-text-tertiary",
                  )}
                />
              ),
            };
          })}
        />
      </SettingsGroup>

      {draftLocal.inputMode === "push-to-talk" ? (
        <SettingsGroup
          // Without a keyboard there is no key row, so the group is the
          // target for Atalhos' "ptt" link.
          id={canBindKey ? undefined : "ptt"}
          title={t("settings.voice.group.ptt.title")}
        >
          {canBindKey ? (
            <PttRows
              draftLocal={draftLocal}
              patchLocal={patchLocal}
              sounds={sounds}
              onBeepChange={onBeepChange}
            />
          ) : (
            <>
              <SettingsNotice tone="info" inGroup role="note">
                {t("settings.voice.pttNoKeyboard")}
              </SettingsNotice>
              <PttBeepRow
                enabled={draftLocal.pttBeep}
                soundsOn={sounds.enabled}
                onEnabledChange={onBeepChange}
              />
            </>
          )}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title={t("settings.voice.processing")}
        description={t("settings.voice.processing.note")}
      >
        <SettingsRow
          id="noise-suppression"
          label={t("settings.voice.processing.noise")}
          htmlFor={noiseId}
          badge={
            showVoiceCleanBadge ? (
              <SettingsBadge>{t("voiceClean.badge")}</SettingsBadge>
            ) : undefined
          }
          description={t(noiseHintKey[draftLocal.micProcessing.noiseSuppression])}
          control={
            <SettingsSelect
              id={noiseId}
              className="@lg:w-48"
              value={draftLocal.micProcessing.noiseSuppression}
              onChange={(e) =>
                patchLocal({
                  micProcessing: {
                    ...draftLocal.micProcessing,
                    noiseSuppression: parseNoiseSuppressionMode(e.target.value),
                  },
                })
              }
            >
              {NOISE_SUPPRESSION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(NOISE_SUPPRESSION_LABELS[mode])}
                </option>
              ))}
            </SettingsSelect>
          }
        />
        <SettingsSwitchRow
          id="echo-cancellation"
          label={t("settings.voice.processing.echo")}
          description={t("settings.voice.processing.echoHint")}
          checked={draftLocal.micProcessing.echoCancellation}
          onCheckedChange={(echoCancellation) =>
            patchLocal({
              micProcessing: { ...draftLocal.micProcessing, echoCancellation },
            })
          }
        />
        <SettingsSwitchRow
          id="auto-gain"
          label={t("settings.voice.processing.gain")}
          description={t("settings.voice.processing.gainHint")}
          checked={draftLocal.micProcessing.autoGainControl}
          onCheckedChange={(autoGainControl) =>
            patchLocal({
              micProcessing: { ...draftLocal.micProcessing, autoGainControl },
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.voice.group.video.title")}>
        <SettingsRow
          id="camera"
          label={t("settings.voice.cameraDevice")}
          htmlFor={cameraId}
          description={inCall ? t("settings.voice.cameraTestInCall") : undefined}
          stacked
          status={
            cameraTest.failed ? (
              <SettingsInlineStatus
                state={{ kind: "error", message: t("settings.voice.cameraTestFailed") }}
              />
            ) : undefined
          }
          control={
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 @lg:flex-row @lg:items-center">
                <SettingsSelect
                  id={cameraId}
                  className="min-w-0 @lg:flex-1"
                  value={draftLocal.cameraDeviceId}
                  onChange={(e) => patchLocal({ cameraDeviceId: e.target.value })}
                  onFocus={() => onRevealCameras()}
                >
                  <option value="">{t("settings.voice.systemDefault")}</option>
                  <MissingDeviceOption
                    saved={cameraSaved}
                    savedId={draftLocal.cameraDeviceId}
                  />
                  {cameraList.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </SettingsSelect>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={cn("self-start @lg:self-auto", inCall && SETTINGS_BUSY)}
                  disabled={!metering}
                  // Same as the mic test: stays focusable when a call starts.
                  aria-disabled={inCall || undefined}
                  data-camera-test=""
                  onClick={() => {
                    if (!inCall) {
                      cameraTest.toggle();
                    }
                  }}
                >
                  <Video className="h-3.5 w-3.5" aria-hidden />
                  {t(
                    cameraTest.on
                      ? "settings.voice.cameraTestStop"
                      : "settings.voice.cameraTest",
                  )}
                </Button>
              </div>
              {cameraTest.on ? <CameraPreview stream={cameraTest.stream} /> : null}
              {cameraSaved.missing ? (
                <SettingsNotice tone="warning">
                  {cameraSaved.name
                    ? t("settings.voice.cameraMissing", { name: cameraSaved.name })
                    : t("settings.voice.cameraMissingUnnamed")}
                </SettingsNotice>
              ) : null}
            </div>
          }
        >
          {showObsHint ? (
            <SettingsNotice
              tone="info"
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    dismissObsVirtualCameraHint();
                    setObsHintDismissed(true);
                    // The hint and this button go: focus the camera select.
                    window.setTimeout(() => document.getElementById(cameraId)?.focus(), 0);
                  }}
                >
                  {t("settings.voice.obsVirtualCameraHint.dismiss")}
                </Button>
              }
            >
              {t("settings.voice.obsVirtualCameraHint")}
            </SettingsNotice>
          ) : null}
        </SettingsRow>
        <SettingsRow
          id="video-quality"
          label={t("settings.voice.videoQualityRow")}
          htmlFor={qualityId}
          description={t("settings.voice.videoQuality.hint")}
          // The number beside the control that asks for it. Without this a
          // person can pick 720p, receive 320x240 and have no way to know.
          // Only in a call (spec): outside one there is nothing to measure.
          // `inCall` is the controller's status, so a listen-only join that
          // sends a camera still gets it.
          status={inCall ? <OutboundVideoReadout /> : undefined}
          control={
            <SettingsSelect
              id={qualityId}
              className="@lg:w-48"
              value={draftLocal.videoQuality}
              onChange={(e) =>
                patchLocal({ videoQuality: parseVideoQuality(e.target.value) })
              }
            >
              {VIDEO_QUALITIES.map((quality) => (
                <option key={quality} value={quality}>
                  {t(VIDEO_QUALITY_LABELS[quality])}
                </option>
              ))}
            </SettingsSelect>
          }
        />
        <SettingsRow
          id="screen-frame-rate"
          label={t("settings.voice.screenFrameRate")}
          htmlFor={frameRateId}
          description={t("settings.voice.screenFrameRate.hint")}
          control={
            <SettingsSelect
              id={frameRateId}
              className="@lg:w-48"
              value={draftLocal.screenFrameRate}
              onChange={(e) =>
                patchLocal({
                  screenFrameRate: parseScreenFrameRate(e.target.value),
                })
              }
            >
              {SCREEN_FRAME_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {t(SCREEN_FRAME_RATE_LABELS[rate])}
                </option>
              ))}
            </SettingsSelect>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.voice.group.call.title")}>
        <SettingsSwitchRow
          id="mute-on-join"
          label={t("settings.voice.muteOnJoin")}
          description={t("settings.voice.muteOnJoinHint")}
          checked={draftLocal.muteOnJoin}
          onCheckedChange={(muteOnJoin) => patchLocal({ muteOnJoin })}
        />
        <SettingsSwitchRow
          id="compact-peers"
          label={t("settings.voice.compactPeers")}
          description={t("settings.voice.compactPeersHint")}
          checked={draftLocal.compactPeers}
          onCheckedChange={(compactPeers) => patchLocal({ compactPeers })}
        />
        <SettingsSwitchRow
          id="music-auto-join"
          label={t("settings.voice.musicAutoJoin")}
          description={t("settings.voice.musicAutoJoinHint")}
          checked={musicAutoJoin}
          onCheckedChange={setMusicAutoJoin}
        />
        <SettingsSwitchRow
          id="music-duck"
          label={t("settings.voice.musicDuck")}
          description={t("settings.voice.musicDuckHint")}
          checked={musicDucking}
          onCheckedChange={setMusicDucking}
        />
        <SettingsSwitchRow
          id="auto-hide-controls"
          label={t("settings.voice.autoHideControls")}
          description={t("settings.voice.autoHideControlsHint")}
          checked={autoHideControls}
          onCheckedChange={setAutoHideStageControls}
        />
      </SettingsGroup>
    </div>
  );
}
