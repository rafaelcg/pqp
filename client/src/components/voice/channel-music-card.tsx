import { Music, Pause, Play, SkipForward } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ChannelMusicTrack } from "@pqp/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  advance,
  setMusicOpen,
  setPlaying,
  useMusic,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";

/**
 * What a voice channel is playing, as a small card under its occupants.
 *
 * Two audiences. Somebody IN this call gets play/pause and skip on the card
 * (the same writes the popover makes) and a click on the title opens the
 * queue. Somebody outside it sees the title and a click joins the call,
 * because "they're listening to Legião" is the reason to walk in.
 *
 * A title longer than the card scrolls. The text is drawn twice with a gap
 * and the pair slides by half its width, so the loop is seamless; the
 * animation only runs when the title actually overflows, measured after
 * layout, and not at all under `prefers-reduced-motion`.
 */
export function ChannelMusicCard({
  channelId,
  track,
  inCall,
  onJoin,
}: {
  channelId: string;
  track: ChannelMusicTrack;
  inCall: boolean;
  onJoin?: () => void;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const playing = inCall && music.channelId === channelId && music.state?.status === "playing";
  const clipRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const text = textRef.current;
    if (!clip || !text) {
      return;
    }
    const measure = () => setOverflows(text.scrollWidth > clip.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    return () => observer.disconnect();
  }, [track.title]);

  const label = t("music.sidebar", { title: track.title });
  const onTitleClick = () => {
    if (inCall) {
      setMusicOpen(true);
    } else {
      onJoin?.();
    }
  };

  return (
    <div
      data-channel-music={channelId}
      className="ml-2 mt-0.5 flex items-center gap-1.5 rounded-md bg-ink-2/80 py-1 pl-2 pr-1 text-[11px] text-signal ring-1 ring-ink-4/60"
    >
      <Music className="h-3 w-3 shrink-0" aria-hidden="true" />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-label={inCall ? t("music.open") : t("music.sidebar.join", { title: track.title })}
        title={label}
        onClick={onTitleClick}
      >
        <span ref={clipRef} className="block overflow-hidden whitespace-nowrap">
          <span
            ref={textRef}
            className={cn("inline-block", overflows && "pqp-marquee")}
            style={overflows ? { "--marquee-s": `${Math.max(6, track.title.length / 4)}s` } as React.CSSProperties : undefined}
          >
            {track.title}
            {overflows && (
              <span aria-hidden="true" className="pl-8">
                {track.title}
              </span>
            )}
          </span>
        </span>
      </button>
      {inCall && (
        <>
          <Tooltip label={playing ? t("music.pause") : t("music.play")}>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-ink-3/70"
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Play className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          <Tooltip label={t("music.skip")}>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-ink-3/70"
              onClick={() => advance()}
            >
              <SkipForward className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
