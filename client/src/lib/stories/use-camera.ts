import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORY_MAX_VIDEO_MS } from "@pqp/shared";
import {
  RECORDER_AUDIO_BITS_PER_SECOND,
  RECORDER_VIDEO_BITS_PER_SECOND,
  MIN_CLIP_MS,
  cameraAvailability,
  classifyCameraError,
  nextDeviceId,
  pickRecorderType,
  shouldMirror,
  videoConstraints,
  type CameraFacing,
  type CameraProblem,
} from "./camera";

export type CameraStatus = "idle" | "starting" | "live" | CameraProblem;

export interface CameraControls {
  status: CameraStatus;
  stream: MediaStream | null;
  /** The preview mirrors (a front camera). The recorded file never does. */
  mirrored: boolean;
  /** More than one camera to choose from, or a phone that can turn to the other one. */
  canFlip: boolean;
  flip: () => void;
  /** The torch is on the capabilities of this camera (a phone's back camera). */
  torchAvailable: boolean;
  torchOn: boolean;
  toggleTorch: () => void;
  /** The track's real size, for a clip whose own header cannot be read. */
  size: { width: number; height: number } | null;
  retry: () => void;
}

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Owns one camera stream while `active`. The stream is stopped the moment it
 * is not wanted (the person left the camera tab, the tab was hidden, the
 * composer closed), because a camera light that stays on after the picture is
 * taken is the fastest way to lose trust.
 */
export function useCamera(active: boolean): CameraControls {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>("user");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [mirrored, setMirrored] = useState(true);
  const [facingReported, setFacingReported] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    const blocked = cameraAvailability({
      hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
      isSecureContext: window.isSecureContext,
    });
    if (blocked) {
      setStatus(blocked);
      return;
    }
    let cancelled = false;
    setStatus("starting");
    setTorchOn(false);

    async function open(): Promise<MediaStream> {
      const portrait = isCoarsePointer();
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: videoConstraints({ facing, deviceId, portrait }),
          audio: false,
        });
      } catch (error) {
        // A camera that cannot meet even the soft sizes still opens plain; any
        // other failure is the answer.
        if (classifyCameraError(error) === "failed" || (error as { name?: string }).name === "OverconstrainedError") {
          return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        throw error;
      }
    }

    open().then(
      async (next) => {
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        current.current = next;
        const track = next.getVideoTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        // Labels exist only after permission, so the list is read now.
        let list: MediaDeviceInfo[] = [];
        try {
          list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        } catch {
          list = [];
        }
        if (cancelled) {
          next.getTracks().forEach((t) => t.stop());
          return;
        }
        const label = list.find((device) => device.deviceId === settings.deviceId)?.label ?? track?.label ?? "";
        const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setDevices(list);
        setFacingReported(Boolean(settings.facingMode));
        setMirrored(shouldMirror({ facingMode: settings.facingMode }, label));
        setTorchAvailable(Boolean(capabilities.torch));
        setSize(
          settings.width && settings.height ? { width: settings.width, height: settings.height } : null,
        );
        setStream(next);
        setStatus("live");
        track?.addEventListener("ended", () => {
          if (current.current === next) {
            setStatus("busy");
            setStream(null);
          }
        });
      },
      (error) => {
        if (!cancelled) {
          setStream(null);
          setStatus(classifyCameraError(error));
        }
      },
    );

    return () => {
      cancelled = true;
      current.current?.getTracks().forEach((track) => track.stop());
      current.current = null;
      setStream(null);
    };
  }, [active, facing, deviceId, attempt]);

  useEffect(() => {
    if (!active) {
      setStatus("idle");
    }
  }, [active]);

  const canFlip = devices.length > 1 || (isCoarsePointer() && status === "live");

  const flip = useCallback(() => {
    // A phone names its cameras (user / environment) and turns between them;
    // a laptop with two webcams has only a list to walk.
    if (facingReported || devices.length < 2) {
      setDeviceId(null);
      setFacing((value) => (value === "user" ? "environment" : "user"));
      return;
    }
    const settings = current.current?.getVideoTracks()[0]?.getSettings();
    setDeviceId(nextDeviceId(devices, settings?.deviceId ?? deviceId));
  }, [devices, deviceId, facingReported]);

  const toggleTorch = useCallback(() => {
    const track = current.current?.getVideoTracks()[0];
    if (!track) {
      return;
    }
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      .then(() => setTorchOn(next))
      .catch(() => setTorchAvailable(false));
  }, [torchOn]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return useMemo(
    () => ({ status, stream, mirrored, canFlip, flip, torchAvailable, torchOn, toggleTorch, size, retry }),
    [status, stream, mirrored, canFlip, flip, torchAvailable, torchOn, toggleTorch, size, retry],
  );
}

