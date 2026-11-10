import type { CreateJamSongRequest, JamInstrument, JamTrack } from "@pqp/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listInputs,
  prepareStemUpload,
  tapTempo,
  type JamEngine,
  type JamTake,
  type LatencyResult,
  type LatencyStatus,
  type RecordingHandle,
} from "@/lib/jam";
import { createJamSong, jamErrorKind, type JamErrorKind } from "@/lib/jam-api";
import { createLevelMeter, type JamLevelMeter } from "@/lib/jam-level";
import { getJamEngine, syncJamStems, TAKE_STEM_ID } from "@/lib/jam-session";
import { putJamSongOnWall, putJamTrackInSong } from "@/lib/jam-store";
import {
  asRecorded,
  isEdited,
  placed,
  withGain,
  withNudge,
  withTrimEnd,
  withTrimStart,
  type TakeEdits,
} from "@/lib/jam-take-edit";
import {
  postTake,
  startJamPost,
  withoutVideo,
  type JamPostProgress,
  type JamPostState,
  type JamPostTake,
} from "@/lib/jam-upload";
import { JAM_TRACK_MAX_DURATION_MS } from "@pqp/shared";

/**
 * The studio's logic, with no layout in it: opening the microphone, the
 * latency check, the count-in, the recording and its live waveform, the take
 * dropped into the mix, the optional edits, and the three-step post.
 *
 * The engine does the placing: `rec.stop()` hands back a take that is already
 * on the song, so posting needs nothing from the person. Everything between
 * "stop" and "post" here is optional.
 */

export type StudioPhase =
  | "boot"
  | "unsupported"
  | "setup"
  | "countdown"
  | "recording"
  | "review"
  | "posting"
  | "done";

export type MicState = "opening" | "ready" | "denied" | "none" | "error";

/** The first-use latency screen: not asked yet, measuring, measured, or skipped. */
export type CheckState = "needed" | "measuring" | "measured" | "failed" | "skipped";

export interface NewSongDraft {
  title: string;
  artist: string | null;
  joinMode: "open" | "wanted" | "closed";
  wantedInstruments: JamInstrument[];
  /** One per draft, so a retried create lands on the same song. */
  nonce: string;
}

export interface StudioCountIn {
  bars: 0 | 1 | 2;
  bpm: number;
}

export interface UseJamStudioArgs {
  channelId: string;
  /** The song being recorded over; null while starting a new one. */
  songId: string | null;
  /** In-mix tracks that play in the person's ear while they record. */
  backing: readonly JamTrack[];
  draft: NewSongDraft | null;
  initialInstrument: JamInstrument;
}

const DEFAULT_BPM = 100;
const BEATS_PER_BAR = 4;
/** A take stops itself a few seconds before the server's ten-minute ceiling. */
const AUTO_STOP_MS = JAM_TRACK_MAX_DURATION_MS - 5000;

