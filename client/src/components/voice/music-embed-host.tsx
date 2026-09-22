import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * ONE EMBED, NEVER REPARENTED.
 *
 * The YouTube iframe lives on a #root-level paint dock for the whole listen
 * session. The sidebar `data-music-embed-dock` node is only a sizer. "Ver no
 * palco" overlays that paint dock over the stage slot: no `appendChild` into
 * the call grid, and no `overflow: hidden` sidebar clip. Mounting on `#root`
 * (not `body`) keeps tile labels above the picture.
 */

let embedHost: HTMLDivElement | null = null;
let embedDock: HTMLElement | null = null;
let paintDock: HTMLDivElement | null = null;
let overlayCleanup: (() => void) | null = null;

const OVERLAY_STYLE_KEYS = [
  "position",
  "top",
  "left",
  "width",
  "height",
  "zIndex",
  "overflow",
  "visibility",
  "pointerEvents",
  "margin",
] as const;

export type MusicOverlayBox = {
  top: number;
  left: number;
  width: number;
  height: number;
  zIndex: number;
};

export function getMusicEmbedHost(): HTMLDivElement {
  if (!embedHost) {
    embedHost = document.createElement("div");
    embedHost.style.width = "100%";
    embedHost.style.height = "100%";
    embedHost.setAttribute("data-music-embed-host", "");
  }
  return embedHost;
}

/**
 * The iframe's real parent. Lives on `#root` so `position: fixed` is
 * viewport-fixed, an `overflow: hidden` sidebar cannot clip it, and stage
 * labels (z-10) still paint above the picture. The React
 * `data-music-embed-dock` node is only a sizer / overlay target.
 */
export function getMusicPaintDock(): HTMLDivElement {
  if (!paintDock) {
    paintDock = document.createElement("div");
    paintDock.setAttribute("data-music-embed-paint", "");
  }
  if (!paintDock.isConnected) {
    restPaintDock(paintDock);
    const home = document.getElementById("root") ?? document.body;
    home.appendChild(paintDock);
  }
  return paintDock;
}

function restPaintDock(dock: HTMLElement): void {
  dock.style.position = "fixed";
  dock.style.top = "0";
  dock.style.left = "0";
  dock.style.width = "0";
  dock.style.height = "0";
  dock.style.zIndex = "2";
  dock.style.overflow = "hidden";
  dock.style.visibility = "hidden";
  dock.style.pointerEvents = "none";
  dock.style.margin = "0";
  dock.style.borderRadius = "";
  dock.removeAttribute("data-music-embed-overlay");
}

export function registerMusicEmbedDock(el: HTMLElement | null) {
  embedDock = el;
}

export function musicEmbedDock(): HTMLElement | null {
  return embedDock;
}

/** Live in the document, including a parent that React has not detached yet. */
export function connectedMusicEmbedHome(
  el: HTMLElement | null | undefined,
): HTMLElement | null {
  return el && el.isConnected ? el : null;
}

/**
 * Park the singleton host in `dock` when it is homeless.
 *
 * `parentNode` stays set after the previous dock unmounts, so a hang-up
 * (MusicMiniPlayer returns null) leaves the YouTube iframe on a disconnected
 * node. The next seat's dock then skips the claim and the portal plays into
 * a tree that is not on screen. `isConnected` is the live-document check.
 * A host already in a live dock stays there: the stage never steals it.
 */
export function claimMusicEmbedHost(dock: HTMLElement): void {
  const host = getMusicEmbedHost();
  if (!host.isConnected) {
    dock.appendChild(host);
  }
}

export function musicOverlayZIndex(slot: HTMLElement): number {
  const stage = slot.closest("[data-testid='call-stage']");
  if (stage && typeof getComputedStyle === "function") {
    if (getComputedStyle(stage).position === "fixed") {
      return 51;
    }
  }
  const full =
    typeof document !== "undefined"
      ? (document.fullscreenElement ??
        (document as Document & { webkitFullscreenElement?: Element | null })
          .webkitFullscreenElement)
      : null;
  if (full && full.contains(slot)) {
    return 51;
  }
  return 2;
}

