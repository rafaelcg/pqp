import { Camera, CameraOff, Images, RefreshCw, SwitchCamera, Video, Zap, ZapOff } from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { STORY_MAX_VIDEO_MS } from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { CameraProblem } from "@/lib/stories/camera";
import { createShutterGesture } from "@/lib/stories/shutter-gesture";
import type { CameraControls, RecorderControls } from "@/lib/stories/use-camera";
import { cn } from "@/lib/utils";
import { StoryButton } from "./composer-ui";

/**
 * The camera half of the composer. `CameraStage` is what fills the canvas (the
 * live preview, or a plain statement of why there is none), `CameraControlsRow`
 * is the shutter row under it. Both are driven by the hooks in
 * `lib/stories/use-camera.ts`, which the composer owns so the file picker and
 * the shutter can hand their result to the same place.
 */

const PROBLEM_COPY: Record<CameraProblem, { title: MessageKey; body: MessageKey }> = {
  denied: { title: "stories.camera.denied.title", body: "stories.camera.denied.body" },
  none: { title: "stories.camera.none.title", body: "stories.camera.none.body" },
  busy: { title: "stories.camera.busy.title", body: "stories.camera.busy.body" },
  insecure: { title: "stories.camera.unsupported.title", body: "stories.camera.unsupported.body" },
  unsupported: { title: "stories.camera.unsupported.title", body: "stories.camera.unsupported.body" },
  failed: { title: "stories.camera.failed.title", body: "stories.camera.failed.body" },
};

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface CameraStageProps {
  camera: CameraControls;
  recorder: RecorderControls;
  onChooseFile: () => void;
}

export const CameraStage = forwardRef<HTMLVideoElement, CameraStageProps>(function CameraStage(
  { camera, recorder, onChooseFile },
  ref,
) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement | null>(null);
  const { stream, status, mirrored } = camera;

  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    element.srcObject = stream;
    if (stream) {
      void element.play().catch(() => undefined);
    }
  }, [stream]);

  const problem =
    status === "denied" ||
    status === "none" ||
    status === "busy" ||
    status === "insecure" ||
    status === "unsupported" ||
    status === "failed"
      ? status
      : null;

  return (
    <>
      <video
        ref={(element) => {
          video.current = element;
          if (typeof ref === "function") {
            ref(element);
          } else if (ref) {
            ref.current = element;
          }
        }}
        muted
        playsInline
        autoPlay
        aria-hidden
        data-story-camera=""
        className={cn(
          "absolute inset-0 h-full w-full object-cover transition-opacity duration-[var(--duration-base)]",
          status === "live" ? "opacity-100" : "opacity-0",
        )}
        style={mirrored ? { transform: "scaleX(-1)" } : undefined}
      />
      {(status === "starting" || status === "idle") && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center"
          style={{ color: "var(--story-on-media-2)" }}
        >
          <Camera className="h-8 w-8 motion-safe:animate-pulse" aria-hidden />
          <p className="text-sm font-semibold">{t("stories.camera.starting")}</p>
        </div>
      )}
      {problem && (
        <div
          role="alert"
          data-story-camera-problem={problem}
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-[9%] text-center"
        >
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: "var(--story-field-fill)", color: "var(--story-on-media)" }}
          >
            <CameraOff className="h-6 w-6" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <p className="font-display text-lg font-extrabold leading-tight" style={{ color: "var(--story-on-media)" }}>
              {t(PROBLEM_COPY[problem].title)}
            </p>
            <p className="text-sm leading-snug" style={{ color: "var(--story-on-media-2)" }}>
              {t(PROBLEM_COPY[problem].body)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {problem !== "insecure" && problem !== "unsupported" && (
              <StoryButton variant="quiet" size="sm" onClick={camera.retry}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {t("stories.camera.retry")}
              </StoryButton>
            )}
            <StoryButton size="sm" onClick={onChooseFile}>
              <Images className="h-3.5 w-3.5" aria-hidden />
              {t("stories.compose.gallery")}
            </StoryButton>
          </div>
        </div>
      )}
      {recorder.recording && (
        <div
          role="timer"
          aria-label={t("stories.camera.recording", { seconds: Math.floor(recorder.elapsedMs / 1000) })}
          className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-bold tabular-nums"
          style={{ background: "var(--story-dim)", color: "var(--story-on-media)" }}
        >
          <span className="story-rec-dot" aria-hidden />
          {clock(recorder.elapsedMs)}
          <span className="font-medium" style={{ color: "var(--story-on-media-2)" }}>
            / {clock(STORY_MAX_VIDEO_MS)}
          </span>
        </div>
      )}
      {recorder.micMissing && !recorder.recording && (
        <p
          role="status"
          className="absolute inset-x-3 top-3 rounded-full px-3 py-1.5 text-center text-xs font-semibold"
          style={{ background: "var(--story-dim)", color: "var(--story-on-media)" }}
        >
          {t("stories.camera.noMic")}
        </p>
      )}
    </>
  );
});

interface ShutterProps {
  recording: boolean;
  elapsedMs: number;
  canRecord: boolean;
  disabled: boolean;
  onPhoto: () => void;
  onRecordStart: () => void;
  onRecordStop: () => void;
}

