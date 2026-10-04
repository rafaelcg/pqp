import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Keyboard, Mic, Square, Volume2, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
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
  SettingsSliderRow,
  SettingsSwitchRow,
} from "@/components/settings/kit";
import { ACTION_LABEL } from "@/components/layout/shortcut-overlay";
import { findBindingConflict } from "@/lib/keyboard-shortcuts";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { dismissObsVirtualCameraHint, isObsVirtualCameraHintDismissed, isObsVirtualCameraLabel } from "@/lib/obs-virtual-camera";
import { parseVideoQuality, VIDEO_QUALITIES, type VideoQuality } from "@/lib/video-quality";
import { parseScreenFrameRate, SCREEN_FRAME_RATES, type ScreenFrameRate } from "@/lib/hls-capture-rate";
import { bindingTypesText, formatBinding, supportsKeyBinding } from "@/components/voice/push-to-talk";
import { clampReleaseDelayMs, MAX_RELEASE_DELAY_MS } from "@/lib/ptt-release-delay";
import { PttBindingField } from "@/components/voice/key-binding-field";
import { getPttReleaseStuck, subscribePttReleaseStuck } from "@/components/voice/shell-unbind";
import { pttHintMessageKey, usePttNativeSupport } from "@/lib/ptt-native-support";
import type { VoiceInputMode } from "@/hooks/use-voice";
import { parseVadThreshold } from "@/lib/voice-audio";
import {
  applyAudioOutputDevice,
  buildAudioConstraints,
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
import { setMusicAutoJoin, setMusicDucking, useMusicAutoJoin, useMusicDucking } from "@/lib/music-prefs";
import { getSoundState, previewPttBeeps, setPttBeepEnabled, subscribeSounds, type SoundState } from "@/lib/sounds";
import { requestConnectionCheck } from "@/lib/settings-request";
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

  const release = () => {
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
    const gain = context.createGain();
    gain.gain.value = Math.min(2, Math.max(0, options.inputVolume));
    const destination = context.createMediaStreamDestination();
    connectMicChain({ source, suppressor, gain });
    gain.connect(destination);

    const element = deps.createAudio();
    audio = element;
    element.srcObject = destination.stream;
    element.volume = Math.min(1, Math.max(0, options.outputVolume));
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

  return { stop, ready };
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
  const handle = useRef<MicLoopback | null>(null);
  // Loops somebody (or the hook) stopped on purpose. A permission prompt that
  // rejects after Parar was pressed is not a failure to report.
  const stoppedOnPurpose = useRef(new WeakSet<MicLoopback>());

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
    const loop = startMicLoopback({
      ...options,
      onEnd: () => {
        if (handle.current === loop) {
          handle.current = null;
        }
        setPlaying(false);
      },
    });
    handle.current = loop;
    loop.ready.catch(() => {
      if (!stoppedOnPurpose.current.has(loop)) {
        setFailed(true);
      }
    });
  };

  return { playing, failed, start, stop };
}

/* ------------------------------------------------------------ no devices */

/**
 * How long an empty microphone list has to stay empty before Voz says there
 * is no microphone. The list starts empty while the shell asks for permission
 * and enumerates, so an immediate notice would flash on every visit.
 */
export const NO_INPUTS_SETTLE_MS = 1500;

function useNoInputsSettled(empty: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!empty) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), NO_INPUTS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [empty]);
  return empty && settled;
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
 * voice-activity sensitivity marker: a 2px line drawn on the meter, with an
 * invisible `Slider` stretched over the whole 24px strip so anywhere on it is
 * the grab target, and the arrow keys move it.
 */
