import { formatNoteDuration } from "@pqp/shared";
import {
  ArrowUp,
  ChevronLeft,
  ChevronUp,
  Headphones,
  Loader2,
  Lock,
  Mic,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { loadLocalSettings } from "@/components/layout/settings-modal";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import {
  AttachmentAbortError,
  createPreviewUrl,
  loadVoiceNotesEnabled,
  revokePreviewUrl,
  uploadAttachment,
  type OutgoingAttachment,
} from "@/lib/attachments";
import { desktopContext } from "@/lib/desktop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pauseVoiceNote } from "@/lib/voice-note-player";
import {
  VoiceNoteError,
  VoiceNoteRecorder,
  canRecordVoiceNotes,
  type RecordedVoiceNote,
} from "@/lib/voice-note-recorder";

/**
 * The composer's half of voice notes, WhatsApp's muscle memory:
 *
 * - With nothing typed, the send button is a mic.
 * - Touch: hold to record, let go to send, slide left to cancel, slide up to
 *   lock (then pause, listen first, send).
 * - Mouse or keyboard: a click records, locked from the start. Esc discards,
 *   Enter sends.
 * - A discard can be undone for five seconds.
 */

/** Slide this far left to cancel a held recording. */
const CANCEL_SLIDE_PX = 96;
/** Slide this far up to lock it. */
const LOCK_SLIDE_PX = 72;
/** A touch shorter than this is a tap, not a recording. */
const TAP_MS = 350;
const UNDO_MS = 5000;
/** Live bars drawn while recording, newest on the right. */
const LIVE_BARS = 96;

export type VoiceNotePhase =
  | { kind: "idle" }
  | { kind: "starting"; mode: "hold" | "locked" }
  | { kind: "recording"; mode: "hold" | "locked"; paused: boolean }
  | { kind: "review"; note: RecordedVoiceNote }
  | { kind: "sending"; note: RecordedVoiceNote; progress: number };

interface Options {
  channelId: string | null;
  serverId: string | null;
  /** False keeps the mic away entirely (stream chat, a disabled composer). */
  allowed: boolean;
  onSend: (body: string, attachments: OutgoingAttachment[]) => void;
  /** Errors and hints land in the composer's own feedback strip. */
  onFeedback: (tone: "error" | "info", message: string) => void;
  /** Back to typing: the composer puts the caret back in the field. */
  onDone: () => void;
}

const ERROR_KEYS: Record<VoiceNoteError["code"], MessageKey> = {
  "mic-blocked": "voiceNote.error.micBlocked",
  "mic-missing": "voiceNote.error.micMissing",
  "mic-busy": "voiceNote.error.micBusy",
  unsupported: "voiceNote.error.unsupported",
  "too-short": "voiceNote.error.tooShort",
  "too-large": "voiceNote.error.tooLarge",
  failed: "voiceNote.error.failed",
};

export interface VoiceNoteController {
  available: boolean;
  phase: VoiceNotePhase;
  /** Recorded time, live while recording. */
  elapsedMs: number;
  levels: number[];
  /** Touch slide offsets while holding, for the cancel hint. */
  slide: { x: number; y: number };
  undo: { durationMs: number } | null;
  startLocked: () => void;
  micPointerHandlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onClick: () => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
  };
  togglePause: () => void;
  review: () => void;
  discard: () => void;
  send: () => void;
  restore: () => void;
}

