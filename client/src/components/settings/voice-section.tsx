import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ACTION_LABEL } from "@/components/layout/shortcut-overlay";
import { findBindingConflict } from "@/lib/keyboard-shortcuts";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { ObsVirtualCameraHint } from "@/components/voice/obs-virtual-camera-hint";
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
import { supportsAudioOutputSelection, type MediaDeviceOption } from "@/lib/audio-devices";
import { NOISE_SUPPRESSION_MODES, parseNoiseSuppressionMode, type NoiseSuppressionMode } from "../../lib/noise-suppression";
import { desktopContext, isDesktopApp } from "@/lib/desktop";
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
  threshold,
  onThresholdChange,
}: {
  deviceId: string;
  inputVolume: number;
  liveAnalyser: AnalyserNode | null;
  active: boolean;
  /** When set, the meter also hosts the voice-activity sensitivity line. */
  threshold?: number;
  onThresholdChange?: (value: number) => void;
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

  const label = t("settings.voice.inputLevel");
  const gated = threshold !== undefined && onThresholdChange !== undefined;
  const thresholdPct =
    threshold !== undefined
      ? Math.round(displayMicLevel(threshold, inputVolume) * 100)
      : 0;

  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        {gated ? t("settings.voice.sensitivity") : label}
      </span>
      <div
        className={cn(
          "relative h-2 rounded-full",
          gated && "has-[:focus]:ring-2 has-[:focus]:ring-signal/60",
        )}
      >
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
        {gated && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute top-[-3px] h-[14px] w-1 -translate-x-1/2 rounded-full bg-paper"
              style={{ left: `${thresholdPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={thresholdPct}
              onChange={(e) =>
                onThresholdChange?.(
                  sliderToVadThreshold(Number(e.target.value), inputVolume),
                )
              }
              className="absolute -inset-y-2 inset-x-0 w-full cursor-pointer opacity-0"
              aria-label={t("settings.voice.sensitivity")}
              aria-valuetext={t("settings.voice.percent", {
                percent: thresholdPct,
              })}
            />
          </>
        )}
      </div>
      {gated && (
        <span className="block text-xs text-paper-muted">
          {t("settings.voice.sensitivityHint")}
        </span>
      )}
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

/**
 * The two that are still yes-or-no. Noise suppression left this list when it
 * grew a third setting; it gets a select of its own below.
 */
const MIC_PROCESSING_OPTIONS: {
  key: "echoCancellation" | "autoGainControl";
  label: MessageKey;
  description: MessageKey;
}[] = [
  {
    key: "echoCancellation",
    label: "settings.voice.processing.echo",
    description: "settings.voice.processing.echoHint",
  },
  {
    key: "autoGainControl",
    label: "settings.voice.processing.gain",
    description: "settings.voice.processing.gainHint",
  },
];

/** Labels for the three suppressors, in the order the select offers them. */
const NOISE_SUPPRESSION_LABELS: Record<NoiseSuppressionMode, MessageKey> = {
  off: "settings.voice.processing.noise.off",
  browser: "settings.voice.processing.noise.browser",
  advanced: "settings.voice.processing.noise.advanced",
};

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
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{t("settings.voice.pttBeep")}</span>
        <span className="block text-xs text-paper-muted">
          {t("settings.voice.pttBeepHint")}
        </span>
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!soundsOn || !enabled}
        onClick={(event) => {
          event.preventDefault();
          previewPttBeeps();
        }}
      >
        {t("settings.voice.pttBeepTest")}
      </Button>
    </label>
  );
}

/**
 * macOS-only: shown while `usePttNativeSupport().permission === "denied"`.
 * macOS never re-prompts once Accessibility/Input Monitoring have been said
 * no to (or simply never granted), so the only way back is Settings. This
 * is the deep link, not a native system dialog we do not have a way to
 * trigger reliably ourselves. See `MAC_ACCESSIBILITY_SETTINGS_URL` /
 * `MAC_INPUT_MONITORING_SETTINGS_URL` in `electron/lib/native-ptt-hook.js`.
 */
function PttPermissionNudge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5"
    >
      <p className="text-sm font-medium">{t("settings.voice.pttPermissionTitle")}</p>
      <p className="text-xs text-paper-muted">{t("settings.voice.pttPermissionBody")}</p>
      <Button type="button" size="sm" variant="secondary" onClick={onOpenSettings}>
        {t("settings.voice.pttPermissionOpenSettings")}
      </Button>
    </div>
  );
}

/**
 * The push-to-talk binding, its release delay (desktop only) and the
 * "works everywhere on this computer" hint, sized to whatever this shell
 * can actually do. Split out of `VoiceSection` because the desktop-only
 * pieces (release delay, the permission nudge, the native-vs-fallback hint)
 * need `usePttNativeSupport`'s state and that state has nothing to say on
 * the web build.
 */
function PttControls({
  draftLocal,
  patchLocal,
  sounds,
}: {
  draftLocal: LocalSettings;
  patchLocal: (partial: Partial<LocalSettings>) => void;
  sounds: SoundState;
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

  return (
    <div className="space-y-3">
      <PttBindingField
        label={t(isDesktop ? "settings.voice.pttKeyOrMouse" : "settings.voice.pttKey")}
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

      {isDesktop && native.available && (
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.voice.pttReleaseDelay")}
          </span>
          <input
            type="range"
            min={0}
            max={MAX_RELEASE_DELAY_MS}
            step={10}
            value={draftLocal.pttReleaseDelayMs}
            onChange={(e) =>
              patchLocal({
                pttReleaseDelayMs: clampReleaseDelayMs(Number(e.target.value)),
              })
            }
            className="w-full accent-[var(--color-signal)]"
          />
          <span className="mt-0.5 block text-xs text-paper-muted">
            {t("settings.voice.pttReleaseDelayMs", { ms: draftLocal.pttReleaseDelayMs })}
          </span>
          <span className="mt-0.5 block text-xs text-paper-muted">
            {t("settings.voice.pttReleaseDelayHint")}
          </span>
        </label>
      )}

      {isDesktop && (
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[var(--color-signal)]"
            checked={draftLocal.pttGlobal}
            onChange={(e) => patchLocal({ pttGlobal: e.target.checked })}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{t("settings.voice.pttGlobal")}</span>
            <span className="block text-xs text-paper-muted">
              {t("settings.voice.pttGlobalHint")}
            </span>
          </span>
        </label>
      )}

      <PttBeepRow
        enabled={draftLocal.pttBeep}
        soundsOn={sounds.enabled}
        onEnabledChange={(pttBeep) => {
          setPttBeepEnabled(pttBeep);
          patchLocal({ pttBeep });
        }}
      />

      {isDesktop && releaseStuck && (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        >
          {t("settings.voice.pttGlobalReleaseFailed")}
        </p>
      )}

      {isDesktop && draftLocal.pttGlobal && native.permission === "denied" && (
        <PttPermissionNudge onOpenSettings={native.openSettings} />
      )}

      {/* The honest limit, stated where the binding is set rather than
          discovered later by talking to nobody. */}
      <p className="text-xs text-paper-muted">
        {t(hintKey, { key: formatBinding(draftLocal.pushToTalkKey) })}
        {!isDesktop && (
          <>
            {" "}
            <a
              href="/download"
              target="_blank"
              rel="noopener"
              className="text-accent underline underline-offset-2"
            >
              {t("settings.voice.pttGetDesktop")}
            </a>
          </>
        )}
      </p>
      {draftLocal.pushToTalkKey.device === "keyboard" &&
        bindingTypesText(draftLocal.pushToTalkKey) && (
          <p className="text-xs text-paper-muted">
            {t("settings.voice.pttTypingNote", {
              key: formatBinding(draftLocal.pushToTalkKey),
            })}
          </p>
        )}
    </div>
  );
}

/**
 * Devices, levels, input mode and microphone processing.
 *
 * Everything here applies live rather than on Save — the same behaviour it had
 * in the single column, kept because a level you cannot hear while you set it
 * is a level you set twice.
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
  /** NOVO dot on the noise-suppression row; see `lib/voice-clean.ts`. */
  showVoiceCleanBadge: boolean;
}) {
  const { t } = useTranslation();
  const musicAutoJoin = useMusicAutoJoin();
  const musicDucking = useMusicDucking();
  const canSelectOutput = supportsAudioOutputSelection();
  const checkConnection = () => requestConnectionCheck();
  const sounds = useSyncExternalStore(subscribeSounds, getSoundState, getSoundState);
  // Probed once: whether this machine has a keyboard worth binding does not
  // change while the dialog is open, and re-evaluating it per render would run
  // a media query on every slider tick.
  const canBindKey = useMemo(() => supportsKeyBinding(), []);
  const [obsHintDismissed, setObsHintDismissed] = useState(
    isObsVirtualCameraHintDismissed,
  );
  const selectClass =
    "h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper outline-none focus:border-signal";

  return (
    <div className="space-y-5">
      {devicesError && (
        <p className="text-xs text-warning" role="status">
          {devicesError}
        </p>
      )}

      {/* The way out of "stuck on connecting": five checks and the fix. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-4 bg-ink-3/40 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-paper-muted">
          {t("connection.checkHint")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={checkConnection}
          data-settings-check-connection
        >
          {t("connection.check")}
        </Button>
      </div>

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
        threshold={
          draftLocal.inputMode === "voice-activity"
            ? draftLocal.vadThreshold
            : undefined
        }
        onThresholdChange={
          draftLocal.inputMode === "voice-activity"
            ? (vadThreshold) => patchLocal({ vadThreshold })
            : undefined
        }
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
          <PttControls draftLocal={draftLocal} patchLocal={patchLocal} sounds={sounds} />
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs text-paper-muted">
              {t("settings.voice.pttNoKeyboard")}
            </p>
            <PttBeepRow
              enabled={draftLocal.pttBeep}
              soundsOn={sounds.enabled}
              onEnabledChange={(pttBeep) => {
                setPttBeepEnabled(pttBeep);
                patchLocal({ pttBeep });
              }}
            />
          </div>
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
        <label className="block">
          <span className="mb-1 flex items-center gap-2 text-sm">
            {t("settings.voice.processing.noise")}
            {showVoiceCleanBadge && (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">
                {t("voiceClean.badge")}
              </span>
            )}
          </span>
          <select
            value={draftLocal.micProcessing.noiseSuppression}
            onChange={(e) =>
              patchLocal({
                micProcessing: {
                  ...draftLocal.micProcessing,
                  noiseSuppression: parseNoiseSuppressionMode(e.target.value),
                },
              })
            }
            className={selectClass}
          >
            {NOISE_SUPPRESSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(NOISE_SUPPRESSION_LABELS[mode])}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-paper-muted">
            {t(
              draftLocal.micProcessing.noiseSuppression === "advanced"
                ? "settings.voice.processing.noise.advancedHint"
                : "settings.voice.processing.noiseHint",
            )}
          </span>
        </label>
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
            {t("settings.voice.cameraDevice")}
          </span>
          <select
            value={draftLocal.cameraDeviceId}
            onChange={(e) => patchLocal({ cameraDeviceId: e.target.value })}
            onFocus={() => onRevealCameras()}
            className={selectClass}
          >
            <option value="">{t("settings.voice.systemDefault")}</option>
            {cameras.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
        <ObsVirtualCameraHint
          show={
            !obsHintDismissed &&
            isObsVirtualCameraLabel(
              cameras.find(
                (device) => device.deviceId === draftLocal.cameraDeviceId,
              )?.label ?? "",
            )
          }
          onDismiss={() => {
            dismissObsVirtualCameraHint();
            setObsHintDismissed(true);
          }}
        />
      </div>

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

      <div>
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.voice.screenFrameRate")}
          </span>
          <select
            value={draftLocal.screenFrameRate}
            onChange={(e) =>
              patchLocal({
                screenFrameRate: parseScreenFrameRate(e.target.value),
              })
            }
            className={selectClass}
          >
            {SCREEN_FRAME_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {t(SCREEN_FRAME_RATE_LABELS[rate])}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-paper-muted">
          {t("settings.voice.screenFrameRate.hint")}
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
      <Switch
        checked={musicAutoJoin}
        onCheckedChange={setMusicAutoJoin}
        label={t("settings.voice.musicAutoJoin")}
        description={t("settings.voice.musicAutoJoinHint")}
        className="px-0"
      />
      <Switch
        checked={musicDucking}
        onCheckedChange={setMusicDucking}
        label={t("settings.voice.musicDuck")}
        description={t("settings.voice.musicDuckHint")}
        className="px-0"
      />
    </div>
  );
}
