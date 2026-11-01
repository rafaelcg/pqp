import {
  MonitorPlay as MonitorPlayGlyph,
  Pause as PauseGlyph,
  Play as PlayGlyph,
  X as XGlyph,
} from "@phosphor-icons/react";
import { MonitorPlay, Pause, Play, X } from "lucide-react";
import { IconSwap } from "@/components/ui/icon";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { rememberMusicPip } from "@/lib/music-pip";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { createPortal } from "react-dom";
import { useTranslation } from "@/lib/i18n";
import { setMusicPlacement, useMusicPrefs } from "@/lib/music-prefs";
import {
  setMusicOpen,
  setPlaying,
  seekTo,
  useMusic,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import {
  canSetMusicSwitches,
  effectiveCanManageMusic,
  MusicHistoryList,
  MusicOverflowMenu,
  MusicShuffleButton,
} from "@/components/voice/music-extras";
import {
  formatMusicClock,
  formatMusicClockOrUnknown,
  lookupAddedBy,
  usePlaybackProgress,
} from "@/components/voice/music-now-playing";
import { MusicQueueList } from "@/components/voice/music-queue-list";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";
import { useScrub } from "@/components/voice/use-scrub";
import {
  MUSIC_COVER_REDESIGN,
  MUSIC_ICON_REDESIGN,
  MUSIC_LABEL_REDESIGN,
  MUSIC_TITLE_REDESIGN,
  MUSIC_MUTED_REDESIGN,
  MUSIC_TEXT_REDESIGN,
} from "@/components/voice/music-classes";

const RAIL_ICON = cn(
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper",
  MUSIC_ICON_REDESIGN,
);
const SHEET_ICON = cn(
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-3 hover:text-text",
  MUSIC_ICON_REDESIGN,
);

function onPage(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

/**
 * THE QUEUE.
 *
 * In the call's composer it is a chat-width queue above the player bar.
 * Away from that channel it is a right-edge drawer over the members list,
 * without unmounting them. The drawer keeps a now-playing card because
 * that radio has no seek and keeps the five-item `…`; the sheet does
 * not, because the bar under it is the player.
 *
 * ONE COLUMN, ALWAYS THE SAME ONE. The field is mounted for the whole life
 * of the panel and search results land above the queue rather than in its
 * place: adding to a queue you can no longer see is how you add the same
 * song twice. Escape from an empty field closes the panel.
 */
export function MusicFila({
  variant = "sheet",
  voiceState,
}: {
  variant?: "sheet" | "drawer";
  voiceState: VoiceState;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const prefs = useMusicPrefs();
  const current = music.state?.current ?? null;
  const canManage = effectiveCanManageMusic(voiceState, music.state);
  const canSetSwitches = canSetMusicSwitches(voiceState);
  const playing = music.state?.status === "playing";
  const progress = usePlaybackProgress(music, current?.durationMs ?? null);
  const scrub = useScrub((value) => seekTo(value));
  /** Empty field, so the line that says what it takes is still useful. */
  const [fieldIdle, setFieldIdle] = useState(true);
  // The picker reports this from an effect that lists the callback, so a
  // stable identity keeps it from re-running on every render of this panel.
  const onQueryActive = useCallback((active: boolean) => {
    setFieldIdle(!active);
  }, []);
  // The panel is open, so the tile's NOVO mark has done its job. Here
  // rather than on the tile, because the tile is only one of the four ways
  // in (the sidebar radio, the bar's queue icon and the keyboard are the
  // others) and the mark is about having opened this, not about the route.
  const filaOpen = music.open;
  useEffect(() => {
    if (filaOpen) {
      rememberMusicPip();
    }
  }, [filaOpen]);
  const onStage = prefs.placement === "stage";
  const queue = music.state?.queue ?? [];
  const history = music.state?.history ?? [];
  const duration = progress.durationMs ?? 0;
  const position = scrub.preview ?? progress.position;
  const durationKnown = progress.known;
  const addedBy = current
    ? lookupAddedBy(voiceState, current.addedByUserId, current.addedByName)
    : null;
  const headingCount = (current ? 1 : 0) + queue.length;
  const sheet = variant === "sheet";
  const iconClass = sheet ? SHEET_ICON : RAIL_ICON;
  const muted = cn(sheet ? "text-text-secondary" : "text-paper-muted", MUSIC_MUTED_REDESIGN);
  const title = cn(sheet ? "text-text" : "text-paper", MUSIC_TEXT_REDESIGN);
  const thumb = cn(sheet ? "bg-surface-3" : "bg-ink-3", MUSIC_COVER_REDESIGN);
  // Under the redesign the seams are the card's edge, in both homes.
  const rule = cn(sheet ? "border-border/60" : "border-ink-4/60", "redesign:border-[color:var(--card-border)]");
  const tone = sheet ? "composer" : "rail";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMusicOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
   * A press anywhere else closes the sheet, the way every popover does. The
   * drawer has its own backdrop for this; the sheet sits in the composer
   * with nothing over the page, so it listens instead.
   *
   * The player and the dock tile are not "elsewhere": both of them toggle
   * this panel, and closing here before their click lands would leave the
   * tile reopening what it had just shut. A menu or a dialog the panel
   * itself opened is portalled out of the composer, so it is excluded too.
   */
  useEffect(() => {
    if (!sheet || !music.open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(
          "[data-music-composer], [data-music-dock], [role='menu'], [role='dialog']",
        )
      ) {
        return;
      }
      setMusicOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [sheet, music.open]);

  if (!music.open) {
    return null;
  }

  const panel = (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 px-3 redesign:px-3.5",
          sheet ? "h-10" : "h-14",
          "border-b",
          rule,
        )}
      >
        <p
          className={cn(
            "truncate text-[11px] font-semibold uppercase tracking-wider",
            muted,
            MUSIC_TITLE_REDESIGN,
          )}
        >
          {t("memberList.sectionHeading", {
            label: t("music.fila"),
            count: headingCount,
          })}
        </p>
        <div className="flex shrink-0 items-center">
          {/* Shuffle belongs where the queue is: it re-orders the list
              below, so here the re-order IS the feedback. On the bar,
              with no queue on screen, pressing it looked like nothing
              happening at all. */}
          <MusicShuffleButton
            className={iconClass}
            disabled={!canManage || queue.length < 2}
          />
          {/* The sheet sits on the bar, which carries this toggle. The drawer
              is away from the call, with no bar under it. */}
          {!sheet && current && !onStage ? (
            <Tooltip label={t("music.stage.watch")} side="left">
              <button
                type="button"
                data-music-stage-watch=""
                className={iconClass}
                aria-label={t("music.stage.watch")}
                onClick={() => setMusicPlacement("stage")}
              >
                <IconSwap off={MonitorPlay} on={MonitorPlayGlyph} size="sm" offClassName="h-4 w-4" />
              </button>
            </Tooltip>
          ) : null}
          {!sheet ? (
            <MusicOverflowMenu
              canManage={canManage}
              canSetSwitches={canSetSwitches}
              listening={music.listening}
              ducking={prefs.ducking}
              openControls={music.state?.openControls === true}
              autoplay={music.state?.autoplay === true}
              repeat={music.state?.repeat ?? "off"}
              queueLength={music.state?.queue.length ?? 0}
              modes="all"
              side="bottom"
              triggerClassName={iconClass}
            />
          ) : null}
          <Tooltip label={t("music.close")} side="left">
            <button
              type="button"
              data-music-fila-close=""
              className={iconClass}
              aria-label={t("music.close")}
              onClick={() => setMusicOpen(false)}
            >
              <IconSwap off={X} on={XGlyph} kind="symbol" size="sm" offClassName="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!sheet && current && addedBy ? (
          <div className={cn("shrink-0 space-y-2 border-b px-3 py-2", rule)}>
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("relative h-12 w-12 shrink-0 overflow-hidden rounded-md", thumb)}>
                {current.thumbnailUrl ? (
                  <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <IconSwap off={Play} on={PlayGlyph} offClassName={cn("m-auto h-5 w-5", muted)} className={cn("m-auto", muted)} />
                )}
                <Tooltip
                  label={playing ? t("music.pause") : t("music.play")}
                  detail={canManage ? undefined : t("music.noManage")}
                >
                  <span className="absolute inset-0">
                    <button
                      type="button"
                      data-music-fila-play=""
                      className={cn(
                        "flex h-full w-full items-center justify-center bg-ink/70 text-paper",
                        "redesign:bg-black/45 redesign:text-white",
                        canManage ? "hover:bg-ink/80 redesign:hover:bg-black/60" : "opacity-40",
                      )}
                      aria-pressed={playing}
                      aria-label={playing ? t("music.pause") : t("music.play")}
                      disabled={!canManage}
                      onClick={() => {
                        if (canManage) {
                          setPlaying(!playing);
                        }
                      }}
                    >
                      {playing ? (
                        <IconSwap off={Pause} on={PauseGlyph} offClassName="h-5 w-5" />
                      ) : (
                        <IconSwap off={Play} on={PlayGlyph} offClassName="ml-0.5 h-5 w-5" />
                      )}
                    </button>
                  </span>
                </Tooltip>
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[13px] font-medium", title)}>{current.title}</p>
                {current.autoplayed ? (
                  <span
                    data-music-autoplayed=""
                    className={cn("mt-0.5 block truncate text-[11px]", muted)}
                  >
                    {t("music.autoplayed")}
                  </span>
                ) : (
                  <Tooltip label={t("music.addedBy", { name: addedBy.name })}>
                    <span data-music-added-by="" className="mt-0.5 inline-flex min-w-0 items-center gap-1">
                      <UserAvatar
                        name={addedBy.name}
                        avatarUrl={addedBy.avatarUrl}
                        className="h-3.5 w-3.5"
                        fallbackClassName="bg-ink-3 text-[9px] text-paper redesign:bg-surface-3 redesign:text-text"
                        rounded="full"
                      />
                      <span className={cn("truncate text-[11px]", muted)}>{addedBy.name}</span>
                    </span>
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("shrink-0 text-left text-[11px] tabular-nums", muted)}>
                {formatMusicClock(position)}
              </span>
              <Slider
                variant="scrub"
                readOnly={!canManage || !durationKnown}
                indeterminate={!durationKnown}
                value={position}
                min={0}
                max={durationKnown ? duration : 1}
                step={250}
                className="min-w-0 flex-1 px-1.5"
                aria-label={canManage && durationKnown ? t("music.seek") : t("music.progress")}
                {...scrub.rootProps}
                onValueChange={(value) => {
                  if (canManage && durationKnown) {
                    scrub.onValueChange(value);
                  }
                }}
                onValueCommit={(value) => {
                  if (canManage && durationKnown) {
                    scrub.onValueCommit(value);
                  }
                }}
              />
              <span className={cn("shrink-0 text-right text-[11px] tabular-nums", muted)}>
                {formatMusicClockOrUnknown(durationKnown ? duration : null)}
              </span>
            </div>
          </div>
        ) : null}

        <div className={cn("shrink-0 px-2 pt-2", sheet && "redesign:pr-3.5")}>
          <MusicSearchPicker
            compact
            chrome={sheet ? "default" : "rail"}
            canManage={canManage}
            autoFocus
            onQueryActive={onQueryActive}
            onEmptyEscape={() => setMusicOpen(false)}
          />
        </div>

        {fieldIdle ? (
          /* Under the field, not over it: the first thing a new person needs
             is somewhere to paste, and the second is what may be pasted.
             The sources line stays for as long as the field is empty, so
             opening the queue mid-song answers the question too; the longer
             explanation is for a room with nothing on. */
          <div data-music-empty="" className="shrink-0 space-y-1.5 px-3 pt-2 redesign:px-3.5">
            {current ? null : (
              <p className={cn("text-[12px] leading-snug", muted)}>
                {t("music.empty.what")}
              </p>
            )}
            <p className={cn("text-[11px]", muted)}>{t("music.empty.sources")}</p>
          </div>
        ) : null}

        {/* At least a row of a non-empty queue stays in sight when the panel
            is cut short and scrolls as a whole. */}
        <div
          className={cn(
            "flex-1 overflow-y-auto px-2 py-2",
            queue.length > 0 ? "min-h-12" : "min-h-0",
            // The sheet closes its list with the header's seam, so the last row never reads as the player's.
            sheet && "redesign:border-b redesign:border-[color:var(--card-border)]",
          )}
        >
          {queue.length > 0 && (
            <div>
              <p
                className={cn(
                  "mb-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wider",
                  muted,
                  MUSIC_LABEL_REDESIGN,
                  "redesign:mb-0.5 redesign:px-1.5",
                )}
              >
                {t("memberList.sectionHeading", {
                  label: t("music.queue"),
                  count: queue.length,
                })}
              </p>
              <MusicQueueList
                queue={queue}
                voiceState={voiceState}
                canManage={canManage}
                tone={tone}
              />
            </div>
          )}
          {music.state?.autoplay && queue.length === 0 && current ? (
            <p data-music-autoplay-next="" className={cn("px-1 py-1 text-[11px] redesign:px-1.5", muted)}>
              {t("music.autoplay.next")}
            </p>
          ) : null}
          <MusicHistoryList
            history={history}
            defaultOpen={queue.length === 0}
            tone={tone}
          />
        </div>
      </div>
    </>
  );

  return (
    <>
      {variant === "drawer" ? (
        /*
         * On the page body, not where it is mounted. The mount is the
         * channel sidebar's footer, and that sidebar has a `transform` for
         * its mobile slide-in, which makes `position: fixed` relative to the
         * sidebar instead of the window: this "right-edge drawer over the
         * members list" drew over the CHANNEL list, with a backdrop that
         * darkened only that column. Same width as the members list.
         * Rendered in place where there is no page to portal to (a static
         * render), which draws the same markup.
         */
        onPage(
          <>
            <button
              type="button"
              className="fixed inset-0 z-20 bg-ink/70 redesign:bg-[color:var(--sheet-scrim)] redesign:backdrop-blur-[var(--sheet-scrim-blur)]"
              aria-label={t("music.close")}
              onClick={() => setMusicOpen(false)}
            />
            <aside
              data-music-fila="drawer"
              data-immersive-hide=""
              aria-label={t("music.fila")}
              className="fixed inset-y-0 right-0 z-30 flex w-[min(100%,15rem)] shrink-0 flex-col border-l border-ink-4/60 bg-channel shadow-[var(--shadow-popover)] redesign:border-[color:var(--card-border)] redesign:bg-pane-side redesign:shadow-[var(--drawer-shadow)]"
            >
              {panel}
            </aside>
          </>,
        )
      ) : (
        <section
          data-music-fila="sheet"
          aria-label={t("music.fila")}
          // `--fila-room` is what the call split has left under the stage,
          // so a long queue scrolls instead of pushing the composer away.
          // Cut that short, the whole panel scrolls rather than letting its
          // add field spill over the player below it.
          className="flex max-h-[min(28rem,50dvh,var(--fila-room,28rem))] min-h-0 flex-col overflow-y-auto overscroll-contain"
        >
          {panel}
        </section>
      )}
    </>
  );
}
