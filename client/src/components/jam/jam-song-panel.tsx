import type { JamFrame, JamInstrument, JamSongSummary, JamTrack, JamVoteResponse } from "@pqp/shared";
import { ArrowLeft, Camera, Link2, Lock, LockOpen, Mic, MoreHorizontal, Pencil, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { useJamPlayback } from "@/hooks/use-jam-playback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  deleteJamSong,
  deleteJamTrack,
  jamErrorKind,
  updateJamSong,
  updateJamTrack,
  voteJamTrack,
} from "@/lib/jam-api";
import type { BandLane } from "@/lib/jam-clip";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cannotRecordReason, pickInstrument } from "@/lib/jam-record";
import { dropInboxTake } from "@/lib/jam-public-store";
import { notePublicPlay } from "@/lib/jam-public-api";
import { oneAtATime, switchTakeIn } from "@/lib/jam-mix";
import {
  applyJamVote,
  applyJamWrite,
  loadJamChannel,
  loadJamDetail,
  readJamChannel,
  rereadJamTracks,
  useJamStoreEpoch,
} from "@/lib/jam-store";
import type { JamDetail } from "@/lib/jam-state";
import { competingInstruments, formatClock, orderTracks, songNeed, songTimeline } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { ContributorStack, Equalizer } from "./jam-art";
import { useBarCount } from "./jam-bars";
import { JamArtwork } from "./jam-artwork";
import { JamCoverPhoto, useJamCover, type JamCoverState } from "./jam-cover";
import { JamEditSheet } from "./jam-edit-sheet";
import { JamSharePicker } from "./jam-share-picker";
import { useJamPublicPanel } from "./jam-public-panel";
import { JamPublicRequests } from "./jam-public-parts";
import { JamLaneFrame, JamLaneIdentity, JAM_BAND_BOX } from "./jam-lane-frame";
import { JamStage } from "./jam-stage";
import { TrackAdjust } from "./jam-track-adjust";
import { JamTrackRow } from "./jam-track-row";
import { JamTransport } from "./jam-transport";

/**
 * An open song, read as a band: a cover in the colours of who is on it, one
 * big play, and every track as a lane on ONE timeline under ONE playhead, the
 * missing instruments as dashed lanes that open the studio on them. The
 * listener's mute, solo and volume are theirs alone; the author adjusts their
 * own take right on its clip; the one big button is "Gravar", there only when
 * the song lets this viewer add something (`viewer.addableInstruments`).
 */

export interface JamSongPanelProps {
  channelId: string;
  song: JamSongSummary;
  detail: JamDetail | undefined;
  viewerId: string | null;
  /** `GET /api/jam/config`: the flag, and whether storage is there. */
  enabled: boolean;
  uploads: boolean;
  /** Open the studio over this song on this instrument; `chosen` when the person picked it. */
  onRecord: (instrument: JamInstrument, chosen?: boolean) => void;
  onClose: () => void;
  /** The song started or stopped playing (the wall's tile dances). */
  onPlayingChange?: (playing: boolean) => void;
  /** The take to drop into its lane with an entrance (the one just posted). */
  freshTrackId?: string | null;
  /** Start playing as soon as the stems are in. */
  autoplay?: boolean;
  /** Each change is the wall's round button pressed on this song while it is open: play, or pause. */
  playNonce?: number;
  /**
   * Opened from outside any channel (`/app/jam/<id>`, a public jam): no votes
   * and no chat share, but a like, a link, a report, and the song's origin.
   */
  publicView?: boolean;
  /** The server this song's channel belongs to, for the publish sheet. Null outside a channel. */
  originName?: string | null;
}