function MicLevelMeter({
  level,
  inputVolume,
  threshold,
  onThresholdChange,
}: {
  level: number;
  inputVolume: number;
  threshold?: number;
  onThresholdChange?: (value: number) => void;
}) {
  const { t } = useTranslation();
  const gated = threshold !== undefined && onThresholdChange !== undefined;
  const levelPct = Math.round(level * 100);
  const thresholdPct =
    threshold !== undefined
      ? Math.round(displayMicLevel(threshold, inputVolume) * 100)
      : 0;

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "relative h-6 rounded-[var(--radius-control)]",
          gated &&
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-ring-offset",
        )}
      >
        <div
          role="progressbar"
          aria-label={t("settings.voice.inputLevel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={levelPct}
          className="absolute inset-x-0 top-1.5 h-3 overflow-hidden rounded-full border border-border bg-surface-0"
        >
          <div
            className="h-full rounded-full bg-success transition-[width] duration-75"
            style={{ width: `${levelPct}%` }}
          />
        </div>
        {gated ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-text"
              style={{ left: `${thresholdPct}%` }}
            />
            <Slider
              variant="volume"
              className="absolute inset-0 h-6 cursor-ew-resize opacity-0"
              value={thresholdPct}
              min={0}
              max={100}
              step={1}
              aria-label={t("settings.voice.sensitivity")}
              aria-valuetext={t("settings.voice.percent", {
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
          className="flex justify-between text-xs text-text-tertiary"
        >
          <span>{t("settings.voice.sensitivityMore")}</span>
          <span>{t("settings.voice.sensitivityLess")}</span>
        </div>
      ) : null}
    </div>
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
      description={t("settings.voice.pttBeepHint")}
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
 * `PttBindingField` draws its own small label above the button; the row
 * already names it, so that one is hidden visually and kept for the field's
 * own layout. Atalhos (feat/settings-keyboard) rebuilds the field with an
 * sr-only label and the button first, which makes the wrapper's selector
 * match nothing; delete the wrapper when the two branches meet.
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
  const typesText =
    draftLocal.pushToTalkKey.device === "keyboard" &&
    bindingTypesText(draftLocal.pushToTalkKey);

  return (
    <>
      <SettingsRow
        id="ptt"
        label={keyLabel}
        description={t(hintKey, { key: formatBinding(draftLocal.pushToTalkKey) })}
        control={
          <div className="[&>div>span:first-child]:sr-only">
            <PttBindingField
              label={keyLabel}
              binding={draftLocal.pushToTalkKey}
              allowMouse={isDesktop}
              takenBy={(binding) => {
                if (binding.device === "mouse") {
                  // A mouse button cannot collide with a keyboard-only app
                  // shortcut. See the note on `PttBinding` in push-to-talk.ts.
                  return null;
                }
                const conflict = findBindingConflict(
                  bindableMap(draftLocal),
                  "pushToTalk",
                  binding,
                );
                return conflict ? t(ACTION_LABEL[conflict]) : null;
              }}
              onChange={(pushToTalkKey) => patchLocal({ pushToTalkKey })}
            />
          </div>
        }
      />

      {typesText ? (
        <SettingsNotice tone="info" inGroup>
          {t("settings.voice.pttTypingNote", {
            key: formatBinding(draftLocal.pushToTalkKey),
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
        <SettingsSliderRow
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
  voiceAnalyser,
  metering,
  showVoiceCleanBadge,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
  cameras: MediaDeviceOption[];
  onRevealCameras: () => void;
  devicesError: string | null;
  voiceAnalyser: AnalyserNode | null;
  metering: boolean;
  /** NOVO chip on the noise-suppression row; see `lib/voice-clean.ts`. */
  showVoiceCleanBadge: boolean;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const musicAutoJoin = useMusicAutoJoin();
  const musicDucking = useMusicDucking();
  const canSelectOutput = supportsAudioOutputSelection();
  const sounds = useSyncExternalStore(subscribeSounds, getSoundState, getSoundState);
  // Probed once: whether this machine has a keyboard worth binding does not
  // change while the dialog is open, and re-evaluating it per render would run
  // a media query on every slider tick.
  const canBindKey = useMemo(() => supportsKeyBinding(), []);
  const [obsHintDismissed, setObsHintDismissed] = useState(
    isObsVirtualCameraHintDismissed,
  );
  // In a call the meter reads the call's own analyser and opens nothing.
  const micLevel = useMicLevel({
    deviceId: draftLocal.inputDeviceId,
    inputVolume: draftLocal.inputVolume,
    liveAnalyser: voiceAnalyser,
    active: metering,
  });
  const voiceActivity = draftLocal.inputMode === "voice-activity";
  // The analyser alone is not the signal: a listen-only join (no mic, or the
  // mic refused) and an audience seat are in the call with no pipeline. The
  // voice controller's own status covers both; the analyser covers a test
  // harness that renders this tab without `App`.
  const inCall = useInCall() || voiceAnalyser !== null;
  // Never a second capture during a call, and never the mic played into the
  // speakers a live call is listening through.
  const micTest = useMicTest(metering && !inCall);
  const noInputs = useNoInputsSettled(
    metering && devicesError === null && inputs.length === 0,
  );

  const onBeepChange = (pttBeep: boolean) => {
    setPttBeepEnabled(pttBeep);
    patchLocal({ pttBeep });
  };

  const showObsHint =
    !obsHintDismissed &&
    isObsVirtualCameraLabel(
      cameras.find((device) => device.deviceId === draftLocal.cameraDeviceId)
        ?.label ?? "",
    );

  const inputId = `${ids}-input`;
  const outputId = `${ids}-output`;
  const noiseId = `${ids}-noise`;
  const cameraId = `${ids}-camera`;
  const qualityId = `${ids}-quality`;
  const frameRateId = `${ids}-fps`;

  return (
    <div className="space-y-6">
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
          htmlFor={devicesError || noInputs ? undefined : inputId}
          description={
            inCall && !devicesError && !noInputs
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
            devicesError ? (
              <SettingsNotice tone="warning">{devicesError}</SettingsNotice>
            ) : noInputs ? (
              <SettingsNotice tone="info">{t("settings.voice.noInputs")}</SettingsNotice>
            ) : (
              <div className="flex flex-col gap-2 @lg:flex-row @lg:items-center">
                <SettingsSelect
                  id={inputId}
                  className="min-w-0 @lg:flex-1"
                  value={draftLocal.inputDeviceId}
                  onChange={(e) => patchLocal({ inputDeviceId: e.target.value })}
                >
                  <option value="">{t("settings.voice.systemDefault")}</option>
                  {inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </SettingsSelect>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start @lg:self-auto"
                  disabled={!metering || inCall}
                  data-mic-test=""
                  onClick={() =>
                    micTest.playing
                      ? micTest.stop()
                      : micTest.start({
                          deviceId: draftLocal.inputDeviceId,
                          processing: draftLocal.micProcessing,
                          inputVolume: draftLocal.inputVolume,
                          outputDeviceId: canSelectOutput
                            ? draftLocal.outputDeviceId
                            : "",
                          outputVolume: draftLocal.outputVolume,
                        })
                  }
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
                  <span className="grid">
                    <span className="col-start-1 row-start-1">
                      {t(
                        micTest.playing
                          ? "settings.voice.micTestStop"
                          : "settings.voice.micTest",
                      )}
                    </span>
                    <span aria-hidden className="invisible col-start-1 row-start-1">
                      {t(
                        micTest.playing
                          ? "settings.voice.micTest"
                          : "settings.voice.micTestStop",
                      )}
                    </span>
                  </span>
                </Button>
              </div>
            )
          }
        />

        <SettingsSliderRow
          id="input-volume"
          label={t("settings.voice.inputVolume")}
          value={Math.round(draftLocal.inputVolume * 100)}
          min={0}
          max={200}
          format={(percent) => t("settings.voice.percent", { percent })}
          onValueChange={(percent) => patchLocal({ inputVolume: percent / 100 })}
        />

        <SettingsRow
          id={voiceActivity ? "sensitivity" : "input-level"}
          label={t(
            voiceActivity ? "settings.voice.sensitivity" : "settings.voice.inputLevel",
          )}
          description={voiceActivity ? t("settings.voice.sensitivityHint") : undefined}
          stacked
          control={
            // Not decorative: the sensitivity handle is operated in place.
            // The meter names its progress bar and slider itself and hides
            // the captions.
            <SettingsPreview decorative={false}>
              <div className="px-3 py-2">
                <MicLevelMeter
                  level={micLevel}
                  inputVolume={draftLocal.inputVolume}
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
          stacked={!canSelectOutput}
          control={
            canSelectOutput ? (
              <SettingsSelect
                id={outputId}
                className="@lg:w-64"
                value={draftLocal.outputDeviceId}
                onChange={(e) => patchLocal({ outputDeviceId: e.target.value })}
              >
                <option value="">{t("settings.voice.systemDefault")}</option>
                {outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </SettingsSelect>
            ) : (
              <SettingsNotice tone="info">
                {t("settings.voice.outputUnsupported", desktopContext())}
              </SettingsNotice>
            )
          }
        />
        <SettingsSliderRow
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
          description={t(
            draftLocal.micProcessing.noiseSuppression === "advanced"
              ? "settings.voice.processing.noise.advancedHint"
              : "settings.voice.processing.noiseHint",
          )}
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
          control={
            <SettingsSelect
              id={cameraId}
              className="@lg:w-64"
              value={draftLocal.cameraDeviceId}
              onChange={(e) => patchLocal({ cameraDeviceId: e.target.value })}
              onFocus={() => onRevealCameras()}
            >
              <option value="">{t("settings.voice.systemDefault")}</option>
              {cameras.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </SettingsSelect>
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
          label={t("settings.voice.videoQuality")}
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
          checked={draftLocal.muteOnJoin}
          onCheckedChange={(muteOnJoin) => patchLocal({ muteOnJoin })}
        />
        <SettingsSwitchRow
          id="compact-peers"
          label={t("settings.voice.compactPeers")}
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
          checked={musicDucking}
          onCheckedChange={setMusicDucking}
        />
      </SettingsGroup>
    </div>
  );
}