export function useJamStudio(args: UseJamStudioArgs) {
  const { channelId, songId, backing, draft } = args;
  const [phase, setPhase] = useState<StudioPhase>("boot");
  const [engine, setEngine] = useState<JamEngine | null>(null);
  const [mic, setMic] = useState<MicState>("opening");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [latency, setLatency] = useState<LatencyStatus | null>(null);
  const [check, setCheck] = useState<CheckState>("needed");
  const [checkMethod, setCheckMethod] = useState<"loopback" | "tap-along" | null>(null);
  const [checkResult, setCheckResult] = useState<LatencyResult | null>(null);
  const [instrument, setInstrument] = useState<JamInstrument>(args.initialInstrument);
  const [countIn, setCountIn] = useState<StudioCountIn>({ bars: 1, bpm: DEFAULT_BPM });
  const [wantsVideo, setWantsVideo] = useState(false);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const [beat, setBeat] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [livePeaks, setLivePeaks] = useState<number[]>([]);
  const [take, setTake] = useState<JamTake | null>(null);
  const [edits, setEdits] = useState<TakeEdits | null>(null);
  const [takeVideoUrl, setTakeVideoUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<JamPostProgress>({ stage: "uploading", fraction: 0 });
  const [postError, setPostError] = useState<JamErrorKind | null>(null);
  const [posted, setPosted] = useState<{ songId: string; trackId: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const handle = useRef<RecordingHandle | null>(null);
  const meter = useRef<JamLevelMeter | null>(null);
  const level = useRef(0);
  const levelListeners = useRef(new Set<(peak: number) => void>());
  const phaseRef = useRef<StudioPhase>("boot");
  phaseRef.current = phase;
  const grid = useRef<{ t0: number; f0: number; beatSec: number; total: number } | null>(null);
  const taps = useRef<number[]>([]);
  const job = useRef<{ state: JamPostState; take: JamPostTake } | null>(null);
  const createdSongId = useRef<string | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const takeUrl = useRef<string | null>(null);
  const backingRef = useRef(backing);
  backingRef.current = backing;

  const refreshLatency = useCallback(async (live: JamEngine) => {
    try {
      const status = await live.latency();
      setLatency(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  const openMic = useCallback(
    async (live: JamEngine, wanted?: string | null) => {
      setMic("opening");
      try {
        await live.openInput(wanted ? { deviceId: wanted } : {});
      } catch (failure) {
        const name = (failure as { name?: string } | null)?.name;
        setMic(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "none"
              : "error",
        );
        return;
      }
      const input = live.input;
      if (!input) {
        setMic("error");
        return;
      }
      meter.current?.close();
      meter.current = createLevelMeter(live.context, input.stream);
      setDeviceId(input.deviceId);
      setMic("ready");
      try {
        setDevices(await listInputs());
      } catch {
        setDevices([]);
      }
      const status = await refreshLatency(live);
      // A stored measurement for this pair of devices is the end of the check.
      if (status && status.current.method !== "estimate") {
        setCheck("measured");
      }
    },
    [refreshLatency],
  );

  // ---- boot: engine, backing, microphone ---------------------------------
  // Runs again if React remounts the studio (StrictMode in development), so it
  // is written to be repeated: the engine is shared, an input open closes the
  // one before it, and a boot that was cancelled stops touching state.
  const engineRef = useRef<JamEngine | null>(null);
  useEffect(() => {
    let cancelled = false;
    const supported =
      typeof AudioWorkletNode !== "undefined" &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia);
    if (!supported) {
      setPhase("unsupported");
      return;
    }
    let detach: (() => void) | null = null;
    void (async () => {
      try {
        const live = await getJamEngine();
        if (cancelled) {
          return;
        }
        engineRef.current = live;
        setEngine(live);
        setPhase((before) => (before === "boot" ? "setup" : before));
        void syncJamStems(live, backingRef.current);
        detach = live.onDevicesChanged((status) => {
          setLatency(status);
          setDeviceId(live.input?.deviceId ?? null);
          void listInputs().then(setDevices, () => undefined);
        });
        await openMic(live);
      } catch {
        if (!cancelled) {
          setMic("error");
          setPhase((before) => (before === "boot" ? "setup" : before));
        }
      }
    })();
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [openMic]);

  // The backing follows the song while the studio is open (a track arrives).
  const backingSignature = backing.map((track) => `${track.id}:${track.inMix}`).join(",");
  useEffect(() => {
    if (engine) {
      void syncJamStems(engine, backingRef.current);
    }
  }, [engine, backingSignature]);

  // ---- the level meter and the live waveform ------------------------------
  useEffect(() => {
    if (mic !== "ready") {
      return;
    }
    let bucket = 0;
    let bucketSince = performance.now();
    const timer = window.setInterval(() => {
      const peak = meter.current?.read() ?? 0;
      level.current = peak;
      for (const listener of levelListeners.current) {
        listener(peak);
      }
      if (phaseRef.current !== "recording") {
        bucket = 0;
        bucketSince = performance.now();
        return;
      }
      bucket = Math.max(bucket, peak);
      const now = performance.now();
      if (now - bucketSince >= 80) {
        const value = bucket;
        bucket = 0;
        bucketSince = now;
        setLivePeaks((before) => [...before, Math.min(1, value)]);
      }
    }, 30);
    return () => window.clearInterval(timer);
  }, [mic]);

  // ---- the camera ----------------------------------------------------------
  useEffect(() => {
    if (!wantsVideo) {
      cameraRef.current?.getTracks().forEach((one) => one.stop());
      cameraRef.current = null;
      setCamera(null);
      return;
    }
    let cancelled = false;
    setCameraError(false);
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 360 }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((one) => one.stop());
          return;
        }
        cameraRef.current = stream;
        setCamera(stream);
      })
      .catch(() => {
        if (!cancelled) {
          setCameraError(true);
          setWantsVideo(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wantsVideo]);

  // ---- the count-in and the clock while recording --------------------------
  useEffect(() => {
    if (phase !== "countdown" && phase !== "recording") {
      return;
    }
    const live = engine;
    if (!live) {
      return;
    }
    const timer = window.setInterval(() => {
      const g = grid.current;
      if (!g) {
        return;
      }
      const now = live.context.currentTime;
      if (now < g.f0) {
        const index = Math.max(0, Math.floor((now - g.t0) / g.beatSec));
        setBeat(Math.min(g.total, index + 1));
        return;
      }
      if (phaseRef.current === "countdown") {
        setPhase("recording");
      }
      const elapsed = Math.max(0, (now - g.f0) * 1000);
      setElapsedMs(elapsed);
      if (elapsed >= AUTO_STOP_MS) {
        void stopRef.current();
      }
    }, 40);
    return () => window.clearInterval(timer);
  }, [phase, engine]);

  // ---- actions ---------------------------------------------------------------
  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const startRecording = useCallback(async () => {
    const live = engine;
    if (!live || mic !== "ready") {
      return;
    }
    setStartError(null);
    try {
      // The click that got us here is the gesture the audio needs.
      await live.context.resume();
      await syncJamStems(live, backingRef.current);
      const status = await live.latency();
      const bars = countIn.bars;
      const handleNow = await live.record({
        fromMs: 0,
        countIn: bars > 0 ? { bars, beatsPerBar: BEATS_PER_BAR, bpm: countIn.bpm } : null,
        camera: wantsVideo ? cameraRef.current : null,
        latency: status.current,
      });
      handle.current = handleNow;
      const sr = live.context.sampleRate;
      grid.current = {
        t0: handleNow.captureStartFrame / sr,
        f0: handleNow.backingStartFrame / sr,
        beatSec: 60 / countIn.bpm,
        total: bars * BEATS_PER_BAR,
      };
      setLivePeaks([]);
      setElapsedMs(0);
      setBeat(0);
      setPhase("countdown");
    } catch {
      setStartError("start");
    }
  }, [engine, mic, countIn, wantsVideo]);

  const stopRecording = useCallback(async () => {
    const live = engine;
    const running = handle.current;
    if (!live || !running) {
      return;
    }
    handle.current = null;
    try {
      const done = await running.stop();
      live.addTake(TAKE_STEM_ID, done);
      if (takeUrl.current) {
        URL.revokeObjectURL(takeUrl.current);
      }
      takeUrl.current = done.video ? URL.createObjectURL(done.video.blob) : null;
      setTakeVideoUrl(takeUrl.current);
      setTake(done);
      setEdits(asRecorded(done));
      setPhase("review");
      // Hear it with the band straight away: stopping was the gesture.
      window.setTimeout(() => {
        void live.player.play(0);
      }, 380);
    } catch {
      setStartError("stop");
      setPhase("setup");
    }
  }, [engine]);
  stopRef.current = stopRecording;

  const discardTake = useCallback(() => {
    const live = engine;
    live?.player.stop();
    live?.player.removeStem(TAKE_STEM_ID);
    if (takeUrl.current) {
      URL.revokeObjectURL(takeUrl.current);
      takeUrl.current = null;
    }
    setTakeVideoUrl(null);
    setTake(null);
    setEdits(null);
    setLivePeaks([]);
    setElapsedMs(0);
    job.current = null;
    setPostError(null);
    setPhase("setup");
  }, [engine]);

  const cancelRecording = useCallback(async () => {
    const running = handle.current;
    handle.current = null;
    if (running) {
      await running.cancel().catch(() => undefined);
    }
    setLivePeaks([]);
    setElapsedMs(0);
    setPhase("setup");
  }, []);

  /** Edit the take on screen: the engine hears it at once, nothing is re-rendered. */
  const edit = useCallback(
    (change: (current: TakeEdits, take: JamTake) => TakeEdits) => {
      if (!take || !edits || !engine) {
        return;
      }
      const next = change(edits, take);
      setEdits(next);
      const at = placed(take, next);
      engine.player.updateStem(TAKE_STEM_ID, {
        offsetMs: at.offsetMs,
        trimStartMs: at.trimStartMs,
        trimEndMs: at.trimEndMs,
        gain: at.gain,
      });
      job.current = null;
    },
    [take, edits, engine],
  );

  const setTrimStart = useCallback((ms: number) => edit((e, t) => withTrimStart(t, e, ms)), [edit]);
  const setTrimEnd = useCallback((ms: number) => edit((e, t) => withTrimEnd(t, e, ms)), [edit]);
  const setNudge = useCallback((ms: number) => edit((e) => withNudge(e, ms)), [edit]);
  const setGain = useCallback((gain: number) => edit((e) => withGain(e, gain)), [edit]);
  const resetEdits = useCallback(() => edit((_, t) => asRecorded(t)), [edit]);

  const post = useCallback(async () => {
    if (!take || !edits || phaseRef.current === "done") {
      return;
    }
    setPostError(null);
    setPhase("posting");
    setProgress({ stage: "uploading", fraction: 0 });
    try {
      let targetSong = songId ?? createdSongId.current;
      if (!targetSong) {
        if (!draft) {
          throw new Error("jam: no song to post into");
        }
        const body: CreateJamSongRequest = {
          title: draft.title,
          artist: draft.artist,
          joinMode: draft.joinMode,
          wantedInstruments: draft.joinMode === "wanted" ? draft.wantedInstruments : [],
          nonce: draft.nonce,
        };
        const { song } = await createJamSong(channelId, body);
        createdSongId.current = song.id;
        targetSong = song.id;
        putJamSongOnWall(channelId, song);
      }
      if (!job.current) {
        const at = placed(take, edits);
        const upload = await prepareStemUpload(
          {
            samples: take.samples,
            sampleRate: take.sampleRate,
            offsetMs: at.offsetMs,
            trimStartMs: at.trimStartMs,
            trimEndMs: at.trimEndMs,
            video: take.video,
          },
          { gain: at.gain },
        );
        const input: JamPostTake = {
          audio: upload.audio,
          video: upload.video,
          offsetMs: upload.offsetMs,
          trimStartMs: upload.trimStartMs,
          trimEndMs: upload.trimEndMs,
          durationMs: upload.durationMs,
          gain: upload.gain,
          peaks: upload.peaks,
        };
        job.current = { state: startJamPost(input), take: input };
      }
      const answer = await postTake({
        songId: targetSong,
        instrument,
        take: job.current.take,
        state: job.current.state,
        onProgress: setProgress,
      });
      putJamTrackInSong(channelId, answer.song, answer.track);
      setPosted({ songId: targetSong, trackId: answer.track.id });
      setPhase("done");
    } catch (failure) {
      setPostError(jamErrorKind(failure));
    }
  }, [take, edits, songId, draft, channelId, instrument]);

  /** The picture would not go: post the sound alone, which is already stored. */
  const postWithoutVideo = useCallback(() => {
    if (job.current) {
      job.current = { ...job.current, state: withoutVideo(job.current.state) };
    }
    void post();
  }, [post]);

  const measure = useCallback(
    async (method: "loopback" | "tap-along") => {
      const live = engine;
      if (!live || mic !== "ready") {
        return;
      }
      setCheck("measuring");
      setCheckMethod(method);
      setCheckResult(null);
      try {
        const result =
          method === "loopback" ? await live.calibrate("loopback") : await live.calibrate("tap-along");
        setCheckResult(result);
        await refreshLatency(live);
        setCheck(result.confidence === "high" || result.confidence === "medium" ? "measured" : "failed");
      } catch {
        setCheck("failed");
      }
    },
    [engine, mic, refreshLatency],
  );

  const skipCheck = useCallback(() => setCheck("skipped"), []);
  const recheck = useCallback(() => {
    setCheck("needed");
    setCheckResult(null);
  }, []);

  const chooseDevice = useCallback(
    async (next: string) => {
      if (engine) {
        setCheck("needed");
        await openMic(engine, next);
      }
    },
    [engine, openMic],
  );

  const retryMic = useCallback(() => {
    if (engine) {
      void openMic(engine, deviceId);
    }
  }, [engine, openMic, deviceId]);

  const tapTempoNow = useCallback(() => {
    const now = performance.now();
    taps.current = [...taps.current.filter((at) => now - at < 2500), now];
    const bpm = tapTempo(taps.current);
    if (bpm) {
      setCountIn((before) => ({ ...before, bpm: Math.min(200, Math.max(50, Math.round(bpm))) }));
    }
  }, []);

  // ---- teardown ------------------------------------------------------------
  useEffect(() => {
    return () => {
      const running = handle.current;
      handle.current = null;
      void running?.cancel().catch(() => undefined);
      meter.current?.close();
      meter.current = null;
      cameraRef.current?.getTracks().forEach((one) => one.stop());
      cameraRef.current = null;
      if (takeUrl.current) {
        URL.revokeObjectURL(takeUrl.current);
        takeUrl.current = null;
      }
      // Closed on the spot, not on a later tick: a remount that opens the input
      // again must not have the new one closed under it.
      const live = engineRef.current;
      if (live) {
        live.player.stop();
        live.player.removeStem(TAKE_STEM_ID);
        live.input?.close();
        live.input = null;
      }
    };
  }, []);

  const levelClock = useMemo(
    () => ({
      subscribe(listener: (peak: number) => void) {
        levelListeners.current.add(listener);
        return () => {
          levelListeners.current.delete(listener);
        };
      },
    }),
    [],
  );

  const needsCheck = mic === "ready" && latency !== null && latency.current.method === "estimate" && check !== "skipped" && check !== "measured";

  return {
    phase,
    engine,
    mic,
    devices,
    deviceId,
    latency,
    check,
    checkMethod,
    checkResult,
    needsCheck,
    instrument,
    setInstrument,
    countIn,
    setCountIn,
    wantsVideo,
    setWantsVideo,
    camera,
    cameraError,
    beat,
    beats: grid.current?.total ?? 0,
    elapsedMs,
    livePeaks,
    take,
    edits,
    edited: take && edits ? isEdited(take, edits) : false,
    takeVideoUrl,
    progress,
    postError,
    posted,
    startError,
    levelClock,
    startRecording,
    stopRecording,
    cancelRecording,
    discardTake,
    setTrimStart,
    setTrimEnd,
    setNudge,
    setGain,
    resetEdits,
    post,
    postWithoutVideo,
    measure,
    skipCheck,
    recheck,
    chooseDevice,
    retryMic,
    tapTempo: tapTempoNow,
  };
}

export type JamStudio = ReturnType<typeof useJamStudio>;
