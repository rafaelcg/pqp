import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

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
  /** The picture this one replaces, kept on screen until the new one has loaded. */
  previous: string | null;
}

const pathOf = (url: string): string => url.split("?")[0] ?? url;

export interface JamCoverState {
  src: string | null;
  status: JamCoverStatus;
  /**
   * The picture that was on screen before this one, while the new one loads:
   * a swapped cover must never leave a blank tile for the seconds a download
   * takes, so the old one stays until the new one has landed.
   */
  previous: string | null;
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
    const keep = current !== null && current.path !== pathOf(url) ? (current.status === "ready" ? current.src : current.previous) : null;
    current = { path: pathOf(url), src: url, status: "loading", previous: keep };
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
  // The old picture is let go a moment after the new one has faded in over it.
  const letGo = current?.status === "ready" && current.previous !== null;
  useEffect(() => {
    if (!letGo) {
      return;
    }
    const timer = window.setTimeout(
      () => setHeld((before) => (before && before.src === src ? { ...before, previous: null } : before)),
      700,
    );
    return () => window.clearTimeout(timer);
  }, [letGo, src]);
  return {
    src,
    status: current?.status ?? "none",
    previous: current?.previous ?? null,
    onLoad: () => settle("ready"),
    onError: () => settle("failed"),
  };
}

/**
 * The picture itself, filling its positioned parent. It fades in once decoded
 * (a cached one is simply there), and under reduced motion there is no fade.
 * While a swapped cover loads, the one it replaces stays underneath.
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
    <>
      {cover.previous !== null && (
        <img
          src={cover.previous}
          alt=""
          draggable={false}
          aria-hidden="true"
          data-jam-cover-previous=""
          className={cn("absolute inset-0 h-full w-full select-none object-cover", className)}
        />
      )}
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
    </>
  );
}
