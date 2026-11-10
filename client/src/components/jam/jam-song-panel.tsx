import type { JamFrame, JamInstrument, JamSongSummary, JamTrack, JamVoteResponse } from "@pqp/shared";
import { ArrowLeft, Camera, Lock, LockOpen, Mic, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { useJamPlayback, type JamClock } from "@/hooks/use-jam-playback";
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
import { JamCoverPhoto, SongArt, useJamCover, type JamCoverState } from "./jam-cover";
import { JamEditSheet } from "./jam-edit-sheet";
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

  const playing = playback.transport === "playing";
  const playingChange = useRef(onPlayingChange);
  playingChange.current = onPlayingChange;
  useEffect(() => {
    playingChange.current?.(playing);
  }, [playing]);
  useEffect(() => () => playingChange.current?.(false), []);

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
  const first = pickInstrument(song, addable, mine);
  const missingSlots =
    need.kind === "missing" ? need.instruments.filter((instrument) => !tracks.some((one) => one.instrument === instrument)) : [];
  const inMixCount = new Set(tracks.filter((one) => one.inMix).map((one) => one.instrument)).size;
  const adjusting = adjustingId ? tracks.find((track) => track.id === adjustingId) ?? null : null;
  const durationMs = playback.durationMs || timeline.endMs;

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

  const songMenu: ContextMenuItemDef[] =
    canManage && enabled
      ? [
          { id: "edit", label: t("jam.edit.open"), icon: Pencil, onSelect: () => setEditing(true) },
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

  const recordLabel =
    first && need.kind === "missing" && need.instruments.includes(first)
      ? t(`jam.song.recordAs.${first}` as MessageKey)
      : t("jam.song.record");

  return (
    <section aria-label={song.title} data-jam-song={song.id} className="flex h-full min-h-0 flex-col bg-surface-1">
      <header className="relative isolate flex items-start gap-2 overflow-hidden border-b border-border px-2 py-3 sm:gap-3 sm:px-4">
        {covered && (
          // The cover's own colours, blurred far past reading, behind the words.
          <span aria-hidden="true" data-jam-header-wash="" className="jam-header-wash pointer-events-none absolute inset-0 -z-10">
            <JamCoverPhoto cover={cover} eager className="scale-125 blur-2xl saturate-150 data-[ready=true]:opacity-60" />
            <span className="absolute inset-0 bg-gradient-to-b from-surface-1/10 via-surface-1/55 to-surface-1" />
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
        <SongCover song={song} cover={cover} playing={playing} onEdit={canEdit ? () => setEditing(true) : undefined} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <h2 className="font-display text-2xl font-extrabold leading-[1.05] tracking-[-0.01em] text-text [text-wrap:balance] sm:text-3xl">
            {song.title}
          </h2>
          <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-text-secondary">
            <ContributorStack people={song.contributors} total={song.contributorCount} size="sm" ringClassName="ring-border-strong" />
            <span className="truncate">
              {song.artist ?? t("jam.original")}
              <span className="max-sm:hidden"> · {viewer?.isAuthor ? t("jam.song.startedByYou") : t("jam.song.startedBy", { name: song.authorName ?? t("jam.tile.anonymous") })}</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <button
                type="button"
                data-jam-edit-open=""
                onClick={() => setEditing(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-bold text-text outline-none ring-1 ring-border sm:h-8 transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                {t("jam.edit.open")}
              </button>
            )}
            {song.joinMode === "closed" && (
              <span data-jam-closed-line="" className="flex items-center gap-1 text-xs text-text-secondary">
                <Lock className="h-3 w-3 shrink-0" aria-hidden />
                {t("jam.song.closedLine")}
              </span>
            )}
          </div>
        </div>
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
        <section className="mt-1" aria-labelledby={`band-${song.id}`}>
          <div className="sticky top-0 z-10 -mx-3 mb-2 flex flex-col gap-1 bg-surface-1/95 px-3 pb-2 pt-3 backdrop-blur-sm sm:-mx-5 sm:px-5">
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
          </div>

          {!detail ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((one) => (
                <div key={one} className="h-[4.5rem] rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="relative [--lane-head:8.5rem] sm:[--lane-head:12rem]" data-jam-band="">
              <Ruler timeline={timeline} onSeek={seekFraction} />
              <ul className="flex flex-col gap-1" aria-label={t("jam.song.tracks")}>
                {tracks.map((track, index) => {
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
                      canVote={enabled}
                      auditioning={playback.audition === track.id}
                      loading={playback.stemStatus[track.id] === "loading"}
                      failed={playback.stemStatus[track.id] === "error"}
                      fresh={arrived.has(track.id) || freshTrackId === track.id}
                      canAdjust={isMine && enabled}
                      adjusting={adjustingId === track.id}
                      onAdjust={() => setAdjustingId(track.id)}
                      onSeek={seekFraction}
                      attachVideo={track.inMix && track.videoUrl ? playback.attachVideo : undefined}
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
              <Playhead clock={playback.clock} timeline={timeline} />
            </div>
          )}

          {adjusting && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm font-bold text-text">
                {t("jam.take.adjustTitle", {
                  instrument: t(JAM_INSTRUMENT_LOOK[adjusting.instrument].nameKey as MessageKey).toLowerCase(),
                })}
              </p>
              <TrackAdjust
                key={adjusting.id}
                track={adjusting}
                band={bandOf(tracks, adjusting.id)}
                engine={playback.engine}
                clock={playback.clock}
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
            </div>
          )}
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
            {error}
          </p>
        )}
      </div>

      {/* the dock: the one thing to do */}
      <footer className="safe-pb flex flex-col gap-3 border-t border-border bg-surface-1 px-3 py-3 sm:px-5">
        {reason === null && first ? (
          <button
            type="button"
            data-jam-record-over=""
            onClick={() => onRecord(first, need.kind === "missing")}
            className="group relative flex h-14 w-full items-center justify-center gap-2.5 overflow-hidden rounded-full bg-accent text-base font-extrabold text-on-accent shadow-[var(--shadow-2)] outline-none transition-[transform,box-shadow] duration-[var(--duration-fast)] hover:shadow-[var(--shadow-3)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 motion-safe:hover:scale-[1.01] active:scale-[0.98]"
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
        title={t("jam.take.deleteTitle")}
        description={t("jam.take.deleteBody")}
        confirmLabel={t("jam.take.delete")}
        cancelLabel={t("jam.keep")}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const track = pendingDelete;
          setPendingDelete(null);
          if (!track) return;
          if (adjustingId === track.id) setAdjustingId(null);
          void guard(async () => {
            await deleteJamTrack(track.id);
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
        title={t("jam.song.deleteTitle")}
        description={t("jam.song.deleteBody")}
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
  playing,
  onEdit,
}: {
  song: JamSongSummary;
  cover: JamCoverState;
  playing: boolean;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const covered = cover.src !== null && cover.status !== "failed";
  return (
    <div
      className="group relative isolate h-[5.5rem] w-[5.5rem] shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-surface-2 shadow-[var(--shadow-2)] sm:h-40 sm:w-40"
      style={{ viewTransitionName: `jam-cover-${song.id}` } as CSSProperties}
      data-jam-cover=""
      data-jam-cover-photo-on={covered ? "true" : undefined}
    >
      <div aria-hidden="true" className="absolute inset-0">
        {covered ? <JamCoverPhoto cover={cover} eager /> : <SongArt song={song} />}
      </div>
      {playing && (
        <span aria-hidden="true" className="absolute bottom-1.5 left-1.5 flex h-5 items-center rounded-full bg-media-scrim/85 px-1.5 text-on-media">
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
            className="absolute inset-x-0 top-1/2 mx-auto flex h-9 w-max -translate-y-1/2 items-center gap-1.5 rounded-full bg-media-scrim/80 px-3 text-xs font-bold opacity-0 backdrop-blur-sm transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-focus-within:opacity-100 max-sm:hidden"
          >
            <Camera className="h-4 w-4 shrink-0" strokeWidth={2.25} />
            <span className="max-sm:hidden">{covered ? t("jam.edit.changePhoto") : t("jam.edit.addPhoto")}</span>
          </span>
        </button>
      )}
    </div>
  );
}

/** Time along the top of the band: where each lane is, and a place to click to jump. */
export function Ruler({ timeline, onSeek }: { timeline: { startMs: number; endMs: number }; onSeek: (fraction: number) => void }) {
  const length = timeline.endMs - timeline.startMs;
  // About one label per 56 px, on a round number of seconds.
  const [ref, width] = useBarCount(1, 4000);
  const fits = Math.max(1, Math.floor(width / 56));
  const step = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000].find((one) => length / one <= fits) ?? 60_000;
  const marks: number[] = [];
  for (let at = 0; at <= length - step / 3; at += step) marks.push(at);
  return (
    <div className="grid grid-cols-[var(--lane-head)_minmax(0,1fr)] gap-3 px-1.5 pb-1 max-sm:hidden" aria-hidden="true">
      <span />
      <div ref={ref} className="relative h-5">
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

/** One line through every lane at once, from the engine's clock. */
export function Playhead({ clock, timeline }: { clock: JamClock; timeline: { startMs: number; endMs: number } }) {
  const line = useRef<HTMLDivElement | null>(null);
  useEffect(
    () =>
      clock.subscribe((positionMs) => {
        const element = line.current;
        if (!element) {
          return;
        }
        const fraction = Math.min(1, Math.max(0, (positionMs - timeline.startMs) / Math.max(1, timeline.endMs - timeline.startMs)));
        element.style.left = `${fraction * 100}%`;
      }),
    [clock, timeline.startMs, timeline.endMs],
  );
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-[calc(var(--lane-head)+1.125rem)] right-1.5 max-sm:hidden"
    >
      <div ref={line} className="absolute bottom-0 left-0 top-6 w-0.5 -translate-x-1/2 rounded-full bg-text shadow-[var(--shadow-2)]" />
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
  const Icon = look.icon;
  return (
    <li
      data-jam-slot={instrument}
      style={{ "--jam-l": index } as CSSProperties}
      className="jam-lane-in flex flex-col gap-2 rounded-[var(--radius-card)] p-1.5 sm:grid sm:grid-cols-[var(--lane-head)_minmax(0,1fr)] sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-dashed border-current", look.ink)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-extrabold text-text">{t(look.nameKey as MessageKey)}</span>
          <span className="truncate text-xs text-text-secondary">{who === null ? t("jam.song.lookingYou") : t("jam.song.looking", { name: who })}</span>
        </span>
      </div>
      {/* the empty lane is itself the button: where the part goes is where you press */}
      {canRecord ? (
        <button
          type="button"
          onClick={onRecord}
          data-jam-slot-record={instrument}
          aria-label={t(`jam.song.recordAs.${instrument}` as MessageKey)}
          className="group flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border-2 border-dashed border-border-strong text-[13px] font-semibold text-text-secondary outline-none transition-[background-color,border-color,color] duration-[var(--duration-base)] hover:border-accent hover:bg-accent-soft hover:text-on-accent-soft focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Mic className="h-4 w-4 transition-transform duration-[var(--duration-base)] motion-safe:group-hover:scale-110" aria-hidden />
          {t("jam.song.slotHint", { instrument: t(look.nameKey as MessageKey).toLowerCase() })}
        </button>
      ) : (
        <div className={cn("flex h-14 items-center justify-center rounded-[var(--radius-control)] border-2 border-dashed border-current text-xs font-bold", look.ink)}>
          {t(look.missingKey as MessageKey)}
        </div>
      )}
    </li>
  );
}