export function JamSongPanel({
  channelId,
  song,
  detail,
  viewerId,
  enabled,
  uploads,
  onRecord,
  onClose,
  onPlayingChange,
  freshTrackId,
  autoplay = true,
  playNonce = 0,
  publicView = false,
  originName = null,
}: JamSongPanelProps) {
  const { t } = useTranslation();
  const tracks = useMemo(() => orderTracks(detail?.tracks ?? []), [detail?.tracks]);
  const playback = useJamPlayback(song.id, tracks, {
    autoplay,
    onPlayError: () => setError(t("jam.studio.playError")),
  });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<JamTrack | null>(null);
  const [confirmSong, setConfirmSong] = useState(false);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const cover = useJamCover(song.coverUrl);
  const covered = cover.src !== null && cover.status !== "failed";
  const serial = useRef(oneAtATime()).current;
  const storeEpoch = useJamStoreEpoch();
  // What an answer writes into the store carries the identity epoch of the render
  // that asked: an answer that lands after another account took over is dropped.
  const writeFrame = (frame: JamFrame) => applyJamWrite(channelId, frame, storeEpoch);
  const writeVote = (vote: JamVoteResponse) => applyJamVote(channelId, vote, storeEpoch);

  // The detail: read when the panel opens, and again when a join-mode change
  // made what the viewer may add out of date.
  useEffect(() => {
    // Asked again every time the panel opens, even when something is held: the
    // answer is what says this account may still see the song. And again when the
    // store was emptied for another account (`storeEpoch`).
    void loadJamDetail(channelId, song.id, { force: true });
  }, [channelId, song.id, storeEpoch]);
  useEffect(() => {
    if (detail?.viewerStale) {
      void loadJamDetail(channelId, song.id);
    }
  }, [channelId, song.id, detail?.viewerStale]);

  // The detail is in and the song has no take: only its author sees this (the server leaves it out for everybody else). Nothing plays.
  const isEmpty = detail !== undefined && tracks.length === 0;
  const playing = playback.transport === "playing" && !isEmpty;
  // A public jam counts a play the first time it is heard in this view.
  const playCounted = useRef(false);
  useEffect(() => {
    if (publicView && playing && !playCounted.current) {
      playCounted.current = true;
      void notePublicPlay(song.id);
    }
  }, [publicView, playing, song.id]);
  const playingChange = useRef(onPlayingChange);
  playingChange.current = onPlayingChange;
  useEffect(() => {
    playingChange.current?.(playing);
  }, [playing]);
  useEffect(() => () => playingChange.current?.(false), []);

  // The wall's round button on a song that is open already: play or pause it.
  const toggleRef = useRef(playback.toggle);
  toggleRef.current = playback.toggle;
  const shownNonce = useRef(playNonce);
  useEffect(() => {
    if (shownNonce.current !== playNonce) {
      shownNonce.current = playNonce;
      toggleRef.current();
    }
  }, [playNonce]);

  // Opening a song puts the keyboard in it: focus lands on the song's name, so
  // Tab goes through the song and Escape closes it. (Not stolen back later: this
  // runs once per song.)
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // Space plays and pauses from anywhere in the song: the wall owns the key (`JamPane`), because
  // the same press means "the open song" here and "the card" there, and it reaches this panel as
  // `playNonce` like the wall's round button does.

  const viewer = detail?.viewer;
  const competing = useMemo(() => competingInstruments(tracks), [tracks]);
  const timeline = useMemo(() => songTimeline(tracks), [tracks]);
  const need = songNeed(song);
  const mine = tracks.filter((track) => viewerId !== null && track.authorId === viewerId);
  const addable = viewer?.addableInstruments ?? [];
  const reason = cannotRecordReason({ enabled, uploads, addable, joinMode: song.joinMode });
  const canManage = viewer ? viewer.isAuthor || viewer.canModerate : false;
  // The server's own rule for editing a song (its author or a moderator, and the flag on).
  const canEdit = canManage && enabled;
  const pub = useJamPublicPanel({
    song,
    viewerId,
    isStarter: viewer?.isAuthor === true,
    tracks,
    publicView,
    originName,
  });
  const requestTakes = tracks.filter((track) => pub.pendingTakeIds.has(track.id));
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  /** The delete being confirmed is the starter declining an outside request. */
  const [declining, setDeclining] = useState(false);
  const first = pickInstrument(song, addable, mine);
  const missingSlots =
    need.kind === "missing" ? need.instruments.filter((instrument) => !tracks.some((one) => one.instrument === instrument)) : [];
  const inMixCount = new Set(tracks.filter((one) => one.inMix).map((one) => one.instrument)).size;
  const adjusting = adjustingId ? tracks.find((track) => track.id === adjustingId) ?? null : null;
  // "Ajustar" is the viewer's own: its slot is kept in every lane only when they have a lane to put it on.
  const hasOwnTake = enabled && mine.length > 0;
  // The room the lanes' controls need, in the same columns as the ruler: the listener's cluster and the menu,
  // plus "Ajustar" when the viewer has a take, plus audition, vote and "use this" when the band has alternates.
  const hasAlternates = competing.size > 0 || tracks.some((track) => !track.inMix);
  const laneRoom =
    hasOwnTake && hasAlternates
      ? "[--lane-ctl:19.25rem]"
      : hasAlternates
        ? "[--lane-ctl:17rem]"
        : hasOwnTake
          ? "[--lane-ctl:13.75rem]"
          : "[--lane-ctl:11.5rem]";
  const durationMs = playback.durationMs || timeline.endMs;
  // The stage: a mosaic of every recording in the mix, with video or without, above the lanes.
  // A song with a take starts with the compact header (a small cover, the play button beside the
  // title) before its detail has even arrived, so the header does not change shape under it.
  const stageTracks = useMemo(() => tracks.filter((track) => track.inMix), [tracks]);
  const stageOn = detail ? stageTracks.length > 0 : song.trackCount > 0;
  const anySolo = tracks.some((track) => playback.lanes[track.id]?.solo === true);
  // A tile is "only this": it solos its track, and pressing the one that is the only one soloed clears it.
  const soloFromStage = (trackId: string) => {
    const onlyThis = playback.lanes[trackId]?.solo === true && !tracks.some((other) => other.id !== trackId && playback.lanes[other.id]?.solo === true);
    for (const other of tracks) {
      const soloed = playback.lanes[other.id]?.solo === true;
      if (other.id === trackId) {
        playback.setLane(other.id, { solo: !onlyThis });
      } else if (soloed) {
        playback.setLane(other.id, { solo: false });
      }
    }
  };
  const transport = (
    <JamTransport
      clock={playback.clock}
      playing={playing}
      loading={!detail || playback.status === "loading"}
      durationMs={durationMs}
      onToggle={playback.toggle}
      onSeek={playback.seek}
      title={song.title}
      scrubber={false}
    />
  );

  const known = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = new Set(tracks.map((track) => track.id));
    if (known.current !== null) {
      const fresh = tracks.filter((track) => !known.current!.has(track.id)).map((track) => track.id);
      if (fresh.length > 0) {
        setArrived((before) => new Set([...before, ...fresh]));
      }
    }
    if (detail) {
      known.current = ids;
    }
  }, [tracks, detail]);

  async function guard(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(t(`jam.error.${jamErrorKind(failure)}` as MessageKey));
    }
  }

  const votedIds = new Set(viewer?.votedTrackIds ?? []);
  const seekFraction = (fraction: number) => {
    playback.seek(timeline.startMs + Math.min(1, Math.max(0, fraction)) * (timeline.endMs - timeline.startMs));
  };

  // A song with nothing in it yet is its author's alone, so a link to it would lead nowhere.
  const canShare = !isEmpty && song.trackCount > 0;
  // In a public view the share button copies the address anybody can open; a chat card needs a channel.
  const shareAction = pub.copyLink ?? (() => setSharing(true));
  const manageItems: ContextMenuItemDef[] =
    canManage && enabled
      ? [
          {
            id: "join",
            label: song.joinMode === "closed" ? t("jam.song.reopen") : t("jam.song.finish"),
            icon: song.joinMode === "closed" ? LockOpen : Lock,
            onSelect: () =>
              void guard(async () => {
                const answer = await updateJamSong(song.id, {
                  joinMode: song.joinMode === "closed" ? "open" : "closed",
                  ...(song.joinMode === "closed" ? { wantedInstruments: [] } : {}),
                });
                writeFrame({ type: "jam-song-updated", channelId, song: answer.song });
              }),
          },
          { id: "sep", label: "", separator: true },
          { id: "delete", label: t("jam.song.delete"), icon: Trash2, danger: true, onSelect: () => setConfirmSong(true) },
        ]
      : [];
  const songMenu: ContextMenuItemDef[] = [
    ...(canShare && !publicView ? [{ id: "share", label: t("jam.share.title"), icon: Send, onSelect: () => setSharing(true) }] : []),
    ...pub.menuItems,
    ...((canShare || pub.menuItems.length > 0) && manageItems.length > 0 ? [{ id: "share-sep", label: "", separator: true }] : []),
    ...manageItems,
  ];

  const recordLabel = isEmpty
    ? t("jam.song.recordFirst")
    : first && need.kind === "missing" && need.instruments.includes(first)
      ? t(`jam.song.recordAs.${first}` as MessageKey)
      : t("jam.song.record");
  // The take about to be deleted is the song's last one, and the person may delete
  // the song (its author or a moderator: the server's rule): then deleting the take
  // deletes the song, and the confirm says so.
  const deletesSong = pendingDelete !== null && !declining && tracks.length === 1 && canManage;

  const editPill = canEdit ? (
    <button
      type="button"
      data-jam-edit-open=""
      onClick={() => setEditing(true)}
      aria-label={t("jam.edit.open")}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-text outline-none ring-1 ring-border sm:h-8 transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]",
        stageOn && "max-sm:w-9 max-sm:justify-center max-sm:px-0",
      )}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      <span className={cn(stageOn && "max-sm:sr-only")}>{t("jam.edit.open")}</span>
    </button>
  ) : null;

  const sharePill = canShare ? (
    <button
      type="button"
      data-jam-share-open=""
      onClick={shareAction}
      aria-label={pub.copyLink ? t("jam.public.menu.copyLink") : t("jam.share.title")}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-text outline-none ring-1 ring-border sm:h-8 transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]",
        stageOn && "max-sm:w-9 max-sm:justify-center max-sm:px-0",
      )}
    >
      {pub.copyLink ? <Link2 className="h-3.5 w-3.5" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
      <span className={cn(stageOn && "max-sm:sr-only")}>{pub.copyLink ? t("jam.public.menu.copyLink") : t("jam.share.title")}</span>
    </button>
  ) : null;

  return (
    <section aria-label={song.title} data-jam-song={song.id} className="flex h-full min-h-0 flex-col bg-surface-1">
      <header
        data-jam-header={stageOn ? "compact" : "full"}
        className={cn(
          "relative isolate flex gap-2 overflow-hidden border-b border-border px-2 py-3 sm:gap-3 sm:px-4 [@media(max-height:32rem)]:py-1.5",
          stageOn ? "flex-wrap items-start sm:items-center" : "items-start",
        )}
      >
        {covered && (
          // The cover's own colours, blurred far past reading, behind the words.
          <span aria-hidden="true" data-jam-header-wash="" className="jam-header-wash pointer-events-none absolute inset-0 -z-10">
            <JamCoverPhoto cover={cover} eager className="scale-125 blur-2xl saturate-150 data-[ready=true]:opacity-45" />
            {/* the words sit on this: nearly the panel's own surface, so any cover leaves them readable */}
            <span className="absolute inset-0 bg-gradient-to-b from-surface-1/80 via-surface-1/90 to-surface-1" />
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("jam.song.back")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <SongCover song={song} cover={cover} tracks={detail?.tracks} playing={playing} small={stageOn} onEdit={canEdit ? () => setEditing(true) : undefined} />
        <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", stageOn ? "basis-40" : "pt-0.5")}>
          <h2
            ref={titleRef}
            tabIndex={-1}
            className={cn(
              "font-display font-extrabold leading-[1.05] tracking-[-0.01em] text-text outline-none [overflow-wrap:anywhere] [text-wrap:balance] [@media(max-height:32rem)]:text-xl",
              stageOn ? "text-xl sm:text-2xl" : "text-2xl sm:text-4xl",
            )}
          >
            {song.title}
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-text-secondary">
            <ContributorStack people={song.contributors} total={song.contributorCount} size="sm" ringClassName="ring-border-strong" />
            <span className={cn("min-w-0", stageOn ? "truncate" : "basis-full sm:basis-auto")}>
              {song.artist ?? t("jam.original")}
              <span className="max-sm:hidden"> · {viewer?.isAuthor ? t("jam.song.startedByYou") : t("jam.song.startedBy", { name: song.authorName ?? t("jam.tile.anonymous") })}</span>
            </span>
            {/* with a stage the pill is a pencil beside the people on a phone, so the video starts higher */}
            {stageOn && sharePill}
            {stageOn && editPill}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!stageOn && sharePill}
            {!stageOn && editPill}
            {song.joinMode === "closed" && (
              <span data-jam-closed-line="" className="flex items-center gap-1 text-xs text-text-secondary">
                <Lock className="h-3 w-3 shrink-0" aria-hidden />
                {t("jam.song.closedLine")}
              </span>
            )}
          </div>
        </div>
        {stageOn && !isEmpty && (
          // The song's play button sits with its title, so the stage can have the room below.
          <div data-jam-header-transport="" className="max-sm:order-last max-sm:basis-full max-sm:pl-1">
            {transport}
          </div>
        )}
        {songMenu.length > 0 && (
          <Menu items={songMenu} align="end">
            <button
              type="button"
              aria-label={t("jam.song.more")}
              data-jam-song-menu=""
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
            </button>
          </Menu>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("jam.song.close")}
          className="hidden h-10 w-10 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring lg:grid"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-5 sm:px-5">
        {pub.strip && <div className="-mx-3 sm:-mx-5">{pub.strip}</div>}
        {isEmpty ? (
          <div
            data-jam-empty-song=""
            className="mt-4 flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-surface-2 p-4"
          >
            <h3 className="font-display text-lg font-extrabold text-text">{t("jam.song.empty.title")}</h3>
            <p className="text-sm leading-snug text-text-secondary [text-wrap:pretty]">{t("jam.song.empty.body")}</p>
            {canManage && enabled && (
              <Button variant="secondary" size="sm" data-jam-empty-delete="" onClick={() => setConfirmSong(true)}>
                {t("jam.song.delete")}
              </Button>
            )}
          </div>
        ) : (
        <>
        {stageOn && (
          <JamStage
            tracks={stageTracks}
            viewerId={viewerId}
            lanes={playback.lanes}
            anySolo={anySolo}
            attachVideo={playback.attachVideo}
            clock={playback.clock}
            onSolo={soloFromStage}
            // the part the song asks for gets its own tile only for somebody who may add it
            missing={reason === null ? missingSlots.filter((instrument) => addable.includes(instrument)) : []}
            onRecord={reason === null ? (instrument) => onRecord(instrument, true) : undefined}
            loading={!detail}
          />
        )}
        <JamPublicRequests
          takes={requestTakes}
          auditioning={playback.audition}
          playing={playing}
          busyId={requestBusy}
          onListen={(track) => {
            if (playback.audition === track.id) {
              playback.setAudition(null);
              return;
            }
            playback.setAudition(track.id);
            if (!playing) playback.toggle();
          }}
          onAccept={(track) => {
            setRequestBusy(track.id);
            void serial(() =>
              guard(async () => {
                const answer = await updateJamTrack(track.id, { inMix: true });
                writeFrame({ type: "jam-track-updated", channelId, song: answer.song, track: answer.track });
                dropInboxTake(track.id);
                if (playback.audition === track.id) playback.setAudition(null);
                pub.refreshPublication();
              }),
            ).finally(() => setRequestBusy(null));
          }}
          onDecline={(track) => {
            setDeclining(true);
            setPendingDelete(track);
          }}
        />
        <section className="mt-1" aria-labelledby={`band-${song.id}`}>
          <div
            className={cn(
              "-mx-3 mb-2 flex flex-col gap-1 px-3 pb-2 pt-3 sm:-mx-5 sm:px-5",
              // the play button rides with the title when the song has a stage; otherwise it is under the band's name and stays in view
              !stageOn && "sticky top-0 z-10 bg-surface-1/95 backdrop-blur-sm [@media(max-height:32rem)]:static [@media(max-height:32rem)]:pt-1",
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={`band-${song.id}`} className="font-display text-lg font-extrabold text-text">
                {t("jam.song.band")}
              </h3>
              {detail && (
                <span className="text-[13px] font-semibold text-text-secondary">
                  {t("jam.song.bandCount", { count: inMixCount, countLabel: inMixCount })}
                </span>
              )}
            </div>
            {!stageOn && transport}
          </div>

          {!detail ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((one) => (
                <div key={one} className="h-[4.5rem] rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="relative" data-jam-band="">
              {/* "only you hear mute, volume and only-this" is the headphones icon's tooltip in each lane, not a line of its own */}
              <div className={cn("relative", laneRoom, JAM_BAND_BOX)}>
                <Ruler timeline={timeline} onSeek={seekFraction} />
                <ul className="flex flex-col gap-1" aria-label={t("jam.song.tracks")}>
                  {tracks.filter((track) => !pub.pendingTakeIds.has(track.id)).map((track, index) => {
                    const lane = playback.lanes[track.id] ?? { muted: false, solo: false, volume: 1 };
                    const isMine = viewerId !== null && track.authorId === viewerId;
                    return (
                      <JamTrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        timeline={timeline}
                        clock={playback.clock}
                        lane={lane}
                        viewerId={viewerId}
                        competing={competing.has(track.instrument)}
                        voted={votedIds.has(track.id)}
                        canSwitchMix={canManage && enabled}
                        canDelete={isMine || canManage}
                        canVote={enabled && !publicView}
                        waitingForStarter={publicView && isMine && !track.inMix && viewer?.isAuthor !== true}
                        onReport={!isMine && pub.reportTrack ? () => pub.reportTrack?.(track.id) : undefined}
                        auditioning={playback.audition === track.id}
                        loading={playback.stemStatus[track.id] === "loading"}
                        failed={playback.stemStatus[track.id] === "error"}
                        fresh={arrived.has(track.id) || freshTrackId === track.id}
                        othersSoloed={tracks.some((other) => other.id !== track.id && playback.lanes[other.id]?.solo === true)}
                        canAdjust={isMine && enabled}
                        reserveAdjust={hasOwnTake}
                        adjusting={adjustingId === track.id}
                        onAdjust={() => setAdjustingId(track.id)}
                        editor={
                          adjusting && adjusting.id === track.id ? (
                            <TrackAdjust
                              key={adjusting.id}
                              track={adjusting}
                              title={t("jam.take.adjustTitle", {
                                instrument: t(JAM_INSTRUMENT_LOOK[adjusting.instrument].nameKey as MessageKey).toLowerCase(),
                              })}
                              band={bandOf(tracks, adjusting.id)}
                              engine={playback.engine}
                              clock={playback.clock}
                              previewGain={playback.previewGain}
                              onDone={() => setAdjustingId(null)}
                              onSave={async (patch) => {
                                const answer = await updateJamTrack(adjusting.id, patch);
                                writeFrame({
                                  type: "jam-track-updated",
                                  channelId,
                                  song: answer.song,
                                  track: answer.track,
                                });
                              }}
                            />
                          ) : undefined
                        }
                        onSeek={seekFraction}
                        onLane={(patch) => playback.setLane(track.id, patch)}
                        onVote={() =>
                          void guard(async () => {
                            const answer = await voteJamTrack(track.id, !votedIds.has(track.id));
                            writeVote(answer);
                          })
                        }
                        onSwitchMix={() =>
                          // One mix change at a time, and "use this take" is a swap (see jam-mix).
                          void serial(() =>
                            guard(async () => {
                              const put = async (id: string, inMix: boolean) => {
                                const answer = await updateJamTrack(id, { inMix });
                                writeFrame({
                                  type: "jam-track-updated",
                                  channelId,
                                  song: answer.song,
                                  track: answer.track,
                                });
                              };
                              if (track.inMix) {
                                await put(track.id, false);
                                return;
                              }
                              const outcome = await switchTakeIn(
                                track.id,
                                put,
                                () => readJamChannel(channelId).details[song.id]?.tracks ?? tracks,
                                () => rereadJamTracks(channelId, song.id),
                              );
                              if (outcome === "partial") {
                                setError(t("jam.error.swapPartial"));
                              }
                            }),
                          )
                        }
                        onDelete={() => setPendingDelete(track)}
                        onAudition={() => playback.setAudition(playback.audition === track.id ? null : track.id)}
                      />
                    );
                  })}
                  {missingSlots.map((instrument, index) => (
                    <MissingLane
                      key={instrument}
                      instrument={instrument}
                      index={tracks.length + index}
                      who={viewer?.isAuthor ? null : (song.authorName ?? t("jam.tile.anonymous"))}
                      canRecord={reason === null && addable.includes(instrument)}
                      onRecord={() => onRecord(instrument, true)}
                    />
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
        </>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
            {error}
          </p>
        )}
      </div>

      {/* the dock: the one thing to do */}
      <footer hidden={adjustingId !== null} className="safe-pb flex flex-col gap-3 border-t border-border bg-surface-1 px-3 py-3 sm:px-5 [@media(max-height:32rem)]:py-1.5">
        {reason === null && first ? (
          <button
            type="button"
            data-jam-record-over=""
            onClick={() => onRecord(first, need.kind === "missing")}
            className="group relative flex h-14 w-full items-center justify-center gap-2.5 overflow-hidden rounded-full bg-accent text-base font-extrabold [@media(max-height:32rem)]:h-11 text-on-accent shadow-[var(--shadow-2)] outline-none transition-[transform,box-shadow] duration-[var(--duration-fast)] hover:shadow-[var(--shadow-3)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 motion-safe:hover:scale-[1.01] active:scale-[0.98]"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-on-accent text-accent transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:group-hover:scale-110">
              <Mic className="h-4 w-4" aria-hidden />
            </span>
            {recordLabel}
          </button>
        ) : (
          reason !== null &&
          detail && (
            <p role="status" className="text-center text-sm leading-snug text-text-secondary [text-wrap:pretty]">
              {t(`jam.song.cannot.${reason}` as MessageKey)}
            </p>
          )
        )}
      </footer>

      {canShare && !publicView && <JamSharePicker song={song} open={sharing} onClose={() => setSharing(false)} />}
      {pub.overlays}
      {canEdit && (
        <JamEditSheet
          open={editing}
          song={song}
          onClose={() => setEditing(false)}
          onSong={(next) => writeFrame({ type: "jam-song-updated", channelId, song: next })}
          onDenied={() => void loadJamDetail(channelId, song.id, { force: true })}
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          declining
            ? t("jam.public.requests.declineTitle")
            : deletesSong
              ? t("jam.take.deleteLastTitle")
              : t("jam.take.deleteTitle")
        }
        description={
          declining
            ? t("jam.public.requests.declineBody")
            : deletesSong
              ? t("jam.take.deleteLastBody")
              : t("jam.take.deleteBody")
        }
        confirmLabel={declining ? t("jam.public.requests.decline") : deletesSong ? t("jam.song.delete") : t("jam.take.delete")}
        cancelLabel={t("jam.keep")}
        onClose={() => {
          setPendingDelete(null);
          setDeclining(false);
        }}
        onConfirm={() => {
          const track = pendingDelete;
          setPendingDelete(null);
          setDeclining(false);
          if (!track) return;
          if (adjustingId === track.id) setAdjustingId(null);
          void guard(async () => {
            await deleteJamTrack(track.id);
            dropInboxTake(track.id);
            // When it was the song's last take the server took the song with it (if nobody
            // added one meanwhile): the reads below are what say which it was, so a take that
            // arrived in between is never taken for a deleted song.
            // Deleted is deleted: the lane goes at once, and the refreshes below are
            // best effort (their failing must not make a done delete look undone).
            writeFrame({ type: "jam-track-deleted", channelId, song, trackId: track.id });
            try {
              await loadJamDetail(channelId, song.id, { force: true });
              await loadJamChannel(channelId, { force: true });
            } catch {
              // The next frame or open reads again.
            }
          });
        }}
      />
      <ConfirmDialog
        open={confirmSong}
        title={t("jam.song.deleteTitle", { title: song.title })}
        description={t("jam.song.deleteBody", { count: song.trackCount, countLabel: song.trackCount })}
        confirmLabel={t("jam.song.delete")}
        cancelLabel={t("jam.keep")}
        onClose={() => setConfirmSong(false)}
        onConfirm={() => {
          setConfirmSong(false);
          void guard(async () => {
            await deleteJamSong(song.id);
            writeFrame({ type: "jam-song-deleted", channelId, songId: song.id });
            onClose();
          });
        }}
      />
    </section>
  );
}

/** The other in-mix lanes, as the clip editor draws them behind a take. */
export function bandOf(tracks: readonly JamTrack[], exceptId: string | null): BandLane[] {
  return tracks
    .filter((track) => track.inMix && track.id !== exceptId)
    .map((track) => ({
      peaks: track.peaks,
      offsetMs: track.offsetMs,
      trimStartMs: track.trimStartMs,
      trimEndMs: track.trimEndMs,
      durationMs: track.durationMs,
    }));
}

/**
 * The song's cover: its photo when it has one, otherwise the tile's art (the
 * gradient of its band and the loudest stem's waveform), so the panel reads as
 * the tile that was opened. Its view-transition name pairs it with that tile.
 * For the people who may edit the song the picture is itself the way in: a
 * solid pill rises on hover and focus (and is always there on a phone, which has
 * no hover), the same photo button the edit sheet's tile has.
 */
function SongCover({
  song,
  cover,
  tracks,
  playing,
  small = false,
  onEdit,
}: {
  song: JamSongSummary;
  cover: JamCoverState;
  tracks?: readonly JamTrack[];
  playing: boolean;
  /** A song with a stage: the cover is a 56 px mark beside the title, not the picture of the panel. */
  small?: boolean;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const covered = cover.src !== null && cover.status !== "failed";
  return (
    <div
      className={cn(
        "group relative isolate shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-surface-2 shadow-[var(--shadow-2)]",
        small
          ? "h-12 w-12 sm:h-14 sm:w-14"
          : "h-[5.5rem] w-[5.5rem] sm:h-[7.5rem] sm:w-[7.5rem] [@media(max-height:32rem)]:h-16 [@media(max-height:32rem)]:w-16",
      )}
      style={{ viewTransitionName: `jam-cover-${song.id}` } as CSSProperties}
      data-jam-cover=""
      data-jam-cover-photo-on={covered ? "true" : undefined}
    >
      {/* the same picture the wall's card shows: the photo, the band's faces, or the band */}
      <JamArtwork song={song} cover={cover} tracks={tracks} loadVideo eager />
      {playing && (
        <span aria-hidden="true" className={cn("absolute flex items-center rounded-full bg-media-scrim/85 text-on-media", small ? "bottom-1 left-1 h-4 px-1" : "bottom-1.5 left-1.5 h-5 px-1.5")}>
          <Equalizer className="h-3" />
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          data-jam-cover-edit=""
          aria-label={covered ? t("jam.edit.changePhoto") : t("jam.edit.addPhoto")}
          className="absolute inset-0 rounded-[inherit] text-on-media outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-x-0 top-1/2 mx-auto flex h-9 w-max -translate-y-1/2 items-center gap-1.5 rounded-full bg-media-scrim/80 px-3 text-xs font-bold opacity-0 backdrop-blur-sm transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-focus-within:opacity-100 max-sm:hidden",
              small && "px-2.5",
            )}
          >
            <Camera className="h-4 w-4 shrink-0" strokeWidth={2.25} />
            {!small && <span className="max-sm:hidden">{covered ? t("jam.edit.changePhoto") : t("jam.edit.addPhoto")}</span>}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * Time along the top of the band: where each lane is, and a place to click to
 * jump. It uses the lanes' own columns (`JamLaneFrame`), so on a wide band its
 * labels sit exactly over the waveforms and on a narrow one it spans the width.
 */
export function Ruler({
  timeline,
  onSeek,
}: {
  timeline: { startMs: number; endMs: number };
  onSeek: (fraction: number) => void;
}) {
  const length = timeline.endMs - timeline.startMs;
  // About one label per 56 px, on a round number of seconds.
  const [ref, width] = useBarCount(1, 4000);
  const fits = Math.max(1, Math.floor(width / 56));
  const step = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000].find((one) => length / one <= fits) ?? 60_000;
  const marks: number[] = [];
  for (let at = 0; at <= length - step / 3; at += step) marks.push(at);
  return (
    <div
      className="grid grid-cols-1 px-1.5 pb-1 @min-[40rem]/band:grid-cols-[var(--lane-id)_minmax(0,1fr)_var(--lane-ctl)] @min-[40rem]/band:gap-x-3"
      aria-hidden="true"
    >
      <div ref={ref} className="relative h-5 @min-[40rem]/band:col-start-2">
        <button
          type="button"
          tabIndex={-1}
          className="absolute inset-0 cursor-pointer"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSeek((event.clientX - box.left) / Math.max(1, box.width));
          }}
        />
        {marks.map((at) => (
          <span key={at} className="pointer-events-none absolute bottom-0 flex flex-col items-start" style={{ left: `${(at / length) * 100}%` }}>
            <span className="text-xs font-semibold tabular-nums text-text-secondary">{formatClock(at)}</span>
            <span className="h-1.5 w-px bg-border-strong" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** "Falta voz": a dashed lane where the missing part goes, and the button that records it. */
function MissingLane({
  instrument,
  index,
  who,
  canRecord,
  onRecord,
}: {
  instrument: JamInstrument;
  index: number;
  /** Who is looking for this part; null when it is the person looking at it. */
  who: string | null;
  canRecord: boolean;
  onRecord: () => void;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const sub = who === null ? t("jam.song.lookingYou") : t("jam.song.looking", { name: who });
  return (
    <li
      data-jam-slot={instrument}
      style={{ "--jam-l": index } as CSSProperties}
      className="jam-lane-in rounded-[var(--radius-card)] p-1.5"
    >
      <JamLaneFrame
        identity={<JamLaneIdentity instrument={instrument} sub={sub} subTitle={sub} dashed />}
        wave={
          // the empty lane is itself the button: where the part goes is where you press
          canRecord ? (
            <button
              type="button"
              onClick={onRecord}
              data-jam-slot-record={instrument}
              aria-label={t(`jam.song.recordAs.${instrument}` as MessageKey)}
              className="group flex h-[3.25rem] w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border-2 border-dashed border-border-strong px-2 text-[13px] font-semibold text-text-secondary outline-none transition-[background-color,border-color,color] duration-[var(--duration-base)] hover:border-accent hover:bg-accent-soft hover:text-on-accent-soft focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Mic className="h-4 w-4 shrink-0 transition-transform duration-[var(--duration-base)] motion-safe:group-hover:scale-110" aria-hidden />
              <span className="truncate">{t("jam.song.slotHint", { instrument: t(look.nameKey as MessageKey).toLowerCase() })}</span>
            </button>
          ) : (
            <div className={cn("flex h-[3.25rem] items-center justify-center rounded-[var(--radius-control)] border-2 border-dashed border-current px-2 text-xs font-bold", look.ink)}>
              <span className="truncate">{t(look.missingKey as MessageKey)}</span>
            </div>
          )
        }
      />
    </li>
  );
}