// ------------------------------------------------------------------ recording

export interface RecordedClip {
  blob: Blob;
  durationMs: number;
  /** The clip has no sound because the microphone was refused or missing. */
  silent: boolean;
}

export interface RecorderControls {
  /** This browser can record a container the story takes. */
  supported: boolean;
  recording: boolean;
  elapsedMs: number;
  start: () => Promise<boolean>;
  /** Ends the clip; it arrives through `onClip`, as it does at the time limit. */
  stop: () => void;
  /** The last start found no microphone: the clip is silent. */
  micMissing: boolean;
}

/**
 * Records the camera stream with a MediaRecorder, up to `STORY_MAX_VIDEO_MS`.
 * The microphone is asked for when recording starts, not when the camera
 * opens, so a person who only takes photos is never asked for it; its tracks
 * are stopped the moment the clip ends. A refused microphone does not stop the
 * clip: it is recorded silent and the composer says so.
 */
export function useRecorder(
  stream: MediaStream | null,
  onClip: (clip: RecordedClip) => void,
  maxMs = STORY_MAX_VIDEO_MS,
): RecorderControls {
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;
  const mimeType = useMemo(
    () =>
      typeof MediaRecorder === "undefined"
        ? null
        : pickRecorderType((type) => MediaRecorder.isTypeSupported(type)),
    [],
  );
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micMissing, setMicMissing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const micStream = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const silent = useRef(false);
  // `start` is async (the microphone prompt); a release that arrives before it
  // resolves must cancel it rather than be ignored.
  const startTicket = useRef(0);

  const releaseMic = useCallback(() => {
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const stop = useCallback((): void => {
    // A release while the microphone prompt is still open cancels the start.
    startTicket.current += 1;
    const active = recorder.current;
    if (active && active.state !== "inactive") {
      active.stop();
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (!stream || !mimeType || recorder.current) {
      return false;
    }
    const ticket = ++startTicket.current;
    let tracks = stream.getVideoTracks();
    silent.current = false;
    setMicMissing(false);
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (ticket !== startTicket.current) {
        mic.getTracks().forEach((track) => track.stop());
        return false;
      }
      micStream.current = mic;
      tracks = [...tracks, ...mic.getAudioTracks()];
    } catch {
      silent.current = true;
      setMicMissing(true);
      if (ticket !== startTicket.current) {
        return false;
      }
    }
    chunks.current = [];
    const next = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: RECORDER_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
    });
    next.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.current.push(event.data);
      }
    };
    next.onstop = () => {
      clearTimer();
      releaseMic();
      const durationMs = Math.min(maxMs, Date.now() - startedAt.current);
      const blob = new Blob(chunks.current, { type: "video/mp4" });
      chunks.current = [];
      recorder.current = null;
      setRecording(false);
      setElapsedMs(0);
      if (durationMs >= MIN_CLIP_MS && blob.size > 0) {
        onClipRef.current({ blob, durationMs, silent: silent.current });
      }
    };
    next.onerror = () => {
      if (next.state !== "inactive") {
        next.stop();
      }
    };
    recorder.current = next;
    startedAt.current = Date.now();
    next.start();
    setRecording(true);
    setElapsedMs(0);
    timer.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(Math.min(elapsed, maxMs));
      if (elapsed >= maxMs && next.state !== "inactive") {
        next.stop();
      }
    }, 100);
    return true;
  }, [stream, mimeType, maxMs, clearTimer, releaseMic]);

  // The stream going away (tab hidden, camera lost) ends the clip.
  useEffect(() => {
    if (!stream && recorder.current && recorder.current.state !== "inactive") {
      recorder.current.stop();
    }
  }, [stream]);

  useEffect(
    () => () => {
      startTicket.current += 1;
      clearTimer();
      releaseMic();
      if (recorder.current && recorder.current.state !== "inactive") {
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      recorder.current = null;
    },
    [clearTimer, releaseMic],
  );

  return { supported: mimeType !== null, recording, elapsedMs, start, stop, micMissing };
}
