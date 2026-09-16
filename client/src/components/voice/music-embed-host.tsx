import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * ONE EMBED, TWO PLACES.
 *
 * The YouTube iframe is mounted once. Its host is a detached node that
 * `appendChild` moves between the sidebar (or the panel's video slot) and
 * the call-stage tile. Same trick as `watch-dock.tsx`: a layout-effect
 * cleanup on the outlet rescues the host before React detaches the slot,
 * so navigating to a text channel does not pause the sound.
 */

let embedHost: HTMLDivElement | null = null;
let embedDock: HTMLElement | null = null;

export function getMusicEmbedHost(): HTMLDivElement {
  if (!embedHost) {
    embedHost = document.createElement("div");
    embedHost.style.display = "contents";
    embedHost.setAttribute("data-music-embed-host", "");
  }
  return embedHost;
}

export function registerMusicEmbedDock(el: HTMLElement | null) {
  embedDock = el;
}

export function musicEmbedDock(): HTMLElement | null {
  return embedDock;
}

export function useMusicEmbedDock(): RefObject<HTMLDivElement | null> {
  const dockRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    registerMusicEmbedDock(dock);
    const host = getMusicEmbedHost();
    if (!host.parentNode) {
      dock.appendChild(host);
    }
    // Do not clear the registration on cleanup: this effect re-runs whenever
    // the player redraws, and nulling it races the stage outlet's rescue.
  });
  return dockRef;
}

export function MusicEmbedOutlet({
  home,
}: {
  /** Where the host goes when this outlet unmounts. The sidebar dock is the fallback. */
  home?: RefObject<HTMLElement | null>;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) {
      return;
    }
    slot.appendChild(getMusicEmbedHost());
    return () => {
      // Reading `home.current` at cleanup is the point: the dock that is
      // mounted now, not the one from setup. Same as WatchStageOutlet.
      const fallback =
        // eslint-disable-next-line react-hooks/exhaustive-deps -- stale home is wrong
        home?.current ??
        musicEmbedDock() ??
        document.querySelector<HTMLElement>("[data-music-embed-dock]");
      fallback?.appendChild(getMusicEmbedHost());
    };
  }, [home]);
  return (
    <div
      ref={slotRef}
      data-testid="music-embed-outlet"
      style={{ display: "contents" }}
    />
  );
}

export function resetMusicEmbedHostForTests(): void {
  embedHost?.remove();
  embedHost = null;
  embedDock = null;
}