export function useVoiceNoteComposer(options: Options): VoiceNoteController {
  const { t } = useTranslation();
  const [flagOn, setFlagOn] = useState(false);
  const [phase, setPhaseState] = useState<VoiceNotePhase>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [slide, setSlide] = useState({ x: 0, y: 0 });
  const [undoNote, setUndoNote] = useState<RecordedVoiceNote | null>(null);
  const recorderRef = useRef<VoiceNoteRecorder | null>(null);
  const phaseRef = useRef<VoiceNotePhase>(phase);
  const gestureRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    at: number;
    released: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const uploadRef = useRef<AbortController | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setPhase = useCallback((next: VoiceNotePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const { channelId, serverId, allowed } = options;
  useEffect(() => {
    if (!allowed || !channelId || !canRecordVoiceNotes()) {
      setFlagOn(false);
      return;
    }
    let active = true;
    void loadVoiceNotesEnabled(serverId).then((on) => {
      if (active) {
        setFlagOn(on);
      }
    });
    return () => {
      active = false;
    };
  }, [allowed, channelId, serverId]);

  // Leaving the channel (the composer remounts per channel) ends a recording:
  // the mic must not stay open for a conversation nobody is looking at.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      uploadRef.current?.abort();
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    },
    [],
  );

  const reportError = useCallback(
    (error: unknown) => {
      const code = error instanceof VoiceNoteError ? error.code : "failed";
      optionsRef.current.onFeedback(
        "error",
        code === "mic-blocked"
          ? t("voiceNote.error.micBlocked", desktopContext())
          : t(ERROR_KEYS[code]),
      );
    },
    [t],
  );

  const finishToReview = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      return null;
    }
    try {
      const note = await recorder.stop();
      setPhase({ kind: "review", note });
      return note;
    } catch (error) {
      setPhase({ kind: "idle" });
      reportError(error);
      optionsRef.current.onDone();
      return null;
    }
  }, [reportError, setPhase]);

  const upload = useCallback(
    async (note: RecordedVoiceNote) => {
      const target = optionsRef.current.channelId;
      if (!target) {
        return;
      }
      setPhase({ kind: "sending", note, progress: 0 });
      const controller = new AbortController();
      uploadRef.current = controller;
      try {
        const uploaded = await uploadAttachment(
          target,
          {
            file: new File([note.blob], note.filename, { type: note.contentType }),
            filename: note.filename,
            contentType: note.contentType,
          },
          {
            signal: controller.signal,
            voice: { durationMs: note.durationMs, waveform: note.waveform },
            onProgress: (progress) => {
              if (phaseRef.current.kind === "sending") {
                setPhase({ kind: "sending", note, progress });
              }
            },
          },
        );
        optionsRef.current.onSend("", [
          {
            attachmentId: uploaded.attachmentId,
            filename: note.filename,
            contentType: note.contentType,
            byteSize: note.blob.size,
            width: null,
            height: null,
            previewUrl: createPreviewUrl(note.blob),
            voice: { durationMs: note.durationMs, waveform: note.waveform },
          },
        ]);
        setPhase({ kind: "idle" });
        optionsRef.current.onDone();
      } catch (error) {
        if (error instanceof AttachmentAbortError) {
          return;
        }
        // Back to the review, note intact, so Send can be pressed again.
        setPhase({ kind: "review", note });
        const key: MessageKey =
          error instanceof ApiError && error.status === 403
            ? "voiceNote.error.disabled"
            : error instanceof ApiError && error.status === 413
              ? "voiceNote.error.tooLarge"
              : "voiceNote.error.upload";
        optionsRef.current.onFeedback("error", t(key));
      } finally {
        if (uploadRef.current === controller) {
          uploadRef.current = null;
        }
      }
    },
    [setPhase, t],
  );

  const start = useCallback(
    async (mode: "hold" | "locked") => {
      if (phaseRef.current.kind !== "idle") {
        return;
      }
      clearUndo();
      pauseVoiceNote();
      setElapsedMs(0);
      setLevels([]);
      setSlide({ x: 0, y: 0 });
      setPhase({ kind: "starting", mode });
      const settings = loadLocalSettings();
      let recorder: VoiceNoteRecorder;
      try {
        recorder = new VoiceNoteRecorder({
          deviceId: settings.inputDeviceId,
          processing: settings.micProcessing,
          onLevel: () => {
            const live = recorderRef.current;
            if (!live) {
              return;
            }
            setElapsedMs(live.elapsedMs());
            setLevels(live.livePeaks().slice(-LIVE_BARS));
          },
          onCap: () => {
            optionsRef.current.onFeedback("info", t("voiceNote.capReached"));
            void finishToReview();
          },
        });
      } catch (error) {
        setPhase({ kind: "idle" });
        reportError(error);
        return;
      }
      recorderRef.current = recorder;
      try {
        await recorder.start();
      } catch (error) {
        recorderRef.current = null;
        setPhase({ kind: "idle" });
        reportError(error);
        optionsRef.current.onDone();
        return;
      }
      if (recorderRef.current !== recorder) {
        return;
      }
      // Released while the permission prompt was up: that hold is over.
      if (mode === "hold" && gestureRef.current?.released !== false) {
        recorder.cancel();
        recorderRef.current = null;
        setPhase({ kind: "idle" });
        optionsRef.current.onFeedback("info", t("voiceNote.recordHold"));
        return;
      }
      setPhase({ kind: "recording", mode, paused: false });
    },
    [finishToReview, reportError, setPhase, t],
  );

  function clearUndo() {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoNote(null);
  }

  const discard = useCallback(async () => {
    const current = phaseRef.current;
    let note: RecordedVoiceNote | null = null;
    if (current.kind === "recording" || current.kind === "starting") {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && current.kind === "recording") {
        note = await recorder.stop().catch(() => null);
      } else {
        recorder?.cancel();
      }
    } else if (current.kind === "review") {
      note = current.note;
    } else if (current.kind === "sending") {
      uploadRef.current?.abort();
      note = current.note;
    }
    setPhase({ kind: "idle" });
    optionsRef.current.onDone();
    if (note) {
      setUndoNote(note);
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        setUndoNote(null);
      }, UNDO_MS);
    }
  }, [setPhase]);

  const send = useCallback(async () => {
    const current = phaseRef.current;
    if (current.kind === "recording") {
      const note = await finishToReview();
      if (note) {
        await upload(note);
      }
      return;
    }
    if (current.kind === "review") {
      await upload(current.note);
    }
  }, [finishToReview, upload]);

  const togglePause = useCallback(() => {
    const current = phaseRef.current;
    const recorder = recorderRef.current;
    if (current.kind !== "recording" || !recorder) {
      return;
    }
    if (current.paused) {
      recorder.resume();
    } else {
      recorder.pause();
    }
    setPhase({ ...current, paused: recorder.isPaused });
  }, [setPhase]);

  const review = useCallback(() => {
    if (phaseRef.current.kind === "recording") {
      void finishToReview();
    }
  }, [finishToReview]);

  const restore = useCallback(() => {
    if (!undoNote || phaseRef.current.kind !== "idle") {
      return;
    }
    const note = undoNote;
    clearUndo();
    setPhase({ kind: "review", note });
  }, [setPhase, undoNote]);

  // Esc discards and Enter sends, wherever focus is inside the app, as long
  // as it is not in somebody else's text field or an open dialog. A focused
  // button in the panel answers Enter itself. Capture phase, on the window:
  // a tooltip open on the focused control eats Escape at the document.
  const isActive = phase.kind === "recording" || phase.kind === "review" || phase.kind === "starting";
  useEffect(() => {
    if (!isActive) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.isComposing) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[role='dialog'], [role='alertdialog'], [role='menu']")) {
        return;
      }
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      if (typing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void discard();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        if (target?.closest("button, a, [role='slider']")) {
          return;
        }
        event.preventDefault();
        void send();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [discard, isActive, send]);

  const micPointerHandlers: VoiceNoteController["micPointerHandlers"] = {
    onPointerDown(event) {
      if (event.pointerType === "mouse" || event.button !== 0) {
        return;
      }
      event.preventDefault();
      ignoreClickRef.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks; the gesture still works.
      }
      gestureRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
        released: false,
      };
      void start("hold");
    },
    onPointerMove(event) {
      const gesture = gestureRef.current;
      const current = phaseRef.current;
      if (!gesture || gesture.released || gesture.pointerId !== event.pointerId) {
        return;
      }
      if (current.kind !== "recording" && current.kind !== "starting") {
        return;
      }
      if (current.kind === "recording" && current.mode !== "hold") {
        return;
      }
      const x = Math.min(0, event.clientX - gesture.x);
      const y = Math.min(0, event.clientY - gesture.y);
      setSlide({ x, y });
      if (current.kind !== "recording") {
        return;
      }
      if (x <= -CANCEL_SLIDE_PX) {
        gesture.released = true;
        void discard();
      } else if (y <= -LOCK_SLIDE_PX) {
        gesture.released = true;
        setSlide({ x: 0, y: 0 });
        setPhase({ ...current, mode: "locked" });
      }
    },
    onPointerUp(event) {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.released) {
        return;
      }
      gesture.released = true;
      setSlide({ x: 0, y: 0 });
      const current = phaseRef.current;
      if (current.kind !== "recording" || current.mode !== "hold") {
        return;
      }
      if (Date.now() - gesture.at < TAP_MS) {
        recorderRef.current?.cancel();
        recorderRef.current = null;
        setPhase({ kind: "idle" });
        optionsRef.current.onFeedback("info", t("voiceNote.recordHold"));
        return;
      }
      void send();
    },
    onPointerCancel(event) {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.released) {
        return;
      }
      gesture.released = true;
      setSlide({ x: 0, y: 0 });
      // The system took the touch (a call, a gesture): keep what was said.
      const current = phaseRef.current;
      if (current.kind === "recording" && current.mode === "hold") {
        setPhase({ ...current, mode: "locked" });
      }
    },
    onClick() {
      if (ignoreClickRef.current) {
        ignoreClickRef.current = false;
        return;
      }
      void start("locked");
    },
    onContextMenu(event) {
      // A long press is the gesture here, not a request for a menu.
      event.preventDefault();
    },
  };

  return {
    available: flagOn,
    phase,
    elapsedMs,
    levels,
    slide,
    undo: undoNote ? { durationMs: undoNote.durationMs } : null,
    startLocked: () => void start("locked"),
    micPointerHandlers,
    togglePause,
    review,
    discard: () => void discard(),
    send: () => void send(),
    restore,
  };
}

