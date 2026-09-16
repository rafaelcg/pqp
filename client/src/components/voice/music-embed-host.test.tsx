// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MusicEmbedOutlet,
  claimMusicEmbedHost,
  connectedMusicEmbedHome,
  getMusicEmbedHost,
  resetMusicEmbedHostForTests,
  useMusicEmbedDock,
} from "./music-embed-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

  it("moves the host onto the new dock after the previous one unmounted", () => {
    act(() => root.render(<Dock />));
    const host = getMusicEmbedHost();
    const firstDock = container.querySelector('[data-testid="dock"]');
    expect(host.parentNode).toBe(firstDock);

    act(() => root.render(null));
    expect(host.isConnected).toBe(false);
    expect(host.parentNode).not.toBeNull();

    act(() => root.render(<Dock />));
    const secondDock = container.querySelector('[data-testid="dock"]');
    expect(secondDock).not.toBe(firstDock);
    expect(host.parentNode).toBe(secondDock);
    expect(host.isConnected).toBe(true);
  });

  it("leaves the host in a live outlet instead of pulling it back to the dock", () => {
    function Harness({ showOutlet }: { showOutlet: boolean }) {
      const dockRef = useMusicEmbedDock();
      return (
        <>
          <div ref={dockRef} data-testid="dock" data-music-embed-dock="" />
          {showOutlet ? <MusicEmbedOutlet home={dockRef} /> : null}
        </>
      );
    }

    act(() => root.render(<Harness showOutlet />));
    const host = getMusicEmbedHost();
    const outlet = container.querySelector('[data-testid="music-embed-outlet"]');
    expect(host.parentNode).toBe(outlet);

    act(() => root.render(<Harness showOutlet />));
    expect(host.parentNode).toBe(outlet);
  });
});
