import type { JamInstrument, JamSongSummary, JamTrack } from "@pqp/shared";
import { ArrowLeft, Camera, Check, ChevronDown, Loader2, MicOff, RotateCcw, Send, SlidersHorizontal, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useEngineClock } from "@/hooks/use-jam-clock";
import { useJamPublication } from "@/hooks/use-jam-publication";
import { useJamStudio, type NewSongDraft } from "@/hooks/use-jam-studio";
import { useJamPublicMe } from "@/lib/jam-public-store";
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
import { coverGradient } from "./jam-art";
import { JamClipEditor } from "./jam-clip-editor";
import { JamLaneWave } from "./jam-lane-wave";
import { formatList } from "./jam-need";
import { JamLaneFrame, JamLaneIdentity, JAM_BAND_BOX } from "./jam-lane-frame";
import { bandOf, Ruler } from "./jam-song-panel";
import {
  Countdown,
  DoneOverlay,
  InstrumentPicker,
  LatencyCard,
  LatencyChip,
  LatencyCheck,
  LevelMeter,
  LevelRing,
  LiveLane,
  StudioTip,
  useLatencyWords,
} from "./jam-studio-parts";
import { JamTransport } from "./jam-transport";

/**
 * The studio: where a part is recorded, over a song or as the first track of a
 * new one. The flow is one line: pick what you play (pre-selected), hit the big
 * button, play, stop, hear it with the band, send. The band can be heard (and
 * paused) before recording; the song panel behind is silenced when the studio
 * opens. After a take, "Mandar pra banda" is the one big button; adjusting is a
 * smaller one beside the take, and it is done on the take itself.
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
  /** Leave the studio and the song under it, for the wall: a song closed to new takes has nothing to send to. */
  onLeaveToWall?: () => void;
  /**
   * Moves each time the browser's Back left the studio's history entry while it
   * is open. The studio asks about unsent work, like its own arrow does, and
   * says `onStay` when the person keeps it (the entry is put back).
   */
  leaveTick?: number;
  onStay?: () => void;
  /** The take is on the song: go and look at it. */
  onPosted: (posted: { songId: string; trackId: string }) => void;
  /**
   * Opened from a public jam outside any channel: the take carries the
   * person's consent, and a new song is a standalone public jam.
   */
  publicAccess?: boolean;
  /** The song's starter lets outside takes in by themselves (changes what an outside take is told). */
  autoAcceptOutside?: boolean;
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
  onLeaveToWall,
  leaveTick = 0,
  onStay,
  onPosted,
  publicAccess = false,
  autoAcceptOutside = false,
}: JamStudioProps) {
  const { t, locale } = useTranslation();
  const backing = useMemo(() => tracks.filter((track) => track.inMix), [tracks]);
  const known = useRef<JamSongSummary | null>(song);
  if (song) {
    known.current = song;
  }
  // A channel's song that is public asks the same of whoever records on it as a public view does.
  const publicMe = useJamPublicMe();
  const publication = useJamPublication(song?.id ?? "", publicMe.enabled && !publicAccess && song !== null);
  const songIsPublic =
    publicMe.enabled &&
    (publicAccess || ["live", "review", "hidden"].includes(publication.publication?.status ?? ""));
  // A channel song whose public state could not be read yet: a take posted now could miss its consent.
  const publicUnknown =
    publicMe.enabled && !publicAccess && song !== null && (publication.loading || publication.lookupFailed);
  const refreshPublication = publication.refresh;
  useEffect(() => {
    if (!publication.lookupFailed) {
      return;
    }
    // Until it answers: one retry that fails must not leave the send blocked for good.
    const timer = window.setInterval(() => void refreshPublication(), 4000);
    return () => window.clearInterval(timer);
  }, [publication.lookupFailed, refreshPublication]);
  const outsideTake = publicAccess && song !== null && song.channelId === null && !canSwitchMix;
  const studio = useJamStudio({
    publicTake: songIsPublic,
    publicUnknown,
    standalone: publicAccess && song === null,
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
  /** A take with no sound is sent only after the person says so. */
  const [confirmSilent, setConfirmSilent] = useState(false);
  /** The leave question was asked because Back was pressed: saying "keep" puts the studio's history entry back. */
  const askedByBack = useRef(false);
  const leaveConfirmed = useRef(false);
  const [editing, setEditing] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  /** Lanes of the band the person muted in their ear (never sent anywhere). */
  const [mutedLanes, setMutedLanes] = useState<ReadonlySet<string>>(new Set());
  function toggleLaneMute(trackId: string) {
    setMutedLanes((before) => {
      const next = new Set(before);
      const muted = !next.has(trackId);
      if (muted) next.add(trackId);
      else next.delete(trackId);
      studio.engine?.player.updateStem(trackId, { muted });
      return next;
    });
  }
  const recordRef = useRef<HTMLButtonElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Opening the studio puts the keyboard in it (the wall behind is inert, so focus
  // would otherwise fall to the page): onto the studio itself, so the first Tab is
  // its own back button. Closing it hands focus back to whatever opened it.
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && !document.activeElement.closest("[data-jam-studio]") ? document.activeElement : null;
    // The opener may be re-drawn while the studio is open (the song refreshes under it), so what
    // identifies it is remembered too: a lane's own record button, the dock's, the wall's.
    const marks = ["data-jam-slot-record", "data-jam-record-over", "data-jam-new-song", "data-jam-empty-record"];
    const mark = opener ? marks.find((name) => opener.hasAttribute(name)) : undefined;
    const again = opener && mark ? `[${mark}="${opener.getAttribute(mark)}"]` : null;
    root.current?.focus({ preventScroll: true });
    return () => {
      // After the pane has made the song live again (it is inert while the studio is open).
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) {
          return;
        }
        const found = opener?.isConnected ? opener : again ? document.querySelector<HTMLElement>(again) : null;
        if (found) {
          found.focus({ preventScroll: true });
        } else {
          document.querySelector<HTMLElement>("[data-jam-record-over], [data-jam-new-song]")?.focus({ preventScroll: true });
        }
      }, 80);
    };
  }, []);
  // The delay suggestion answered (measured or "Agora não"): back to the top,
  // where the instrument and the band are, instead of a page scrolled to nothing.
  const wasChecking = useRef(false);
  useEffect(() => {
    if (wasChecking.current && !studio.needsCheck) {
      scroller.current?.scrollTo?.({ top: 0, behavior: "smooth" });
    }
    wasChecking.current = studio.needsCheck;
  }, [studio.needsCheck]);

  useEffect(() => {
    setJamHintContext({ studio: true });
    return () => setJamHintContext({ studio: false });
  }, []);

  const phase = studio.phase;
  const recording = phase === "countdown" || phase === "recording";
  const reviewing = phase === "review" || phase === "posting";
  const names = Array.from(
    new Set(backing.filter((track) => track.authorId !== viewerId).map((track) => track.authorName ?? t("jam.tile.anonymous"))),
  );
  const instrumentName = t(JAM_INSTRUMENT_LOOK[studio.instrument].nameKey as MessageKey);
  // A new song is "Música nova" until it exists, and is itself once it does.
  const created = phase === "done" && !song && draft !== null;
  const title = song
    ? song.title
    : created
      ? draft!.title
      : (draft?.title ?? t("jam.studio.new"));
  const subtitle = song
    ? names.length > 0
      ? t("jam.studio.over", { names: formatList(names, locale) })
      : (song.artist ?? "")
    : created
      ? (draft?.artist ?? t("jam.original"))
      : t("jam.studio.newSub");
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
        ? liveTimelineEndMs(backingEnd, 0)
        : Math.max(liveTimelineEndMs(backingEnd, 0), takeEnd),
  };
  const takePeaks = useMemo(() => (studio.take ? computePeaks([studio.take.samples]) : []), [studio.take]);
  const band = useMemo(() => bandOf(backing, null), [backing]);
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

  // A new take starts with the editor shut: posting needs none of it.
  useEffect(() => {
    if (phase !== "review") {
      setEditing(false);
    }
  }, [phase]);

  function requestClose() {
    // A live recording is as much somebody's work as a take waiting to be sent:
    // both ask first.
    if (recording) {
      setConfirmLeave("recording");
      return;
    }
    if (reviewing) {
      setConfirmLeave("take");
      return;
    }
    onClose();
  }

  // The browser's Back (or the phone's) from the studio asks what the arrow in
  // the corner asks. Nothing to lose, it just goes.
  const seenLeaveTick = useRef(leaveTick);
  useEffect(() => {
    if (leaveTick === seenLeaveTick.current) {
      return;
    }
    seenLeaveTick.current = leaveTick;
    askedByBack.current = recording || reviewing;
    requestClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a tick, not a render
  }, [leaveTick]);

  // Escape leaves, the way every other panel does, after the same question.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && confirmLeave === null && !soundOpen && phase !== "done") {
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
    const timer = window.setTimeout(() => onPosted(posted), 6500);
    return () => window.clearTimeout(timer);
  }, [phase, studio.posted, onPosted]);

  const micProblem =
    studio.mic === "denied"
      ? t("jam.mic.denied")
      : studio.mic === "none"
        ? t("jam.mic.none")
        : studio.mic === "error"
          ? t("jam.mic.error")
          : studio.mic === "lost"
            ? t("jam.mic.lost")
            : null;

  const canRecord = studio.mic === "ready" && phase === "setup" && studio.check !== "measuring";
  const progressText =
    studio.progress.stage === "claiming"
      ? t("jam.post.claiming")
      : t("jam.post.uploading", { percent: Math.round(studio.progress.fraction * 100) });
  const errorText = studio.postError ? t(`jam.error.${studio.postError}` as MessageKey) : null;
  const playingNow = transport === "playing";
  /** The camera is on, or a take with a picture is being looked at. */
  const videoOn = Boolean(studio.camera) || Boolean(studio.takeVideoUrl && (reviewing || phase === "done"));

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-jam-studio=""
      data-phase={phase}
      className="jam-panel-in @container absolute inset-0 z-30 flex flex-col bg-surface-0 outline-none max-sm:fixed max-sm:z-50"
    >
      <header className="flex items-center gap-2.5 border-b border-border bg-surface-1 px-2 py-2 sm:px-4 [@media(max-height:32rem)]:py-1">
        <button
          type="button"
          onClick={requestClose}
          aria-label={t("jam.studio.close")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <span
          aria-hidden
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] text-on-inst max-sm:hidden",
            coverGradient([studio.instrument]),
          )}
        >
          {(() => {
            const Icon = JAM_INSTRUMENT_LOOK[studio.instrument].icon;
            return <Icon className="h-5 w-5" />;
          })()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h2 className="truncate font-display text-lg font-extrabold text-text">{title}</h2>
          {subtitle && <p className="truncate text-xs text-text-secondary">{subtitle}</p>}
        </div>
        {phase !== "unsupported" && phase !== "done" && <LatencyChip studio={studio} />}
        {(phase === "setup" || phase === "boot") && (
          <button
            type="button"
            onClick={() => setSoundOpen(true)}
            data-jam-sound=""
            className="flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-semibold text-text-secondary outline-none ring-1 ring-inset ring-border transition-colors hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            <span className="max-sm:hidden">{t("jam.studio.settings")}</span>
          </button>
        )}
      </header>

      <div ref={scroller} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {phase === "unsupported" ? (
          <div className="grid min-h-full place-items-center p-8 text-center">
            <p role="alert" className="max-w-sm text-sm leading-relaxed text-text-secondary">
              {t("jam.studio.unsupported")}
            </p>
          </div>
        ) : (
          <div
            className={cn(
              "mx-auto flex w-full flex-col gap-6 p-3 pb-10 sm:p-6 sm:pb-12 [@media(max-height:32rem)]:gap-3 [@media(max-height:32rem)]:pb-4",
              videoOn ? "max-w-5xl" : "max-w-3xl",
            )}
          >
            <div className="@container flex min-w-0 flex-col gap-5 [@media(max-height:32rem)]:gap-3">
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

              {studio.micLost && (
                <p
                  role="alert"
                  data-jam-mic-lost={studio.micLost}
                  className="rounded-[var(--radius-control)] bg-warning-soft px-3 py-2 text-sm font-semibold leading-snug text-on-warning-soft"
                >
                  {studio.micLost === "kept" ? t("jam.studio.micLostKept") : t("jam.studio.micLostEmpty")}
                </p>
              )}

              {studio.songClosed && (
                <div
                  role="alert"
                  data-jam-song-closed=""
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-warning-soft p-4 text-on-warning-soft"
                >
                  <p className="text-sm font-semibold leading-snug">{t("jam.post.closedBody")}</p>
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
                      data-jam-back-to-wall=""
                      onClick={() => {
                        studio.discardTake();
                        (onLeaveToWall ?? onClose)();
                      }}
                    >
                      {t("jam.post.backToWall")}
                    </Button>
                  </div>
                </div>
              )}

              {studio.songGone && (
                <div
                  role="alert"
                  data-jam-song-deleted=""
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-warning-soft p-4 text-on-warning-soft"
                >
                  <p className="text-sm font-semibold leading-snug">{t("jam.studio.songDeleted")}</p>
                  {reviewing && (
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

              {/* what the screen is asking right now, in one line */}
              {phase !== "boot" && (
                <div className="flex flex-col gap-1" data-jam-stage-title="">
                  <h3 className="font-display text-2xl font-extrabold tracking-[-0.01em] text-text [text-wrap:balance] sm:text-3xl [@media(max-height:32rem)]:text-xl">
                    {phase === "setup"
                      ? t("jam.studio.stage.setup")
                      : recording
                        ? t("jam.studio.stage.recording", { instrument: instrumentName.toLowerCase() })
                        : t("jam.studio.stage.review")}
                  </h3>
                  <p className="text-sm text-text-secondary [text-wrap:pretty] [@media(max-height:32rem)]:hidden">
                    {phase === "setup"
                      ? backing.length > 0
                        ? t("jam.studio.stage.setupBody")
                        : t("jam.studio.stage.setupBodyAlone")
                      : recording
                        ? t("jam.studio.stage.recordingBody")
                        : t("jam.studio.stage.reviewBody")}
                  </p>
                </div>
              )}

              {phase === "setup" && (
                <div className="flex flex-col gap-2">
                  {wanted.length > 0 && (
                    <p data-jam-asked-note="" className="text-[13px] font-medium text-text-secondary [text-wrap:pretty]">
                      {t("jam.studio.askedFor", {
                        list: formatList(
                          wanted.map((one) => t(JAM_INSTRUMENT_LOOK[one].nameKey as MessageKey).toLowerCase()),
                          locale,
                        ),
                      })}
                    </p>
                  )}
                  <InstrumentPicker value={studio.instrument} options={pickable} wanted={wanted} onChange={studio.setInstrument} />
                </div>
              )}

              {phase === "setup" && !studio.needsCheck && studio.mic === "ready" && <StudioTip />}

              {/* with the camera on, the picture sits beside the band on a wide screen, so the lanes stay above the fold */}
              <div className={cn("flex min-w-0 flex-col gap-5 [@media(max-height:32rem)]:gap-3", videoOn && "lg:grid lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start")}>
              <div className="flex min-w-0 flex-col gap-5 empty:hidden">
              {/* the camera, on the setup step itself: it used to live behind "Teu som" and went unseen */}
              {phase === "setup" && (
                <div
                  data-jam-video=""
                  className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-surface-1 px-3 py-1 ring-1 ring-inset ring-border"
                >
                  <Switch
                    checked={studio.wantsVideo}
                    onCheckedChange={studio.setWantsVideo}
                    label={t("jam.studio.video")}
                    description={t("jam.studio.videoHint")}
                  />
                  {studio.cameraError && (
                    <p role="status" className="flex items-center gap-1.5 px-2 pb-2 text-xs text-text-secondary">
                      <Camera className="h-3.5 w-3.5" aria-hidden />
                      {t("jam.studio.videoDenied")}
                    </p>
                  )}
                </div>
              )}

              {studio.camera && (phase === "setup" || recording) && (
                <div className="relative mx-auto aspect-video w-full max-w-[min(42rem,80vh)] overflow-hidden rounded-[var(--radius-card)] bg-surface-1 lg:max-w-none">
                  <video ref={stageVideo} autoPlay muted playsInline aria-label={t("jam.studio.camera")} className="h-full w-full -scale-x-100 object-cover" />
                </div>
              )}
              {studio.takeVideoUrl && (reviewing || phase === "done") && (
                <div className="relative mx-auto aspect-video w-full max-w-[min(42rem,80vh)] overflow-hidden rounded-[var(--radius-card)] bg-surface-1 lg:max-w-none">
                  <video ref={takeVideo} src={studio.takeVideoUrl} muted playsInline aria-label={t("jam.studio.camera")} className="h-full w-full object-cover" />
                </div>
              )}
              </div>

              {/* the band, and the lane the take goes into */}
              <div
                className={cn(
                  "flex flex-col gap-3 rounded-[var(--radius-panel)] bg-surface-1 p-3 ring-1 ring-inset sm:p-4",
                  "ring-border",
                )}
              >
                {(phase === "setup" || reviewing) && (backing.length > 0 || reviewing) && (
                  <JamTransport
                    clock={clock}
                    playing={playingNow}
                    loading={!studio.engine}
                    durationMs={durationMs || timeline.endMs}
                    onToggle={() => void studio.togglePlay()}
                    onSeek={(ms) => studio.engine?.player.seek(ms)}
                    title={reviewing ? t("jam.review.title") : t("jam.studio.hearBand")}
                    caption={reviewing ? t("jam.studio.withBand") : t("jam.studio.hearBandHint")}
                    scrubber={false}
                  />
                )}
                {studio.playError && (
                  <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                    {t("jam.studio.playError")}
                  </p>
                )}
                <div className={cn("relative [--lane-ctl:2.5rem]", JAM_BAND_BOX)}>
                <Ruler timeline={timeline} onSeek={(fraction) => !recording && studio.engine?.player.seek(fraction * (timeline.endMs - timeline.startMs))} />
                <ul className="flex flex-col gap-1" aria-label={t("jam.song.tracks")}>
                  <li data-jam-your-lane="" className="rounded-[var(--radius-card)] p-1.5">
                    <JamLaneFrame
                      identity={
                    <YourLaneIdentity
                      instrument={studio.instrument}
                      recording={recording}
                      review={
                        phase === "review" && studio.take
                          ? {
                              latency: t("jam.review.latencyUsed", {
                                ms: Math.round(studio.take.latency.roundTripMs),
                                method: words.method(studio.take.latency.method),
                                confidence: words.confidence(studio.take.latency.confidence),
                              }),
                              editing,
                              edited: studio.edited,
                              onAdjust: () => setEditing((open) => !open),
                            }
                          : null
                      }
                    />
                      }
                      controls={
                        phase === "review" && studio.take ? (
                          <Tooltip label={t("jam.take.adjust")}>
                            <button
                              type="button"
                              onClick={() => setEditing((open) => !open)}
                              aria-pressed={editing}
                              aria-label={t("jam.take.adjustMine")}
                              data-jam-edit-open=""
                              className={cn(LANE_ICON_BUTTON, editing && "bg-text text-surface-0 hover:bg-text hover:text-surface-0")}
                            >
                              <SlidersHorizontal className="h-4 w-4" aria-hidden />
                            </button>
                          </Tooltip>
                        ) : null
                      }
                      wave={
                    <div className="min-w-0">
                      {phase === "setup" || phase === "boot" ? (
                        <div
                          className={cn(
                            "jam-howto-you flex h-[3.25rem] items-center justify-center rounded-[var(--radius-control)] border-2 border-dashed border-current text-[13px] font-bold",
                            JAM_INSTRUMENT_LOOK[studio.instrument].ink,
                          )}
                        >
                          <span>{t("jam.studio.yourLane")}</span>
                        </div>
                      ) : null}
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
                      {studio.take && studio.edits && (reviewing || phase === "done") && (
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
                            playhead
                          />
                        </div>
                      )}
                    </div>
                      }
                    />
                  </li>
                  {backing.map((track, index) => (
                    <li
                      key={track.id}
                      style={{ "--jam-l": index } as CSSProperties}
                      className="jam-lane-in rounded-[var(--radius-card)] p-1.5"
                    >
                      <JamLaneFrame
                        identity={<StudioLaneIdentity track={track} mine={viewerId !== null && track.authorId === viewerId} />}
                        controls={
                          <StudioLaneMute
                            track={track}
                            mine={viewerId !== null && track.authorId === viewerId}
                            muted={mutedLanes.has(track.id)}
                            onMute={() => toggleLaneMute(track.id)}
                          />
                        }
                        wave={
                          <JamLaneWave
                            instrument={track.instrument}
                            peaks={track.peaks}
                            timing={track}
                            timeline={timeline}
                            clock={playingNow || reviewing || recording ? clock : undefined}
                            seed={track.id}
                            dimmed={mutedLanes.has(track.id)}
                            playhead
                          />
                        }
                      />
                    </li>
                  ))}
                </ul>
                </div>
              </div>
              </div>




              {phase === "review" && (
                <>
                  {studio.replaceTake && (
                    <div data-jam-replace="" className="rounded-[var(--radius-card)] bg-surface-1 px-4 py-1 ring-1 ring-inset ring-border">
                      <Switch
                        checked={studio.wantsReplace}
                        onCheckedChange={studio.setWantsReplace}
                        label={t("jam.review.replace", { instrument: instrumentName.toLowerCase() })}
                      />
                    </div>
                  )}
                  {studio.publicTake && (
                    <div data-jam-public-take="" className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-surface-1 px-4 py-2.5 ring-1 ring-inset ring-border">
                      <p className="text-[13px] font-semibold leading-snug text-text-secondary">
                        {outsideTake
                          ? autoAcceptOutside
                            ? t("jam.public.studio.outsideAuto")
                            : t("jam.public.studio.outside")
                          : t("jam.public.studio.public")}
                      </p>
                      {studio.take?.video && (
                        <Switch
                          checked={studio.shareVideo}
                          onCheckedChange={studio.setShareVideo}
                          label={t("jam.public.studio.shareVideo")}
                          description={studio.shareVideo ? t("jam.public.studio.shareVideoOn") : t("jam.public.studio.shareVideoOff")}
                        />
                      )}
                    </div>
                  )}
                  {studio.take && studio.edits && (
                    <div data-jam-edit="" data-open={editing ? "true" : "false"} className="flex flex-col gap-3">
                      {editing ? (
                        <div className="jam-drop-in flex flex-col gap-3 rounded-[var(--radius-panel)] bg-surface-1 p-4 ring-1 ring-inset ring-border">
                          <h4 className="text-sm font-extrabold text-text">{t("jam.review.editTitle")}</h4>
                          <JamClipEditor
                            instrument={studio.instrument}
                            peaks={takePeaks}
                            source={{
                              baseOffsetMs: studio.take.offsetMs,
                              durationMs: studio.take.durationMs,
                              minTrimStartMs: studio.take.trimStartMs,
                            }}
                            edits={studio.edits}
                            band={band}
                            clock={clock}
                            onTrimStart={studio.setTrimStart}
                            onTrimEnd={studio.setTrimEnd}
                            onNudge={studio.setNudge}
                            onGain={studio.setGain}
                            onReset={studio.resetEdits}
                            edited={studio.edited}
                          />
                        </div>
                      ) : null}
                    </div>
                  )}
                  {studio.take?.videoError && (
                    <p role="status" className="text-xs text-text-secondary">
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


          </div>
        )}

        {phase === "countdown" && <Countdown beat={studio.beat} total={studio.beats} beatMs={(60 / studio.countIn.bpm) * 1000} />}
        {phase === "done" && studio.posted && (
          <DoneOverlay
            title={song ? t("jam.post.doneTitle") : t("jam.post.doneNewTitle")}
            body={
              studio.swapFailed
                ? t("jam.post.swapFailed")
                : outsideTake
                  ? autoAcceptOutside
                    ? t("jam.public.studio.doneOutsideAuto")
                    : t("jam.public.studio.doneOutside")
                  : t("jam.post.doneBody")
            }
            action={t("jam.post.view")}
            onAction={() => onPosted(studio.posted!)}
          />
        )}
      </div>

      <footer className={cn("safe-pb relative border-t border-border bg-surface-1 px-3 py-4 sm:px-6 [@media(max-height:32rem)]:py-2", phase === "done" && "hidden")}>
        {phase === "setup" && studio.needsCheck && (
          <div className="mx-auto mb-3 max-w-3xl">
            <LatencyCheck studio={studio} />
          </div>
        )}
        {phase === "setup" && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-1.5">
            <button
              ref={recordRef}
              type="button"
              disabled={!canRecord}
              onClick={() => {
                if (studio.needsCheck) {
                  studio.skipCheck();
                }
                void studio.startRecording();
              }}
              aria-label={t("jam.studio.record")}
              data-jam-record=""
              className="group relative grid h-20 w-20 place-items-center rounded-full bg-surface-0 shadow-[var(--shadow-2)] ring-4 ring-text outline-none [@media(max-height:32rem)]:h-14 [@media(max-height:32rem)]:w-14 [@media(max-height:32rem)]:ring-[3px] transition-[transform,opacity] duration-[var(--duration-fast)] focus-visible:ring-focus-ring enabled:hover:scale-[1.04] enabled:active:scale-[0.95] disabled:opacity-40"
            >
              {canRecord && <LevelRing clock={studio.levelClock} />}
              <span aria-hidden className="h-12 w-12 rounded-full bg-danger transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] group-enabled:group-hover:scale-90 [@media(max-height:32rem)]:h-8 [@media(max-height:32rem)]:w-8" />
            </button>
            <p className="text-center text-[13px] font-semibold text-text-secondary [text-wrap:pretty] [@media(max-height:32rem)]:hidden">
              {studio.mic === "opening" ? t("jam.studio.opening") : t("jam.studio.recordHint")}
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
          <div className="mx-auto grid max-w-3xl grid-cols-[1fr_auto_1fr] items-center gap-6">
            <Button variant="ghost" className="h-12 gap-2 justify-self-start rounded-full px-4 text-text-secondary" onClick={() => void studio.cancelRecording()}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("jam.studio.restart")}
            </Button>
            <button
              type="button"
              autoFocus
              onClick={() => void studio.stopRecording()}
              aria-label={t("jam.studio.stop")}
              data-jam-stop=""
              className="relative grid h-20 w-20 place-items-center rounded-full bg-danger text-on-danger shadow-[var(--shadow-2)] outline-none [@media(max-height:32rem)]:h-14 [@media(max-height:32rem)]:w-14 transition-transform duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-4 focus-visible:ring-offset-surface-1 hover:scale-[1.04] active:scale-[0.95]"
            >
              <LevelRing clock={studio.levelClock} />
              <Square aria-hidden className="relative h-7 w-7 fill-current" />
            </button>
            <span
              role="timer"
              aria-label={t("jam.studio.recording", { time: formatTime(studio.elapsedMs) })}
              className="font-display text-3xl font-extrabold tabular-nums text-text"
            >
              {formatTime(studio.elapsedMs)}
            </span>
          </div>
        )}

        {phase === "review" && (
          <div className="mx-auto flex max-w-2xl flex-col gap-2 sm:flex-row-reverse sm:items-center">
            <button
              type="button"
              autoFocus
              onClick={() => (studio.silent ? setConfirmSilent(true) : void studio.post())}
              data-jam-post=""
              className="group flex h-16 items-center justify-center gap-3 rounded-full bg-accent text-lg font-extrabold text-on-accent shadow-[var(--shadow-2)] outline-none transition-[transform,box-shadow] duration-[var(--duration-fast)] hover:shadow-[var(--shadow-3)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 motion-safe:hover:scale-[1.01] active:scale-[0.98] sm:flex-1"
            >
              <Send className="h-5 w-5 transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5" aria-hidden />
              {t("jam.review.post")}
            </button>
            <Button variant="ghost" className="h-12 gap-2 rounded-full px-5 text-text-secondary" onClick={studio.discardTake} data-jam-again="">
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("jam.review.again")}
            </Button>
          </div>
        )}

        {phase === "posting" && (
          <div className="mx-auto flex max-w-2xl flex-col gap-2" data-jam-posting="">
            {errorText ? (
              <>
                {!studio.songClosed && (
                  <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                    {errorText}
                  </p>
                )}
                {/* The take is kept: every way out is here, not only "try again". A song closed meanwhile can never take it, so no retry. */}
                <div className="flex flex-wrap justify-center gap-2" data-jam-post-failed="">
                  {!studio.songClosed && !studio.songGone && (
                    <Button className="h-12 rounded-full px-6" onClick={() => void studio.post()} data-jam-retry="">
                      {t("jam.post.retry")}
                    </Button>
                  )}
                  {studio.take?.video && !studio.songClosed && (
                    <Button variant="secondary" className="h-12 rounded-full px-5" onClick={studio.postWithoutVideo}>
                      {t("jam.post.withoutVideo")}
                    </Button>
                  )}
                  <Button variant="secondary" className="h-12 rounded-full px-5" onClick={studio.backToReview} data-jam-back-to-take="">
                    {t("jam.post.backToTake")}
                  </Button>
                  <Button variant="ghost" className="h-12 gap-2 rounded-full px-5 text-text-secondary" onClick={studio.discardTake} data-jam-again="">
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    {t("jam.review.again")}
                  </Button>
                  <Button variant="ghost" className="h-12 rounded-full px-5 text-text-secondary" onClick={() => setConfirmLeave("take")} data-jam-discard="">
                    {t("jam.studio.discardTake")}
                  </Button>
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
                  <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  {progressText}
                </p>
              </>
            )}
          </div>
        )}
      </footer>

      <Dialog open={soundOpen} title={t("jam.studio.settings")} size="md" onClose={() => setSoundOpen(false)}>
        <DialogBody>
          <div className="@container flex flex-col gap-4" data-jam-sound-panel="">
                  <div className="grid gap-4 @lg:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-4">
                      {studio.devices.length > 0 && (
                        <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
                          {t("jam.studio.input")}
                          <span className="relative">
                            <select
                              value={studio.deviceId ?? ""}
                              onChange={(event) => void studio.chooseDevice(event.target.value)}
                              className="h-11 w-full appearance-none truncate rounded-full border border-border bg-surface-2 pl-4 pr-10 text-sm font-semibold text-text outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
                            >
                              {studio.devices.map((device, index) => (
                                <option key={device.deviceId || index} value={device.deviceId}>
                                  {device.label || t("jam.studio.inputUnnamed", { n: index + 1 })}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" aria-hidden />
                          </span>
                        </label>
                      )}
                      <LevelMeter clock={studio.levelClock} active={studio.mic === "ready"} />
                    </div>
                    <div className="flex flex-col divide-y divide-border self-start rounded-[var(--radius-card)] bg-surface-2/60 px-3">
                      <Switch
                        checked={studio.countIn.bars > 0}
                        onCheckedChange={(on) => studio.setCountIn({ ...studio.countIn, bars: on ? 1 : 0 })}
                        label={t("jam.studio.countIn")}
                        description={t("jam.studio.countInHint")}
                      />
                    </div>
                  </div>
                  {studio.needsCheck ? <LatencyCheck studio={studio} /> : <LatencyCard studio={studio} />}
          </div>
        </DialogBody>
      </Dialog>
      <ConfirmDialog
        open={confirmSilent}
        title={t("jam.review.silentTitle")}
        description={t("jam.review.silentBody")}
        confirmLabel={t("jam.review.silentSend")}
        destructive={false}
        onClose={() => setConfirmSilent(false)}
        onConfirm={() => {
          setConfirmSilent(false);
          void studio.post();
        }}
      />
      <ConfirmDialog
        open={confirmLeave !== null}
        title={confirmLeave === "recording" ? t("jam.studio.leaveRecordingTitle") : t("jam.studio.leaveTitle")}
        description={confirmLeave === "recording" ? t("jam.studio.leaveRecordingBody") : t("jam.studio.leaveBody")}
        confirmLabel={t("jam.studio.leave")}
        cancelLabel={confirmLeave === "recording" ? t("jam.studio.keepRecording") : t("jam.keep")}
        onClose={() => {
          setConfirmLeave(null);
          // Back was pressed and the person kept the work: the studio gets its entry back.
          if (askedByBack.current && !leaveConfirmed.current) {
            onStay?.();
          }
          askedByBack.current = false;
          leaveConfirmed.current = false;
        }}
        onConfirm={() => {
          const wasRecording = confirmLeave === "recording";
          leaveConfirmed.current = true;
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

/** 32 px with a pointer, 44 px under a finger: the studio lane's icon buttons. */
const LANE_ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none transition-colors duration-[var(--duration-fast)] hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11";

/** Who plays a backing lane: the instrument's badge, its name, and the person under it. */
function StudioLaneIdentity({ track, mine }: { track: JamTrack; mine: boolean }) {
  const { t } = useTranslation();
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  return <JamLaneIdentity instrument={track.instrument} sub={person} subTitle={person} />;
}

function StudioLaneMute({
  track,
  mine,
  muted,
  onMute,
}: {
  track: JamTrack;
  mine: boolean;
  muted: boolean;
  onMute: () => void;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[track.instrument];
  const person = mine ? t("jam.lane.you") : (track.authorName ?? t("jam.tile.anonymous"));
  const name = `${t(look.nameKey as MessageKey)}, ${person}`;
  const label = muted ? t("jam.lane.unmute", { name }) : t("jam.lane.mute", { name });
  return (
    <span className="rounded-full bg-surface-2 px-0.5">
    <Tooltip label={label}>
      <button
        type="button"
        aria-pressed={muted}
        aria-label={label}
        onClick={onMute}
        data-jam-studio-mute=""
        className={cn(LANE_ICON_BUTTON, muted && "bg-warning-soft text-on-warning-soft hover:bg-warning-soft hover:text-on-warning-soft")}
      >
        <span aria-hidden="true" className="text-[13px] font-extrabold leading-none">M</span>
      </button>
    </Tooltip>
    </span>
  );
}

function YourLaneIdentity({
  instrument,
  recording,
  review,
}: {
  instrument: JamInstrument;
  recording: boolean;
  /** After the take: it landed in time (the numbers in the tooltip). */
  review: { latency: string; editing: boolean; edited: boolean; onAdjust: () => void } | null;
}) {
  const { t } = useTranslation();
  const sub = review ? (
    <Tooltip label={review.latency}>
      <span
        tabIndex={0}
        data-jam-take-latency=""
        className="inline-flex w-fit max-w-full items-center gap-1 whitespace-nowrap rounded-full align-top text-xs font-semibold text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Check className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={3} aria-hidden />
        <span className="truncate">{review.edited ? t("jam.review.editedShort") : t("jam.review.onTimeShort")}</span>
      </span>
    </Tooltip>
  ) : (
    <span className={cn(recording && "font-bold text-danger")}>{recording ? t("jam.lane.recording") : t("jam.lane.you")}</span>
  );
  return <JamLaneIdentity instrument={instrument} sub={sub} recording={recording} />;
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