// --------------------------------------------------------------------- views

/** The mic that stands in for Send while the composer is empty. */
export function VoiceNoteMicButton({
  controller,
  disabled,
}: {
  controller: VoiceNoteController;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const holding =
    (controller.phase.kind === "recording" || controller.phase.kind === "starting") &&
    controller.phase.mode === "hold";
  const touchFirst =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return (
    <div className="relative shrink-0">
      {holding && controller.phase.kind === "recording" && (
        <div
          aria-hidden
          className="absolute bottom-full left-1/2 mb-3 flex h-20 w-9 -translate-x-1/2 flex-col items-center justify-between rounded-full border border-border-strong bg-surface-2 py-2.5 text-text-secondary shadow-[var(--shadow-popover)]"
          style={{ transform: `translate(-50%, ${Math.max(-40, controller.slide.y / 2)}px)` }}
        >
          <Lock className="h-4 w-4" />
          <ChevronUp className="h-4 w-4 animate-pulse" />
        </div>
      )}
      <Tooltip label={touchFirst ? t("voiceNote.recordHold") : t("voiceNote.record")}>
        <Button
          type="button"
          size="icon"
          disabled={disabled}
          data-voice-note-mic
          {...controller.micPointerHandlers}
          className={cn(
            "h-8 w-8 shrink-0 touch-none select-none rounded-full",
            holding && "scale-125 ring-4 ring-accent/25",
          )}
        >
          <Mic className="h-4 w-4" aria-hidden />
        </Button>
      </Tooltip>
    </div>
  );
}

function LiveBars({ levels, className }: { levels: readonly number[]; className?: string }) {
  const padded = [
    ...new Array<number>(Math.max(0, LIVE_BARS - levels.length)).fill(0),
    ...levels.slice(-LIVE_BARS),
  ];
  return (
    <div aria-hidden className={cn("flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden", className)}>
      {padded.map((level, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(10, Math.round(Math.sqrt(level) * 100))}%` }}
          className="w-[3px] shrink-0 rounded-full bg-accent"
        />
      ))}
    </div>
  );
}

function PreviewPlayer({ note }: { note: RecordedVoiceNote }) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);

  useEffect(() => {
    const next = createPreviewUrl(note.blob);
    setUrl(next);
    return () => revokePreviewUrl(next);
  }, [note.blob]);

  const progress = Math.min(1, position / Math.max(1, note.durationMs));
  return (
    <>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
          className="hidden"
        />
      )}
      <Tooltip label={playing ? t("voiceNote.previewPause") : t("voiceNote.preview")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            const element = audioRef.current;
            if (!element) {
              return;
            }
            if (element.paused) {
              pauseVoiceNote();
              void element.play().catch(() => {});
            } else {
              element.pause();
            }
          }}
          className="h-8 w-8 shrink-0 rounded-full text-text"
        >
          {playing ? (
            <Pause className="h-4 w-4 fill-current" aria-hidden />
          ) : (
            <Play className="h-4 w-4 fill-current" aria-hidden />
          )}
        </Button>
      </Tooltip>
      <div aria-hidden className="flex h-7 min-w-0 flex-1 items-center gap-[2px] overflow-hidden">
        {note.peaks.map((peak, index) => (
          <span
            key={index}
            style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
            className={cn(
              "w-[3px] shrink-0 rounded-full",
              (index + 0.5) / note.peaks.length <= progress ? "bg-accent" : "bg-text-tertiary",
            )}
          />
        ))}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-text-secondary">
        {formatNoteDuration(note.durationMs)}
      </span>
    </>
  );
}

/**
 * Where the text field was, while a note is being recorded or reviewed.
 * `compact` is the held-touch shape: the timer, the bars and the cancel hint,
 * with the mic still under the finger in the row below.
 */
export function VoiceNotePanel({ controller }: { controller: VoiceNoteController }) {
  const { t } = useTranslation();
  const { phase } = controller;
  const panelRef = useRef<HTMLDivElement>(null);
  const locked =
    phase.kind === "review" ||
    phase.kind === "sending" ||
    ((phase.kind === "recording" || phase.kind === "starting") && phase.mode === "locked");

  useEffect(() => {
    if (locked) {
      // The panel itself, not the send button: focusing a tooltipped button
      // pins its tooltip open, and the panel is where Esc and Enter are read.
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [locked, phase.kind]);

  if (phase.kind === "idle") {
    return null;
  }

  const recording = phase.kind === "recording" || phase.kind === "starting";
  const paused = phase.kind === "recording" && phase.paused;
  const holding = recording && !locked;

  if (holding) {
    const cancelling = controller.slide.x <= -CANCEL_SLIDE_PX / 2;
    return (
      <div className="flex h-10 items-center gap-2.5 px-3" data-voice-note-panel="hold" role="status">
        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden />
        <span className="shrink-0 text-sm font-semibold tabular-nums text-text">
          {formatClock(controller.elapsedMs)}
        </span>
        <span
          className={cn(
            "ml-2 flex min-w-0 items-center gap-1 truncate text-xs transition-colors duration-[var(--duration-fast)]",
            cancelling ? "text-danger" : "text-text-tertiary",
          )}
          style={{ transform: `translateX(${Math.max(-60, controller.slide.x / 2)}px)` }}
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {cancelling ? t("voiceNote.releaseToCancel") : t("voiceNote.slideToCancel")}
        </span>
        <LiveBars levels={controller.levels} className="ml-auto max-w-40" />
      </div>
    );
  }

  const sending = phase.kind === "sending";
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="px-1.5 pb-1.5 pt-1.5 focus:outline-none"
      data-voice-note-panel={phase.kind}
    >
      <div className="flex items-center gap-1.5">
        <Tooltip label={t("voiceNote.discard")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={controller.discard}
            className="h-8 w-8 shrink-0 text-danger hover:text-danger"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </Tooltip>
        {recording ? (
          <>
            <span className="flex shrink-0 items-center gap-2 pl-1">
              <span
                className={cn("h-2.5 w-2.5 rounded-full bg-danger", !paused && "animate-pulse")}
                aria-hidden
              />
              <span className="text-sm font-semibold tabular-nums text-text" role="timer">
                {formatClock(controller.elapsedMs)}
              </span>
              <span className="sr-only">
                {paused ? t("voiceNote.paused") : t("voiceNote.recording")}
              </span>
            </span>
            <LiveBars levels={controller.levels} className={cn(paused && "opacity-50")} />
            <Tooltip label={paused ? t("voiceNote.resume") : t("voiceNote.pause")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={phase.kind === "starting"}
                onClick={controller.togglePause}
                className="h-8 w-8 shrink-0 rounded-full text-text"
              >
                {paused ? (
                  <Mic className="h-4 w-4" aria-hidden />
                ) : (
                  <Pause className="h-4 w-4 fill-current" aria-hidden />
                )}
              </Button>
            </Tooltip>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={phase.kind === "starting"}
              onClick={controller.review}
              className="hidden shrink-0 gap-1.5 sm:inline-flex"
            >
              <Headphones className="h-3.5 w-3.5" aria-hidden />
              {t("voiceNote.preview")}
            </Button>
            <Tooltip label={t("voiceNote.preview")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={phase.kind === "starting"}
                onClick={controller.review}
                className="h-8 w-8 shrink-0 rounded-full text-text sm:hidden"
              >
                <Headphones className="h-4 w-4" aria-hidden />
              </Button>
            </Tooltip>
          </>
        ) : (
          <PreviewPlayer note={phase.note} />
        )}
        <Tooltip label={sending ? t("voiceNote.sending") : t("voiceNote.send")}>
          <Button
            type="button"
            size="icon"
            disabled={sending || phase.kind === "starting"}
            onClick={controller.send}
            data-voice-note-send
            className="h-8 w-8 shrink-0 rounded-full"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ArrowUp className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </Tooltip>
      </div>
      <p className="flex items-center gap-1.5 px-1 pt-1 text-[11px] text-text-tertiary">
        {phase.kind === "recording" && phase.mode === "locked" && isCoarsePointer() ? (
          <>
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            {t("voiceNote.locked")}
          </>
        ) : (
          t("voiceNote.recordingHint")
        )}
      </p>
    </div>
  );
}

/** "Áudio descartado (0:11) · Desfazer", for five seconds after a discard. */
export function VoiceNoteUndo({ controller }: { controller: VoiceNoteController }) {
  const { t } = useTranslation();
  if (!controller.undo) {
    return null;
  }
  return (
    <div
      role="status"
      className="absolute bottom-full left-3 right-3 z-20 mb-2 flex items-center gap-2 rounded-[var(--radius-card)] bg-danger-soft px-3 py-1.5 text-sm text-on-danger-soft shadow-[var(--shadow-popover)] sm:left-4 sm:right-4"
    >
      <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {t("voiceNote.discarded", { duration: formatNoteDuration(controller.undo.durationMs) })}
      </span>
      <Button type="button" variant="secondary" size="sm" onClick={controller.restore}>
        {t("voiceNote.undo")}
      </Button>
    </div>
  );
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