/**
 * Tap for a photo, hold for a video. The press is the whole gesture: a tap
 * shorter than `HOLD_TO_RECORD_MS` fires on release, a longer one starts the
 * recording at the threshold and ends it on release. Enter and Space work the
 * same way, and the record button beside it starts and stops a clip without
 * holding anything (a trackpad, a switch, a screen reader).
 */
export function Shutter({
  recording,
  elapsedMs,
  canRecord,
  disabled,
  onPhoto,
  onRecordStart,
  onRecordStop,
}: ShutterProps) {
  const { t } = useTranslation();
  const handlers = useRef({ onPhoto, onRecordStart, onRecordStop });
  handlers.current = { onPhoto, onRecordStart, onRecordStop };
  const gesture = useMemo(
    () =>
      createShutterGesture({
        onPhoto: () => handlers.current.onPhoto(),
        onRecordStart: () => handlers.current.onRecordStart(),
        onRecordStop: () => handlers.current.onRecordStop(),
      }),
    [],
  );
  gesture.setState({ canRecord, recording, disabled });
  useEffect(() => () => gesture.dispose(), [gesture]);
  const press = gesture.press;
  const release = gesture.release;

  const fraction = Math.min(1, elapsedMs / STORY_MAX_VIDEO_MS);
  const radius = 36;
  const circumference = 2 * Math.PI * radius;

  return (
    <button
      type="button"
      data-story-shutter=""
      data-recording={recording ? "true" : "false"}
      disabled={disabled}
      aria-label={t(canRecord ? "stories.camera.shutter" : "stories.camera.shutterPhoto")}
      className="story-shutter"
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault();
          press();
        }
      }}
      onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          release();
        }
      }}
    >
      <svg className="story-shutter-ring" viewBox="0 0 76 76" aria-hidden>
        <circle
          cx="38"
          cy="38"
          r={radius}
          fill="none"
          strokeWidth="4"
          style={{ stroke: recording ? "var(--story-track)" : "var(--story-on-media)" }}
        />
        {recording && (
          <circle
            cx="38"
            cy="38"
            r={radius}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            transform="rotate(-90 38 38)"
            style={{ stroke: "var(--color-danger)", transition: "stroke-dashoffset 100ms linear" }}
          />
        )}
      </svg>
      <span className="story-shutter-disc" aria-hidden />
    </button>
  );
}

interface CameraControlsRowProps {
  camera: CameraControls;
  recorder: RecorderControls;
  shutterDisabled: boolean;
  onChooseFile: () => void;
  onPhoto: () => void;
  onRecordStart: () => void;
  onRecordStop: () => void;
}

export function CameraControlsRow({
  camera,
  recorder,
  shutterDisabled,
  onChooseFile,
  onPhoto,
  onRecordStart,
  onRecordStop,
}: CameraControlsRowProps) {
  const { t } = useTranslation();
  const live = camera.status === "live";
  return (
    <div className="flex flex-col items-center gap-2.5">
      <p className="text-center text-xs font-medium" style={{ color: "var(--story-on-media-2)" }} aria-live="polite">
        {recorder.recording
          ? t("stories.camera.hintRecording")
          : recorder.supported
            ? t("stories.camera.hint")
            : t("stories.camera.hintPhotoOnly")}
      </p>
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center justify-start gap-2 pl-3">
          <button
            type="button"
            className="story-cbtn"
            data-story-gallery=""
            onClick={onChooseFile}
            disabled={recorder.recording}
            aria-label={t("stories.compose.gallery")}
          >
            <Images className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {camera.torchAvailable && live && (
            <button
              type="button"
              className="story-cbtn"
              aria-pressed={camera.torchOn}
              aria-label={t("stories.camera.torch")}
              onClick={camera.toggleTorch}
            >
              {camera.torchOn ? (
                <Zap className="h-[18px] w-[18px]" aria-hidden />
              ) : (
                <ZapOff className="h-[18px] w-[18px]" aria-hidden />
              )}
            </button>
          )}
        </div>
        <Shutter
          recording={recorder.recording}
          elapsedMs={recorder.elapsedMs}
          canRecord={recorder.supported}
          disabled={!live || shutterDisabled}
          onPhoto={onPhoto}
          onRecordStart={onRecordStart}
          onRecordStop={onRecordStop}
        />
        <div className="flex items-center justify-end gap-2 pr-3">
          {recorder.supported && (
            <button
              type="button"
              className="story-cbtn"
              data-story-record=""
              aria-pressed={recorder.recording}
              aria-label={t(recorder.recording ? "stories.camera.recordStop" : "stories.camera.record")}
              disabled={!live || shutterDisabled}
              onClick={recorder.recording ? onRecordStop : onRecordStart}
            >
              <Video className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
          {camera.canFlip && (
            <button
              type="button"
              className="story-cbtn"
              data-story-flip=""
              aria-label={t("stories.camera.flip")}
              disabled={!live || recorder.recording}
              onClick={camera.flip}
            >
              <SwitchCamera className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
