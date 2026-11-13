import { HeartIcon as Heart, LoaderIcon as Loader2, MicIcon as Mic, PauseIcon as Pause, PlayIcon as Play, Share2Icon as Share2 } from "./icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import type { Instrument } from "./instruments";
import type { PublicPlayer } from "./player";
import { useClockDraw, usePlayerState } from "./use-player";
import { button, buttonClass, focusRing } from "./ui";
import { clock, cn } from "./util";

/**
 * Play, the time, the seek bar, like, share and the one record button. The
 * clock part (`Seek`) redraws every frame on its own so nothing else on the
 * page re-renders with the song.
 */

function Seek({ player }: { player: PublicPlayer }) {
  const state = usePlayerState(player);
  const input = useRef<HTMLInputElement | null>(null);
  const label = useRef<HTMLSpanElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const duration = Math.max(1, state.durationMs);

  const draw = useCallback(() => {
    const position = Math.min(duration, player.position());
    if (input.current && !dragging.current) {
      input.current.value = String(position);
      input.current.style.setProperty("--p", `${(position / duration) * 100}%`);
    }
    if (label.current && !dragging.current) {
      label.current.textContent = clock(position);
    }
  }, [player, duration]);
  useClockDraw(player, draw);

  const commit = (value: number) => {
    player.seek(value);
    dragging.current = false;
    setDrag(null);
  };

  return (
    <>
      <span className="shrink-0 tabular-nums text-sm text-text-secondary" data-jam-time="">
        <span ref={label}>0:00</span> / {clock(state.durationMs)}
      </span>
      <input
        ref={input}
        type="range"
        min={0}
        max={duration}
        step={50}
        defaultValue={0}
        aria-label={jt("seek.label")}
        aria-valuetext={`${clock(drag ?? player.position())} / ${clock(state.durationMs)}`}
        data-jam-seek=""
        className="jam-seek order-5 h-11 min-w-0 basis-full md:order-none md:h-6 md:basis-auto md:flex-1"
        onKeyDown={(event) => {
          // Five seconds an arrow, a seventh of the song a page key; Home and End are the range's own.
          const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 5000 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -5000 : event.key === "PageUp" ? duration / 7 : event.key === "PageDown" ? -duration / 7 : 0;
          if (step === 0) return;
          event.preventDefault();
          player.seek(Math.max(0, Math.min(duration, player.position() + step)));
        }}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={(event) => commit(Number(event.currentTarget.value))}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (dragging.current) {
            event.currentTarget.style.setProperty("--p", `${(value / duration) * 100}%`);
            if (label.current) label.current.textContent = clock(value);
            setDrag(value);
          } else {
            // A key press: no drag, commit at once.
            player.seek(value);
          }
        }}
      />
    </>
  );
}

export function SongTransport({
  player,
  likes,
  need,
  onLike,
  onShare,
  onRecord,
  shared,
}: {
  player: PublicPlayer;
  likes: number;
  /** The first instrument the song asks for, or null. */
  need: Instrument | null;
  onLike: () => void;
  onShare: () => void;
  onRecord: () => void;
  /** "Link copiado": shown briefly after a copy. */
  shared: string | null;
}) {
  const state = usePlayerState(player);
  const loading = state.phase === "loading";
  const toggle = () => player.toggle();

  // Space plays and pauses when the focus is not in something that owns Space.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body) {
        if (target.closest("input, textarea, select, button, a, [role='button'], [contenteditable='true'], dialog")) return;
      }
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      player.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  return (
    <div className="relative mt-4 flex flex-wrap items-center gap-x-3 gap-y-3 md:flex-nowrap md:gap-x-4" data-jam-transport="">
      <button
        type="button"
        onClick={toggle}
        aria-label={state.playing ? jt("transport.pause") : jt("transport.play")}
        data-jam-toggle=""
        data-playing={state.playing ? "true" : "false"}
        data-phase={state.phase}
        className={cn(
          "grid h-14 w-14 shrink-0 place-items-center rounded-full bg-text text-surface-0 transition-transform duration-[var(--duration-fast)] hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100",
          focusRing,
        )}
      >
        {loading ? (
          <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden />
        ) : state.playing ? (
          <Pause className="h-6 w-6" fill="currentColor" aria-hidden />
        ) : (
          <Play className="h-6 w-6 translate-x-[1px]" fill="currentColor" aria-hidden />
        )}
      </button>
      <Seek player={player} />
      <div className="order-3 ml-auto flex items-center gap-1 md:order-none md:ml-0">
        <button
          type="button"
          onClick={onLike}
          aria-label={jt("like.label")}
          data-jam-like=""
          className={cn(buttonClass.base, "h-10 gap-1.5 px-3 text-sm text-text-secondary hover:bg-surface-2 hover:text-text pointer-coarse:h-11 pointer-coarse:min-w-11")}
        >
          <Heart className="h-[18px] w-[18px]" aria-hidden />
          {likes > 1 && <span className="tabular-nums">{likes}</span>}
        </button>
        <button
          type="button"
          onClick={onShare}
          data-jam-share=""
          className={cn(buttonClass.base, "h-10 gap-2 px-3 text-sm text-text-secondary hover:bg-surface-2 hover:text-text pointer-coarse:h-11 pointer-coarse:min-w-11")}
        >
          <Share2 className="h-[18px] w-[18px]" aria-hidden />
          <span className="max-sm:sr-only">{jt("share.label")}</span>
        </button>
      </div>
      <button
        type="button"
        onClick={onRecord}
        data-jam-record=""
        className={cn(button("primary"), "order-6 w-full basis-full md:order-none md:w-auto md:basis-auto")}
      >
        <Mic className="h-[18px] w-[18px]" aria-hidden />
        {need ? jt(`record.${need}` as Parameters<typeof jt>[0]) : jt("record.any")}
      </button>
      <p className="sr-only" role="status" aria-live="polite">
        {shared ?? ""}
      </p>
      {shared && (
        <p
          className="pointer-events-none absolute right-0 top-full z-10 mt-2 max-w-full truncate rounded-full bg-surface-3 px-3 py-1.5 text-sm font-semibold text-text shadow-[var(--shadow-2)]"
          aria-hidden="true"
        >
          {shared}
        </p>
      )}
      {state.phase === "error" && (
        <p className="order-8 basis-full text-sm font-semibold text-danger" role="alert" data-jam-audio-error="">
          {jt("song.audioError")}
        </p>
      )}
    </div>
  );
}
