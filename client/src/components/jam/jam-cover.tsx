import type { JamSongSummary } from "@pqp/shared";
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { barsFromPeaks, seededBars } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { coverGradient, MirrorBars } from "./jam-art";
import { useBarCount } from "./jam-bars";

/**
 * What a song with no photo shows in a square: the gradient through the colours
 * of its band and the loudest stem's waveform mirrored across it. The panel's
 * header and the edit sheet's cover stage both draw it, so the "no cover" state
 * reads as the same picture everywhere.
 */
export function SongArt({ song, className }: { song: JamSongSummary; className?: string }) {
  const [ref, count] = useBarCount(5, 24);
  const bars = useMemo(
    () => (count === 0 ? [] : song.previewPeaks.length > 0 ? barsFromPeaks(song.previewPeaks, count) : seededBars(song.id, count)),
    [count, song.previewPeaks, song.id],
  );
  return (
    <div className={cn("absolute inset-0 text-on-inst", coverGradient(song.instruments), className)} aria-hidden="true">
      <div ref={ref} className="absolute inset-x-[12%] inset-y-[22%]">
        <MirrorBars bars={bars} className="absolute inset-0 gap-[2px]" barClassName="bg-on-inst/75" />
      </div>
    </div>
  );
}

/**
 * A song's cover picture, drawn by the wall's tile and the song panel.
 *
 * The server hands every summary a freshly SIGNED address (`coverUrl`, see "A
 * SONG'S COVER" in `packages/shared/src/jam.ts`), so the same picture arrives
 * under a different query string on every list read and every song frame. An
 * `<img>` that followed the string would reload and flash each time somebody
 * adds a take. The PATH (everything before `?`) is the picture's identity, the
 * key inside it never changes for one picture, so this keeps the address it
 * already drew for as long as the path is the same, and takes the new one only
 * when the picture is a different one, or when the held address failed (an
 * expired signature) and a fresher one has arrived.
 *
 * `status` is what a caller lays itself out by: a tile whose cover failed falls
 * back to the art it has always had, never to a broken image.
 */

export type JamCoverStatus = "none" | "loading" | "ready" | "failed";

interface Held {
  path: string;
  src: string;
  status: Exclude<JamCoverStatus, "none">;
}

const pathOf = (url: string): string => url.split("?")[0] ?? url;

export interface JamCoverState {
  src: string | null;
  status: JamCoverStatus;
  onLoad: () => void;
  onError: () => void;
}

export function useJamCover(url: string | null): JamCoverState {
  const [held, setHeld] = useState<Held | null>(null);
  let current = held;
  if (url === null) {
    current = null;
  } else if (
    current === null ||
    current.path !== pathOf(url) ||
    (current.status === "failed" && current.src !== url)
  ) {
    current = { path: pathOf(url), src: url, status: "loading" };
  }
  if (current !== held) {
    // Derived from the prop, adjusted in the render it changes in: no flash of
    // the old picture under a new address.
    setHeld(current);
  }
  const src = current?.src ?? null;
  const settle = useCallback(
    (status: "ready" | "failed") =>
      setHeld((before) => (before && before.src === src && before.status !== status ? { ...before, status } : before)),
    [src],
  );
  return {
    src,
    status: current?.status ?? "none",
    onLoad: () => settle("ready"),
    onError: () => settle("failed"),
  };
}

/**
 * The picture itself, filling its positioned parent. It fades in once decoded
 * (a cached one is simply there), and under reduced motion there is no fade.
 */
export function JamCoverPhoto({
  cover,
  className,
  style,
  eager = false,
}: {
  cover: JamCoverState;
  className?: string;
  style?: CSSProperties;
  /** The panel and the edit sheet need it now; a wall of tiles lets the browser load what comes near. */
  eager?: boolean;
}) {
  if (cover.src === null || cover.status === "failed") {
    return null;
  }
  return (
    <img
      src={cover.src}
      alt=""
      draggable={false}
      decoding="async"
      loading={eager ? "eager" : "lazy"}
      onLoad={cover.onLoad}
      onError={cover.onError}
      data-jam-cover-photo=""
      data-ready={cover.status === "ready" ? "true" : undefined}
      style={style}
      className={cn(
        "absolute inset-0 h-full w-full select-none object-cover opacity-0 transition-opacity duration-[var(--duration-slow)] ease-[var(--ease-standard)] data-[ready=true]:opacity-100 motion-reduce:transition-none",
        className,
      )}
    />
  );
}
