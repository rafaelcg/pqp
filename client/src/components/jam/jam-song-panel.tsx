import type { JamFrame, JamInstrument, JamSongSummary, JamTrack, JamVoteResponse } from "@pqp/shared";
import { ArrowLeft, Lock, LockOpen, Mic, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cannotRecordReason, pickInstrument } from "@/lib/jam-record";
import { oneAtATime, switchTakeIn } from "@/lib/jam-mix";
import {
  applyJamVote,
  applyJamWrite,
  loadJamChannel,
  loadJamDetail,
  readJamChannel,
  useJamStoreEpoch,
} from "@/lib/jam-store";
import type { JamDetail } from "@/lib/jam-state";
import { competingInstruments, orderTracks, songNeed, songTimeline } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { formatList, useNeedLabel } from "./jam-need";
import { JamTrackRow } from "./jam-track-row";
import { JamTransport } from "./jam-transport";

/**
 * An open song: every in-mix track playing together through the engine, one
 * lane each with its person, instrument, waveform, mute, solo and volume; the
 * video of anybody who recorded one, locked to the audio; competing takes with
 * their votes; and the one big button, "Gravar por cima", which is there only
 * when the song lets this viewer add something (`viewer.addableInstruments`).
 */

export interface JamSongPanelProps {
  channelId: string;
  song: JamSongSummary;
  detail: JamDetail | undefined;
  viewerId: string | null;
  /** `GET /api/jam/config`: the flag, and whether storage is there. */
  enabled: boolean;
  uploads: boolean;
  /** Open the studio over this song, pre-selected on this instrument. */
  onRecord: (instrument: JamInstrument) => void;
  onClose: () => void;
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
  freshTrackId,
  autoplay = true,
}: JamSongPanelProps) {
  const { t, locale } = useTranslation();
  const needLabel = useNeedLabel();
  const tracks = useMemo(() => orderTracks(detail?.tracks ?? []), [detail?.tracks]);
  const playback = useJamPlayback(song.id, tracks, { autoplay });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<JamTrack | null>(null);
  const [confirmSong, setConfirmSong] = useState(false);
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

  const viewer = detail?.viewer;
  const competing = useMemo(() => competingInstruments(tracks), [tracks]);
  const timeline = useMemo(() => songTimeline(tracks), [tracks]);
  const videoTracks = tracks.filter((track) => track.inMix && track.videoUrl);
  const need = songNeed(song);
  const mine = tracks.filter((track) => viewerId !== null && track.authorId === viewerId);
  const addable = viewer?.addableInstruments ?? [];
  const reason = cannotRecordReason({ enabled, uploads, addable, joinMode: song.joinMode });
  const canManage = viewer ? viewer.isAuthor || viewer.canModerate : false;
  const first = pickInstrument(song, addable, mine);

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
  const stemLoading = (trackId: string) => playback.stemStatus[trackId] === "loading";
  const stemFailed = (trackId: string) => playback.stemStatus[trackId] === "error";
  const missingSlots =
    need.kind === "missing" ? need.instruments.filter((instrument) => !tracks.some((one) => one.instrument === instrument)) : [];

  return (
    <section
      aria-label={song.title}
      data-jam-song={song.id}
      className="flex h-full min-h-0 flex-col bg-surface-1"
    >
      <header className="flex items-start gap-1 border-b border-border px-2 py-2 sm:px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("jam.song.back")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1 px-1 pt-1">
          <h2 className="font-display text-xl font-extrabold leading-tight text-text [text-wrap:balance]">
            {song.title}
          </h2>
          <p className="truncate text-xs text-text-secondary">
            {song.artist ?? t("jam.original")} · {song.authorName ?? t("jam.tile.anonymous")}
          </p>
          <span className="mt-0.5 inline-flex w-fit items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-bold text-text">
            {needLabel(need)}
          </span>
          {song.joinMode === "wanted" && song.wantedInstruments.length > 0 && (
            <p data-jam-wanted-line="" className="text-xs text-text-secondary">
              {t("jam.song.wantedLine", {
                list: formatList(
                  song.wantedInstruments.map((one) => t(JAM_INSTRUMENT_LOOK[one].nameKey as MessageKey).toLowerCase()),
                  locale,
                ),
              })}
            </p>
          )}
          {song.joinMode === "closed" && (
            <p data-jam-closed-line="" className="flex items-center gap-1 text-xs text-text-secondary">
              <Lock className="h-3 w-3 shrink-0" aria-hidden />
              {t("jam.song.closedLine")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("jam.song.close")}
          className="hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring lg:grid"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4">
        {videoTracks.length > 0 && (
          <ul
            className={cn("grid gap-2", videoTracks.length === 1 ? "grid-cols-1" : "grid-cols-2")}
            aria-label={t("jam.song.videos")}
          >
            {videoTracks.map((track) => (
              <JamVideoTile
                key={track.id}
                track={track}
                attach={playback.attachVideo}
                label={`${t(JAM_INSTRUMENT_LOOK[track.instrument].nameKey as MessageKey)}, ${track.authorName ?? t("jam.tile.anonymous")}`}
                muted={playback.lanes[track.id]?.muted ?? false}
              />
            ))}
          </ul>
        )}

        <JamTransport
          clock={playback.clock}
          playing={playback.transport === "playing"}
          loading={!detail || playback.status === "loading"}
          durationMs={playback.durationMs || timeline.endMs}
          onToggle={playback.toggle}
          onSeek={playback.seek}
          title={song.title}
        />

        {!detail ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((one) => (
              <div key={one} className="h-[4.75rem] animate-pulse rounded-[var(--radius-card)] bg-surface-2" />
            ))}
          </div>
        ) : (
          <ul className="space-y-2" aria-label={t("jam.song.tracks")}>
            {tracks.map((track) => {
              const lane = playback.lanes[track.id] ?? { muted: false, solo: false, volume: 1 };
              const isMine = viewerId !== null && track.authorId === viewerId;
              return (
                <JamTrackRow
                  key={track.id}
                  track={track}
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
                  loading={stemLoading(track.id)}
                  failed={stemFailed(track.id)}
                  fresh={arrived.has(track.id) || freshTrackId === track.id}
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
                        );
                        if (outcome === "partial") {
                          setError(t("jam.error.swapPartial"));
                        }
                      }),
                    )
                  }
                  adjust={
                    isMine && enabled
                      ? {
                          engine: playback.engine,
                          onSave: async (patch) => {
                            const answer = await updateJamTrack(track.id, patch);
                            writeFrame({
                              type: "jam-track-updated",
                              channelId,
                              song: answer.song,
                              track: answer.track,
                            });
                          },
                        }
                      : undefined
                  }
                  onDelete={() => setPendingDelete(track)}
                  onAudition={() => playback.setAudition(playback.audition === track.id ? null : track.id)}
                />
              );
            })}
            {missingSlots.map((instrument) => {
              const look = JAM_INSTRUMENT_LOOK[instrument];
              const Icon = look.icon;
              return (
                <li
                  key={instrument}
                  data-jam-slot={instrument}
                  className="flex items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-border-strong p-2.5"
                >
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", look.fill)}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="text-sm font-bold text-text">{t(look.nameKey as MessageKey)}</span>
                    <span className="text-xs text-text-secondary">
                      {t("jam.song.looking", { name: song.authorName ?? t("jam.tile.anonymous") })}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
            {error}
          </p>
        )}

        {canManage && enabled && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                void guard(async () => {
                  const answer = await updateJamSong(song.id, {
                    joinMode: song.joinMode === "closed" ? "open" : "closed",
                    ...(song.joinMode === "closed" ? { wantedInstruments: [] } : {}),
                  });
                  writeFrame({ type: "jam-song-updated", channelId, song: answer.song });
                })
              }
            >
              {song.joinMode === "closed" ? (
                <LockOpen className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Lock className="h-3.5 w-3.5" aria-hidden />
              )}
              {song.joinMode === "closed" ? t("jam.song.reopen") : t("jam.song.finish")}
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 hover:text-danger" onClick={() => setConfirmSong(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              {t("jam.song.delete")}
            </Button>
          </div>
        )}
      </div>

      <footer className="safe-pb flex flex-col gap-2 border-t border-border bg-surface-1 px-3 py-3">
        {reason === null && first ? (
          <>
            <button
              type="button"
              data-jam-record-over=""
              onClick={() => onRecord(first)}
              className="flex h-14 w-full items-center justify-center gap-2.5 rounded-full bg-accent text-base font-bold text-on-accent outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.98]"
            >
              <Mic className="h-5 w-5" aria-hidden />
              {t("jam.song.record")}
            </button>
            <p className="text-center text-xs leading-snug text-text-tertiary [text-wrap:pretty]">
              {t("jam.song.recordHint")}
            </p>
          </>
        ) : (
          reason !== null &&
          detail && (
            <p role="status" className="text-center text-sm leading-snug text-text-secondary [text-wrap:pretty]">
              {t(`jam.song.cannot.${reason}` as MessageKey)}
            </p>
          )
        )}
      </footer>

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

/** A track's video, a muted <video> the engine keeps on the audio clock. */
function JamVideoTile({
  track,
  attach,
  label,
  muted,
}: {
  track: JamTrack;
  attach: (trackId: string, element: HTMLVideoElement) => () => void;
  label: string;
  muted: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    return attach(track.id, element);
  }, [attach, track.id]);
  return (
    <li className="relative aspect-video overflow-hidden rounded-[var(--radius-card)] bg-surface-0">
      <video
        ref={ref}
        src={track.videoUrl ?? undefined}
        muted
        playsInline
        preload="metadata"
        aria-label={label}
        className={cn("h-full w-full object-cover transition-opacity duration-[var(--duration-base)]", muted && "opacity-30")}
      />
      <span className="absolute bottom-1.5 left-1.5 rounded-full bg-media-scrim/80 px-2 py-0.5 text-[11px] font-semibold text-on-media">
        {label}
      </span>
    </li>
  );
}