export function musicOverlayBox(slot: HTMLElement): MusicOverlayBox {
  const r = slot.getBoundingClientRect();
  const zIndex = musicOverlayZIndex(slot);
  let height = r.height;
  const bar = slot.ownerDocument.querySelector<HTMLElement>(
    "[data-testid='call-controls-bar']",
  );
  if (bar && zIndex >= 51) {
    const b = bar.getBoundingClientRect();
    if (b.top < r.bottom && b.bottom > r.top) {
      height = Math.max(0, b.top - r.top);
    }
  }
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height,
    zIndex,
  };
}

function clearOverlayStyles(dock: HTMLElement): void {
  if (dock.hasAttribute("data-music-embed-paint")) {
    restPaintDock(dock);
    return;
  }
  for (const key of OVERLAY_STYLE_KEYS) {
    dock.style[key] = "";
  }
  dock.style.borderRadius = "";
  dock.removeAttribute("data-music-embed-overlay");
}

/**
 * Paint the dock over `slot` with `position: fixed`. The host stays a child
 * of the dock. Cleanup restores in-flow styles so hide/show is CSS only.
 */
export function attachMusicEmbedOverlay(slot: HTMLElement): () => void {
  overlayCleanup?.();
  overlayCleanup = null;
  const dock = musicEmbedDock();
  if (!dock) {
    return () => {};
  }
  const apply = () => {
    if (!slot.isConnected || !dock.isConnected) {
      return;
    }
    const box = musicOverlayBox(slot);
    dock.style.position = "fixed";
    dock.style.top = `${box.top}px`;
    dock.style.left = `${box.left}px`;
    dock.style.width = `${box.width}px`;
    dock.style.height = `${box.height}px`;
    dock.style.zIndex = String(box.zIndex);
    dock.style.overflow = "hidden";
    dock.style.visibility = "visible";
    dock.style.pointerEvents = "none";
    dock.style.margin = "0";
    dock.style.borderRadius = getComputedStyle(slot).borderRadius;
    dock.setAttribute("data-music-embed-overlay", "");
  };
  apply();
  const ro =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
  ro?.observe(slot);
  const stage = slot.closest("[data-testid='call-stage']");
  if (stage && ro) {
    ro.observe(stage);
  }
  window.addEventListener("resize", apply);
  window.addEventListener("scroll", apply, true);
  const stop = () => {
    ro?.disconnect();
    window.removeEventListener("resize", apply);
    window.removeEventListener("scroll", apply, true);
    clearOverlayStyles(dock);
    if (overlayCleanup === stop) {
      overlayCleanup = null;
    }
  };
  overlayCleanup = stop;
  return stop;
}

export function useMusicEmbedDock(): RefObject<HTMLDivElement | null> {
  const dockRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const anchor = dockRef.current;
    if (!anchor) {
      return;
    }
    const paint = getMusicPaintDock();
    registerMusicEmbedDock(paint);
    claimMusicEmbedHost(paint);
    // Do not clear the registration on cleanup: this effect re-runs whenever
    // the player redraws, and nulling it races a later dock on the next seat.
  });
  return dockRef;
}

/** Paint the body dock over `slot` while `active`. Host never moves. */
export function useMusicEmbedOverlay(
  slotRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const slot = slotRef.current;
    if (!slot) {
      return;
    }
    return attachMusicEmbedOverlay(slot);
  }, [slotRef, active]);
}

export function MusicEmbedOutlet(_props: {
  /** Kept so existing call sites type-check. The host is never moved here. */
  home?: RefObject<HTMLElement | null>;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useMusicEmbedOverlay(slotRef, true);
  return (
    <div
      ref={slotRef}
      data-testid="music-embed-outlet"
      data-music-stage-slot=""
      className="h-full w-full"
    />
  );
}

export function resetMusicEmbedHostForTests(): void {
  overlayCleanup?.();
  overlayCleanup = null;
  embedHost?.remove();
  embedHost = null;
  paintDock?.remove();
  paintDock = null;
  embedDock = null;
}
