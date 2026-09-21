import { MonitorPlay, Pause, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
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
  effectiveCanManageMusic,
  MusicHistoryList,
  MusicOverflowMenu,
} from "@/components/voice/music-extras";
import {
  formatMusicClock,
  formatMusicClockOrUnknown,
  lookupAddedBy,
  usePlaybackProgress,
} from "@/components/voice/music-now-playing";
import { MusicQueueList } from "@/components/voice/music-queue-list";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";

const RAIL_ICON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper";
const SHEET_ICON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-3 hover:text-text";

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
  const playing = music.state?.status === "playing";
  const progress = usePlaybackProgress(music, current?.durationMs ?? null);
  const [scrub, setScrub] = useState<number | null>(null);
  const onStage = prefs.placement === "stage";
  const queue = music.state?.queue ?? [];
  const history = music.state?.history ?? [];
  const duration = progress.durationMs ?? 0;
  const position = scrub ?? progress.position;
  const durationKnown = progress.known;
  const addedBy = current
    ? lookupAddedBy(voiceState, current.addedByUserId, current.addedByName)
    : null;
  const headingCount = (current ? 1 : 0) + queue.length;
  const sheet = variant === "sheet";
  const iconClass = sheet ? SHEET_ICON : RAIL_ICON;
  const muted = sheet ? "text-text-secondary" : "text-paper-muted";
  const title = sheet ? "text-text" : "text-paper";
  const thumb = sheet ? "bg-surface-3" : "bg-ink-3";
  const rule = sheet ? "border-border/60" : "border-ink-4/60";
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

  if (!music.open) {
    return null;
  }

  const panel = (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 px-3",
          sheet ? "h-10" : "h-14",
          "border-b",
          rule,
        )}
      >
        <p
          className={cn(
            "truncate text-[11px] font-semibold uppercase tracking-wider",
            muted,
          )}
        >
          {t("memberList.sectionHeading", {
            label: t("music.fila"),
            count: headingCount,
          })}
        </p>
        <div className="flex shrink-0 items-center">
          {current && !onStage ? (
            <Tooltip label={t("music.stage.watch")} side="left">
              <button
                type="button"
                data-music-stage-watch=""
                className={iconClass}
                aria-label={t("music.stage.watch")}
                onClick={() => setMusicPlacement("stage")}
              >
                <MonitorPlay className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          {!sheet ? (
            <MusicOverflowMenu
              canManage={canManage}
              listening={music.listening}
              ducking={prefs.ducking}
              openControls={music.state?.openControls === true}
              autoplay={music.state?.autoplay === true}
              repeat={music.state?.repeat ?? "off"}
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
              <X className="h-4 w-4" />
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
                  <Play className={cn("m-auto h-5 w-5", muted)} aria-hidden="true" />
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
                        canManage ? "hover:bg-ink/80" : "opacity-40",
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
                        <Pause className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <Play className="ml-0.5 h-5 w-5" aria-hidden="true" />
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
                        fallbackClassName="bg-ink-3 text-[9px] text-paper"
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
                onValueChange={(value) => {
                  if (canManage && durationKnown) {
                    setScrub(value);
                  }
                }}
                onValueCommit={(value) => {
                  if (canManage && durationKnown) {
                    seekTo(value);
                    setScrub(null);
                  }
                }}
              />
              <span className={cn("shrink-0 text-right text-[11px] tabular-nums", muted)}>
                {formatMusicClockOrUnknown(durationKnown ? duration : null)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="shrink-0 px-2 pt-2">
          <MusicSearchPicker
            compact
            chrome={sheet ? "default" : "rail"}
            variant={current ? "queue" : "start"}
            canManage={canManage}
            autoFocus
            onEmptyEscape={() => setMusicOpen(false)}
          />
        </div>

        {current ? null : (
          /* Under the field, not over it: the first thing a new person needs
             is somewhere to paste, and the second is what may be pasted. */
          <div data-music-empty="" className="shrink-0 space-y-1.5 px-3 pt-2">
            <p className={cn("text-[12px] leading-snug", muted)}>
              {t("music.empty.what")}
            </p>
            <p className={cn("text-[11px]", muted)}>{t("music.empty.sources")}</p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {queue.length > 0 && (
            <div>
              <p
                className={cn(
                  "mb-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wider",
                  muted,
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
            <p data-music-autoplay-next="" className={cn("px-1 py-1 text-[11px]", muted)}>
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
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 bg-ink/70"
            aria-label={t("music.close")}
            onClick={() => setMusicOpen(false)}
          />
          <aside
            data-music-fila="drawer"
            data-immersive-hide=""
            aria-label={t("music.fila")}
            className="fixed inset-y-0 right-0 z-30 flex w-[min(100%,15rem)] shrink-0 flex-col border-l border-ink-4/60 bg-channel shadow-[var(--shadow-popover)]"
          >
            {panel}
          </aside>
        </>
      ) : (
        <section
          data-music-fila="sheet"
          aria-label={t("music.fila")}
          className="flex max-h-[min(28rem,50dvh)] min-h-0 flex-col"
        >
          {panel}
        </section>
      )}
    </>
  );
}
