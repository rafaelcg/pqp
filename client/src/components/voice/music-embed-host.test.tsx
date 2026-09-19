// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MusicEmbedOutlet,
  attachMusicEmbedOverlay,
  claimMusicEmbedHost,
  connectedMusicEmbedHome,
  getMusicEmbedHost,
  getMusicPaintDock,
  musicOverlayBox,
  registerMusicEmbedDock,
  resetMusicEmbedHostForTests,
  useMusicEmbedDock,
} from "./music-embed-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function stubRect(
  el: HTMLElement,
  box: { top: number; left: number; width: number; height: number },
) {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      bottom: box.top + box.height,
      right: box.left + box.width,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    }) as DOMRect;
}

describe("claimMusicEmbedHost", () => {
  beforeEach(() => {
    resetMusicEmbedHostForTests();
  });

  afterEach(() => {
    resetMusicEmbedHostForTests();
  });

  it("parks a homeless host in the dock", () => {
    const dock = document.createElement("div");
    document.body.appendChild(dock);
    const host = getMusicEmbedHost();
    claimMusicEmbedHost(dock);
    expect(host.parentNode).toBe(dock);
    expect(host.isConnected).toBe(true);
    dock.remove();
  });

  it("reclaims a host still parented to a disconnected dock", () => {
    const stale = document.createElement("div");
    const live = document.createElement("div");
    document.body.appendChild(live);
    const host = getMusicEmbedHost();
    stale.appendChild(host);
    expect(host.parentNode).toBe(stale);
    expect(host.isConnected).toBe(false);

    claimMusicEmbedHost(live);
    expect(host.parentNode).toBe(live);
    expect(host.isConnected).toBe(true);
    live.remove();
  });

  it("does not steal a host that is already in the live document", () => {
    const stage = document.createElement("div");
    const dock = document.createElement("div");
    document.body.appendChild(stage);
    document.body.appendChild(dock);
    const host = getMusicEmbedHost();
    stage.appendChild(host);

    claimMusicEmbedHost(dock);
    expect(host.parentNode).toBe(stage);
    stage.remove();
    dock.remove();
  });
});

describe("connectedMusicEmbedHome", () => {
  it("rejects a detached node", () => {
    const detached = document.createElement("div");
    expect(connectedMusicEmbedHome(detached)).toBeNull();
    document.body.appendChild(detached);
    expect(connectedMusicEmbedHome(detached)).toBe(detached);
    detached.remove();
  });
});

describe("attachMusicEmbedOverlay", () => {
  beforeEach(() => {
    resetMusicEmbedHostForTests();
  });

  afterEach(() => {
    resetMusicEmbedHostForTests();
  });

  it("paints the dock over the slot without moving the host", () => {
    const dock = document.createElement("div");
    const slot = document.createElement("div");
    document.body.appendChild(dock);
    document.body.appendChild(slot);
    registerMusicEmbedDock(dock);
    claimMusicEmbedHost(dock);
    const host = getMusicEmbedHost();
    stubRect(slot, { top: 10, left: 20, width: 300, height: 160 });

    const stop = attachMusicEmbedOverlay(slot);
    expect(host.parentNode).toBe(dock);
    expect(dock.getAttribute("data-music-embed-overlay")).toBe("");
    expect(dock.style.position).toBe("fixed");
    expect(dock.style.top).toBe("10px");
    expect(dock.style.left).toBe("20px");
    expect(dock.style.width).toBe("300px");
    expect(dock.style.height).toBe("160px");
    expect(dock.style.pointerEvents).toBe("none");

    stop();
    expect(host.parentNode).toBe(dock);
    expect(dock.getAttribute("data-music-embed-overlay")).toBeNull();
    expect(dock.style.position).toBe("");
    dock.remove();
    slot.remove();
  });

  it("paints from a body dock so an overflow-hidden sidebar cannot clip the stage", () => {
    const aside = document.createElement("aside");
    aside.style.overflow = "hidden";
    aside.style.position = "relative";
    const sizer = document.createElement("div");
    aside.appendChild(sizer);
    document.body.appendChild(aside);
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    stubRect(slot, { top: 100, left: 400, width: 500, height: 280 });

    const paint = getMusicPaintDock();
    registerMusicEmbedDock(paint);
    claimMusicEmbedHost(paint);
    const host = getMusicEmbedHost();
    const stop = attachMusicEmbedOverlay(slot);

    expect(host.parentNode).toBe(paint);
    expect(paint.parentNode).toBe(document.getElementById("root") ?? document.body);
    expect(host.parentNode).not.toBe(sizer);
    expect(paint.style.position).toBe("fixed");
    expect(paint.style.left).toBe("400px");
    expect(paint.style.top).toBe("100px");
    expect(paint.style.width).toBe("500px");
    expect(paint.style.height).toBe("280px");

    stop();
    expect(host.parentNode).toBe(paint);
    expect(paint.getAttribute("data-music-embed-overlay")).toBeNull();
    expect(paint.style.visibility).toBe("hidden");
    aside.remove();
    slot.remove();
  });

  it("leaves a gap above the call control bar in fullscreen", () => {
    const stage = document.createElement("div");
    stage.setAttribute("data-testid", "call-stage");
    stage.style.position = "fixed";
    const slot = document.createElement("div");
    const bar = document.createElement("div");
    bar.setAttribute("data-testid", "call-controls-bar");
    stage.appendChild(slot);
    stage.appendChild(bar);
    document.body.appendChild(stage);
    stubRect(slot, { top: 0, left: 0, width: 800, height: 600 });
    stubRect(bar, { top: 528, left: 0, width: 800, height: 72 });
    const box = musicOverlayBox(slot);
    expect(box.zIndex).toBe(51);
    expect(box.height).toBe(528);
    stage.remove();
  });
});

describe("useMusicEmbedDock reclaims after hang-up", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetMusicEmbedHostForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetMusicEmbedHostForTests();
  });

  function Dock() {
    const dockRef = useMusicEmbedDock();
    return <div ref={dockRef} data-testid="dock" data-music-embed-dock="" />;
  }

  it("keeps the host on the body paint dock after the sidebar sizer unmounts", () => {
    act(() => root.render(<Dock />));
    const host = getMusicEmbedHost();
    const paint = getMusicPaintDock();
    expect(host.parentNode).toBe(paint);
    expect(paint.parentNode).toBe(document.getElementById("root") ?? document.body);
    expect(host.isConnected).toBe(true);

    act(() => root.render(null));
    expect(host.parentNode).toBe(paint);
    expect(host.isConnected).toBe(true);

    act(() => root.render(<Dock />));
    expect(host.parentNode).toBe(paint);
    expect(host.isConnected).toBe(true);
  });

  it("leaves the host in the dock when the stage outlet toggles", () => {
    function Harness({ showOutlet }: { showOutlet: boolean }) {
      const dockRef = useMusicEmbedDock();
      return (
        <>
          <div ref={dockRef} data-testid="dock" data-music-embed-dock="" />
          {showOutlet ? <MusicEmbedOutlet home={dockRef} /> : null}
        </>
      );
    }

    act(() => root.render(<Harness showOutlet={false} />));
    const host = getMusicEmbedHost();
    const paint = getMusicPaintDock();
    expect(host.parentNode).toBe(paint);

    act(() => root.render(<Harness showOutlet />));
    expect(host.parentNode).toBe(paint);

    act(() => root.render(<Harness showOutlet={false} />));
    expect(host.parentNode).toBe(paint);
  });
});
