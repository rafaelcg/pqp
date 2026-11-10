import type { JamInstrument, JamSongSummary, JamTrack } from "@pqp/shared";
import { ArrowLeft, Camera, Loader2, MicOff, RotateCcw, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { useEngineClock } from "@/hooks/use-jam-clock";
import { useJamStudio, type NewSongDraft } from "@/hooks/use-jam-studio";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK, JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { liveTimelineEndMs } from "@/lib/jam-live";
import { TAKE_STEM_ID } from "@/lib/jam-session";
import { songNeed, songTimeline } from "@/lib/jam-wall";
import { placed } from "@/lib/jam-take-edit";
import { computePeaks } from "@/lib/jam";
import { cn } from "@/lib/utils";
import { setJamHintContext } from "@/lib/jam-hint-context";
import { newJamNonce } from "@/lib/jam-nonce";
import { JamLaneWave } from "./jam-lane-wave";
import { formatList } from "./jam-need";
import {
  Countdown,
  DoneOverlay,
  InstrumentPicker,
  LatencyCard,
  LatencyChip,
  LatencyCheck,
  LevelMeter,
  LiveLane,
  ReviewEditor,
  StudioLaneLabel,
  StudioTip,
  useLatencyWords,
} from "./jam-studio-parts";
import { JamTransport } from "./jam-transport";

/**
 * The studio: where a part is recorded, over a song or as the first track of a
 * new one. The flow is one line: pick what you play (pre-selected), hit the big
 * button, play, stop, listen with the band, post. Everything else on the screen
 * (the input, the level, the latency, the count-in, the camera, the trim and
 * the nudge) is there to be looked at when something is wrong, not walked
 * through.
 */

export interface JamStudioProps {
  channelId: string;
  /** The song being recorded over; null for a new one. */
  song: JamSongSummary | null;
  /** The song's tracks: the in-mix ones play in the person's ear. */
  tracks: readonly JamTrack[];
  draft: NewSongDraft | null;
  /** What this person may record, and what they start on. */
  addable: readonly JamInstrument[];
  initialInstrument: JamInstrument;
  viewerId: string | null;
  /** May put takes in and out of the mix: the song's author or a moderator. */
  canSwitchMix: boolean;
  /** The song went away while the studio was open. */
  songDeleted: boolean;
  onClose: () => void;
  /** The take is on the song: go and look at it. */
  onPosted: (posted: { songId: string; trackId: string }) => void;
}

export function JamStudio({
  channelId,
  song,
  tracks,
  draft,
  addable,
  initialInstrument,
  viewerId,
  canSwitchMix,
  songDeleted,
  onClose,
  onPosted,
}: JamStudioProps) {
  const { t, locale } = useTranslation();
  const backing = useMemo(() => tracks.filter((track) => track.inMix), [tracks]);
  const known = useRef<JamSongSummary | null>(song);
  if (song) {
    known.current = song;
  }
  const studio = useJamStudio({
    channelId,
    songId: song?.id ?? null,
    backing: tracks,
    draft,
    initialInstrument,
    viewerId,
    canSwitchMix,
    songDeleted,
  });
  const words = useLatencyWords();
  const { clock, transport, durationMs } = useEngineClock(studio.engine);
  /** Which question the leave dialog is asking: a live recording, or a take not sent. */
  const [confirmLeave, setConfirmLeave] = useState<"recording" | "take" | null>(null);
  const recordRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setJamHintContext({ studio: true });
    return () => setJamHintContext({ studio: false });
  }, []);

  const phase = studio.phase;
  const recording = phase === "countdown" || phase === "recording";
  const names = Array.from(new Set(backing.map((track) => track.authorName ?? t("jam.tile.anonymous"))));
  // A new song is "Música nova" until it exists, and is itself once it does.
  const created = phase === "done" && !song && draft !== null;
  const title = song
    ? t("jam.studio.over", { names: formatList(names, locale) || song.title })
    : created
      ? draft!.title
      : t("jam.studio.new");
  const subtitle = song
    ? `${song.title}${song.artist ? ` · ${song.artist}` : ""}`
    : created
      ? (draft?.artist ?? t("jam.original"))
      : (draft?.title ?? "");
  const backingEnd = songTimeline(backing).endMs;
  const takeEnd =
    studio.take && studio.edits
      ? placed(studio.take, studio.edits).offsetMs + studio.take.durationMs - studio.edits.trimEndMs
      : 0;
  const timeline = {
    startMs: 0,
    endMs: recording
      ? liveTimelineEndMs(backingEnd, studio.elapsedMs)
      : phase === "setup" || phase === "boot"
        ? Math.max(backingEnd, 8000)
        : Math.max(backingEnd, takeEnd, 1000),
  };
  const takePeaks = useMemo(() => (studio.take ? computePeaks([studio.take.samples]) : []), [studio.take]);
  const need = song ? songNeed(song) : null;
  const wanted = need?.kind === "missing" ? need.instruments : (draft?.joinMode === "wanted" ? draft.wantedInstruments : []);
  const pickable = JAM_INSTRUMENT_ORDER.filter((one) => addable.includes(one));

  const stageVideo = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = stageVideo.current;
    if (element && studio.camera) {
      element.srcObject = studio.camera;
    }
  }, [studio.camera, phase]);

  const takeVideo = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = takeVideo.current;
    if (!element || !studio.engine || !studio.takeVideoUrl) {
      return;
    }
    return studio.engine.player.attachVideo(TAKE_STEM_ID, element);
  }, [studio.engine, studio.takeVideoUrl, phase]);

  function requestClose() {
    // A live recording is as much somebody's work as a take waiting to be sent:
    // both ask first.
    if (recording) {
      setConfirmLeave("recording");
      return;
    }
    if (phase === "review" || phase === "posting") {
      setConfirmLeave("take");
      return;
    }
    onClose();
  }

  // Escape leaves, the way every other panel does, after the same question.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && confirmLeave === null && phase !== "done") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("[role=dialog][aria-modal=true] [role=dialog]")) {
          return;
        }
        requestClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The space bar is the big button, the way a pedal would be.
  useEffect(() => {
    if (phase !== "setup") {
      return;
    }
    recordRef.current?.focus({ preventScroll: true });
  }, [phase, studio.mic, studio.needsCheck]);

  useEffect(() => {
    if (phase !== "done" || !studio.posted) {
      return;
    }
    const posted = studio.posted;
    const timer = window.setTimeout(() => onPosted(posted), 3600);
    return () => window.clearTimeout(timer);
  }, [phase, studio.posted, onPosted]);

  const micProblem =
    studio.mic === "denied"
      ? t("jam.mic.denied")
      : studio.mic === "none"
        ? t("jam.mic.none")
        : studio.mic === "error"
          ? t("jam.mic.error")
          : null;

  const canRecord = studio.mic === "ready" && !studio.needsCheck && phase === "setup";
  const progressText =
    studio.progress.stage === "claiming"
      ? t("jam.post.claiming")
      : t("jam.post.uploading", { percent: Math.round(studio.progress.fraction * 100) });
  const errorText = studio.postError ? t(`jam.error.${studio.postError}` as MessageKey) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-jam-studio=""
      data-phase={phase}
      className="@container absolute inset-0 z-30 flex flex-col bg-surface-0"
    >
      <header className="flex items-center gap-2 border-b border-border bg-surface-1 px-2 py-2 sm:px-4">
        <button
          type="button"
          onClick={requestClose}
          aria-label={t("jam.studio.close")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h2 className="truncate font-display text-lg font-bold text-text">{title}</h2>
          {subtitle && <p className="truncate text-xs text-text-secondary">{subtitle}</p>}
        </div>
        {phase !== "unsupported" && phase !== "done" && <LatencyChip studio={studio} />}
        {recording && phase === "recording" && (
          <span
            role="timer"
            aria-label={t("jam.studio.recording", { time: formatTime(studio.elapsedMs) })}
            className="flex h-8 shrink-0 items-center gap-2 rounded-full bg-danger-soft px-3 text-sm font-bold tabular-nums text-on-danger-soft"
          >
            <span aria-hidden className="jam-rec-dot h-2 w-2 rounded-full bg-danger" />
            {t("jam.studio.recording", { time: formatTime(studio.elapsedMs) })}
          </span>
        )}
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {phase === "unsupported" ? (
          <div className="grid min-h-full place-items-center p-8 text-center">
            <p role="alert" className="max-w-sm text-sm leading-relaxed text-text-secondary">
              {t("jam.studio.unsupported")}
            </p>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-6xl gap-5 p-3 sm:p-5 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="@container flex min-w-0 flex-col gap-4">
              {micProblem && (
                <div role="alert" className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-danger-soft p-4 text-on-danger-soft">
                  <p className="flex items-start gap-2 text-sm leading-snug">
                    <MicOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {micProblem}
                  </p>
                  <Button variant="secondary" size="sm" onClick={studio.retryMic}>
                    {t("jam.mic.retry")}
                  </Button>
                </div>
              )}

              {studio.songGone && (
                <div
                  role="alert"
                  data-jam-song-deleted=""
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-warning-soft p-4 text-on-warning-soft"
                >
                  <p className="text-sm font-semibold leading-snug">{t("jam.studio.songDeleted")}</p>
                  {(phase === "review" || phase === "posting") && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        data-jam-post-as-new=""
                        onClick={() =>
                          studio.postAsNewSong({
                            title: known.current?.title ?? t("jam.studio.new"),
                            artist: known.current?.artist ?? null,
                            joinMode: "open",
                            wantedInstruments: [],
                            nonce: newJamNonce(),
                          })
                        }
                      >
                        {t("jam.studio.postAsNew")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        data-jam-discard-take=""
                        onClick={() => {
                          studio.discardTake();
                          onClose();
                        }}
                      >
                        {t("jam.studio.discardTake")}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {phase === "setup" && !studio.needsCheck && studio.mic === "ready" && <StudioTip />}

              {phase === "setup" && studio.needsCheck && <LatencyCheck studio={studio} />}

              {studio.camera && (phase === "setup" || recording) && (
                <div className="relative aspect-video max-h-56 overflow-hidden rounded-[var(--radius-card)] bg-surface-1">
                  <video ref={stageVideo} autoPlay muted playsInline aria-label={t("jam.studio.camera")} className="h-full w-full -scale-x-100 object-cover" />
                </div>
              )}
              {studio.takeVideoUrl && (phase === "review" || phase === "posting" || phase === "done") && (
                <div className="relative aspect-video max-h-56 overflow-hidden rounded-[var(--radius-card)] bg-surface-1">
                  <video ref={takeVideo} src={studio.takeVideoUrl} muted playsInline aria-label={t("jam.studio.camera")} className="h-full w-full object-cover" />
                </div>
              )}

              <ul className="flex flex-col gap-2" aria-label={t("jam.song.tracks")}>
                {backing.map((track) => (
                  <li key={track.id} className="flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-1 p-2">
                    <StudioLaneLabel
                      instrument={track.instrument}
                      title={t(JAM_INSTRUMENT_LOOK[track.instrument].nameKey as MessageKey)}
                      sub={track.authorName ?? t("jam.tile.anonymous")}
                    />
                    <JamLaneWave
                      className="min-w-0 flex-1"
                      instrument={track.instrument}
                      peaks={track.peaks}
                      timing={track}
                      timeline={timeline}
                      clock={phase === "review" || phase === "posting" ? clock : undefined}
                      seed={track.id}
                      dimmed={recording}
                    />
                  </li>
                ))}
                <li
                  data-jam-your-lane=""
                  className={cn(
                    "flex items-center gap-3 rounded-[var(--radius-card)] p-2",
                    phase === "setup" ? "border border-dashed border-border-strong" : "bg-surface-1 ring-1 ring-inset ring-border",
                  )}
                >
                  <StudioLaneLabel
                    instrument={studio.instrument}
                    title={t(JAM_INSTRUMENT_LOOK[studio.instrument].nameKey as MessageKey)}
                    sub={recording ? t("jam.lane.recording") : t("jam.lane.you")}
                    recording={recording}
                  />
                  <div className="min-w-0 flex-1">
                    {phase === "setup" && (
                      <div className="grid h-12 place-items-center rounded-[var(--radius-control)] text-xs text-text-tertiary">
                        {t("jam.studio.yourLane")}
                      </div>
                    )}
                    {recording && (
                      <LiveLane
                        instrument={studio.instrument}
                        peaks={studio.livePeaks}
                        version={studio.livePeaksVersion}
                        timelineEndMs={timeline.endMs}
                        elapsedMs={studio.elapsedMs}
                        label={t("jam.lane.recording")}
                      />
                    )}
                    {studio.take && studio.edits && (phase === "review" || phase === "posting" || phase === "done") && (
                      <div className="jam-drop-in">
                        <JamLaneWave
                          instrument={studio.instrument}
                          peaks={takePeaks}
                          timing={{
                            offsetMs: placed(studio.take, studio.edits).offsetMs,
                            trimStartMs: studio.edits.trimStartMs,
                            trimEndMs: studio.edits.trimEndMs,
                            durationMs: studio.take.durationMs,
                          }}
                          timeline={timeline}
                          clock={clock}
                          seed="take"
                        />
                      </div>
                    )}
                  </div>
                </li>
              </ul>

              {recording && (
                <div className="max-w-sm">
                  <LevelMeter clock={studio.levelClock} active={studio.mic === "ready"} />
                </div>
              )}

              {phase === "review" && (
                <>
                  <JamTransport
                    clock={clock}
                    playing={transport === "playing"}
                    loading={false}
                    durationMs={durationMs}
                    onToggle={() => void studio.togglePlay()}
                    onSeek={(ms) => studio.engine?.player.seek(ms)}
                    title={t("jam.review.title")}
                  />
                  {studio.playError && (
                    <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                      {t("jam.studio.playError")}
                    </p>
                  )}
                  {studio.replaceTake && (
                    <div data-jam-replace="" className="rounded-[var(--radius-card)] bg-surface-1 px-4 py-1 ring-1 ring-inset ring-border">
                      <Switch
                        checked={studio.wantsReplace}
                        onCheckedChange={studio.setWantsReplace}
                        label={t("jam.review.replace", {
                          instrument: t(JAM_INSTRUMENT_LOOK[studio.instrument].nameKey as MessageKey).toLowerCase(),
                        })}
                      />
                    </div>
                  )}
                  <ReviewEditor studio={studio} />
                  {studio.take && (
                    <p data-jam-take-latency="" className="text-xs tabular-nums text-text-tertiary">
                      {t("jam.review.latencyUsed", {
                        ms: Math.round(studio.take.latency.roundTripMs * 10) / 10,
                        method: words.method(studio.take.latency.method),
                        confidence: words.confidence(studio.take.latency.confidence),
                      })}
                    </p>
                  )}
                  {studio.take?.videoError && (
                    <p role="status" className="text-xs text-text-tertiary">
                      {t("jam.review.videoLost")}
                    </p>
                  )}
                </>
              )}

              {studio.startError && (
                <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                  {t("jam.studio.startError")}
                </p>
              )}
            </div>

            {(phase === "setup" || phase === "boot") && (
              <aside className="flex min-w-0 flex-col gap-5 @4xl:border-l @4xl:border-border @4xl:pl-5" aria-label={t("jam.studio.settings")}>
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-text-secondary">{t("jam.studio.instrument")}</span>
                  <InstrumentPicker
                    value={studio.instrument}
                    options={pickable}
                    wanted={wanted}
                    onChange={studio.setInstrument}
                  />
                </div>

                {studio.devices.length > 0 && (
                  <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
                    {t("jam.studio.input")}
                    <select
                      value={studio.deviceId ?? ""}
                      onChange={(event) => void studio.chooseDevice(event.target.value)}
                      className="h-11 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-sm font-normal text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {studio.devices.map((device, index) => (
                        <option key={device.deviceId || index} value={device.deviceId}>
                          {device.label || t("jam.studio.inputUnnamed", { n: index + 1 })}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <LevelMeter clock={studio.levelClock} active={studio.mic === "ready"} />

                {!studio.needsCheck && <LatencyCard studio={studio} />}

                <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
                  {t("jam.studio.countIn")}
                  <select
                    value={studio.countIn.bars}
                    onChange={(event) => studio.setCountIn({ ...studio.countIn, bars: Number(event.target.value) as 0 | 1 | 2 })}
                    className="h-11 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-sm font-normal text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <option value={1}>{t("jam.studio.countIn.one")}</option>
                    <option value={2}>{t("jam.studio.countIn.two")}</option>
                    <option value={0}>{t("jam.studio.countIn.none")}</option>
                  </select>
                </label>
                {studio.countIn.bars > 0 && (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-semibold text-text-secondary">{t("jam.studio.tempo")}</span>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={t("jam.studio.tempoDown")}
                        onClick={() => studio.setCountIn({ ...studio.countIn, bpm: Math.max(50, studio.countIn.bpm - 5) })}
                        className="h-10 w-10 rounded-[var(--radius-control)] bg-surface-2 text-base font-bold text-text outline-none hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        -
                      </button>
                      <span className="w-14 text-center text-sm font-bold tabular-nums text-text">{t("jam.studio.bpm", { bpm: studio.countIn.bpm })}</span>
                      <button
                        type="button"
                        aria-label={t("jam.studio.tempoUp")}
                        onClick={() => studio.setCountIn({ ...studio.countIn, bpm: Math.min(200, studio.countIn.bpm + 5) })}
                        className="h-10 w-10 rounded-[var(--radius-control)] bg-surface-2 text-base font-bold text-text outline-none hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        +
                      </button>
                      <Button variant="secondary" size="sm" onClick={studio.tapTempo}>
                        {t("jam.studio.tap")}
                      </Button>
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <Switch
                    checked={studio.wantsVideo}
                    onCheckedChange={studio.setWantsVideo}
                    label={t("jam.studio.video")}
                  />
                  {studio.cameraError && (
                    <p role="status" className="flex items-center gap-1.5 text-xs text-text-tertiary">
                      <Camera className="h-3.5 w-3.5" aria-hidden />
                      {t("jam.studio.videoDenied")}
                    </p>
                  )}
                </div>
              </aside>
            )}
          </div>
        )}

        {phase === "countdown" && <Countdown beat={studio.beat} total={studio.beats} beatMs={(60 / studio.countIn.bpm) * 1000} />}
        {phase === "done" && studio.posted && (
          <DoneOverlay
            title={song ? t("jam.post.doneTitle") : t("jam.post.doneNewTitle")}
            body={studio.swapFailed ? t("jam.post.swapFailed") : t("jam.post.doneBody")}
            action={t("jam.post.view")}
            onAction={() => onPosted(studio.posted!)}
          />
        )}
      </div>

      <footer className={cn("safe-pb relative border-t border-border bg-surface-1 px-3 py-3 sm:px-5", phase === "done" && "hidden")}>
        {phase === "setup" && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-2">
            <button
              ref={recordRef}
              type="button"
              disabled={!canRecord}
              onClick={() => void studio.startRecording()}
              aria-label={t("jam.studio.record")}
              data-jam-record=""
              className="grid h-[5.25rem] w-[5.25rem] place-items-center rounded-full border-4 border-text outline-none transition-[transform,opacity] duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-4 focus-visible:ring-offset-surface-1 enabled:active:scale-[0.96] disabled:opacity-40"
            >
              <span aria-hidden className="h-9 w-9 rounded-full bg-danger" />
            </button>
            <p className="text-center text-xs text-text-tertiary [text-wrap:pretty]">
              {studio.mic === "opening"
                ? t("jam.studio.opening")
                : studio.needsCheck
                  ? t("jam.studio.checkFirst")
                  : t("jam.studio.recordHint")}
            </p>
          </div>
        )}

        {phase === "countdown" && (
          <div className="mx-auto flex max-w-md justify-center">
            <Button variant="secondary" className="h-12 rounded-full px-6" onClick={() => void studio.cancelRecording()}>
              {t("jam.studio.cancel")}
            </Button>
          </div>
        )}

        {phase === "recording" && (
          <div className="mx-auto flex max-w-md items-center justify-center gap-6">
            <Button variant="secondary" className="h-12 gap-2 rounded-full px-5" onClick={() => void studio.cancelRecording()}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("jam.studio.restart")}
            </Button>
            <button
              type="button"
              autoFocus
              onClick={() => void studio.stopRecording()}
              aria-label={t("jam.studio.stop")}
              data-jam-stop=""
              className="grid h-[5.25rem] w-[5.25rem] place-items-center rounded-full border-4 border-text outline-none transition-transform duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-4 focus-visible:ring-offset-surface-1 active:scale-[0.96]"
            >
              <Square aria-hidden className="h-8 w-8 rounded-[6px] fill-danger text-danger" />
            </button>
            <span className="w-24 max-sm:hidden" aria-hidden />
          </div>
        )}

        {phase === "review" && (
          <div className="mx-auto flex max-w-2xl flex-col gap-2 sm:flex-row-reverse">
            <button
              type="button"
              autoFocus
              onClick={() => void studio.post()}
              data-jam-post=""
              className="flex h-14 items-center justify-center gap-2.5 rounded-full bg-accent sm:flex-1 text-base font-bold text-on-accent outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.98]"
            >
              <Send className="h-5 w-5" aria-hidden />
              {t("jam.review.post")}
            </button>
            <Button variant="secondary" className="h-14 gap-2 rounded-full px-6" onClick={studio.discardTake}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("jam.review.again")}
            </Button>
          </div>
        )}

        {phase === "posting" && (
          <div className="mx-auto flex max-w-2xl flex-col gap-2" data-jam-posting="">
            {errorText ? (
              <>
                <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                  {errorText}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button className="h-12 rounded-full px-6" onClick={() => void studio.post()} data-jam-retry="">
                    {t("jam.post.retry")}
                  </Button>
                  {studio.take?.video && (
                    <Button variant="secondary" className="h-12 rounded-full px-5" onClick={studio.postWithoutVideo}>
                      {t("jam.post.withoutVideo")}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(studio.progress.fraction * 100)}
                  aria-label={progressText}
                  className="h-2 overflow-hidden rounded-full bg-surface-2"
                >
                  <div
                    className="h-full origin-left rounded-full bg-accent transition-transform duration-[var(--duration-base)]"
                    style={{ transform: `scaleX(${Math.max(0.04, studio.progress.fraction)})`, width: "100%" }}
                  />
                </div>
                <p className="flex items-center justify-center gap-2 text-sm text-text-secondary" aria-live="polite">
                  {phase === "posting" && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
                  {progressText}
                </p>
              </>
            )}
          </div>
        )}
      </footer>

      <ConfirmDialog
        open={confirmLeave !== null}
        title={confirmLeave === "recording" ? t("jam.studio.leaveRecordingTitle") : t("jam.studio.leaveTitle")}
        description={confirmLeave === "recording" ? t("jam.studio.leaveRecordingBody") : t("jam.studio.leaveBody")}
        confirmLabel={t("jam.studio.leave")}
        cancelLabel={confirmLeave === "recording" ? t("jam.studio.keepRecording") : t("jam.keep")}
        onClose={() => setConfirmLeave(null)}
        onConfirm={() => {
          const wasRecording = confirmLeave === "recording";
          setConfirmLeave(null);
          if (wasRecording) {
            void studio.cancelRecording().then(onClose);
          } else {
            onClose();
          }
        }}
      />
    </div>
  );
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
