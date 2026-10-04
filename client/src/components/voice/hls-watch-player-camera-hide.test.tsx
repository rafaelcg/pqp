// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveHlsUrl } from "@/lib/hls-playback";
import { IDLE_CHROME_DELAY_MS } from "@/hooks/use-idle-chrome";
import { CAMERA_SHOW_CHIP_MS } from "@/lib/watch-camera-pip";
import { HlsWatchPlayer } from "./hls-watch-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * "OCULTAR CÂMERA" IN ONE TAP (2026-10-03). Rafael could not find the hide
 * option during a live party: it was a choice inside a menu, in a bar that
 * fades. This drives the real player, both hls.js instances faked, through
 * the camera's own hide button, the "Mostrar câmera" chip that takes its
 * place for a few seconds, and the quick cluster's toggle, and checks that
 * none of it ever re-attaches the film.
 */

const CHANNEL = "d5559e70-8b1c-4a0b-8ffc-b61c88004c73";
const STARTED_AT = 1789496087461;
const SRC = resolveHlsUrl(`/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?t=tok`);
const CAMERA = resolveHlsUrl(
  `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30?t=tok`,
);

/** Every `attachMedia`, by element: the film's must happen exactly once. */
const attached: HTMLMediaElement[] = [];

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    static ErrorDetails = RealHls.ErrorDetails;
    config: Record<string, unknown>;
    liveSyncPosition: number | null = 100;
    levels: unknown[] = [];
    currentLevel = -1;
    nextLevel = -1;
    latency = 20;
    playingDate = null;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    on() {}
    off() {}
    loadSource() {}
    attachMedia(media: HTMLMediaElement) {
      attached.push(media);
    }
    stopLoad() {}
    startLoad() {}
    recoverMediaError() {}
    destroy() {}
  }
  return { ...actual, default: FakeHls };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(async () => "test-token"),
    fetchChannelLive: vi.fn(async () => ({ stream: null })),
  };
});

describe("hiding the presenter's camera", { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlay: typeof HTMLMediaElement.prototype.play;
  const store = new Map<string, string>();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    attached.length = 0;
    store.clear();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => store.get(key) ?? null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      store.set(key, String(value));
    });
    originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = vi.fn(async () => {}) as unknown as typeof HTMLMediaElement.prototype.play;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLMediaElement.prototype.play = originalPlay;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function settle() {
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const q = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  function filmVideo(): HTMLVideoElement {
    return Array.from(container.querySelectorAll("video")).find(
      (video) => !video.closest('[data-testid="watch-camera-pip"]'),
    )!;
  }

  async function cameraPaints() {
    for (let i = 0; i < 50 && !q("watch-camera-pip")?.querySelector("video"); i += 1) {
      await settle();
    }
    const camera = q("watch-camera-pip")!.querySelector("video")!;
    for (let i = 0; i < 50 && !attached.includes(camera); i += 1) {
      await settle();
    }
    await act(async () => {
      camera.dispatchEvent(new Event("playing"));
    });
  }

  async function mount(props: { fullscreen?: boolean } = {}) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer
            src={SRC}
            cameraSrc={CAMERA}
            layout="cinema"
            fullscreen={
              props.fullscreen ? { active: true, toggle: () => {} } : undefined
            }
          />
        </TooltipProvider>,
      );
    });
    for (let i = 0; i < 50 && !attached.includes(filmVideo()); i += 1) {
      await settle();
    }
    await act(async () => {
      filmVideo().dispatchEvent(new Event("playing"));
    });
    await cameraPaints();
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
    await settle();
  }

  it("is a named button on the camera itself", async () => {
    await mount();
    const hide = q("watch-camera-pip-hide");
    expect(hide).not.toBeNull();
    expect(hide!.tagName).toBe("BUTTON");
    expect(hide!.getAttribute("aria-label")).toBe("Hide camera");
    // Always visible on a touch screen, which has no hover to reveal it.
    expect(hide!.className).toContain("pointer-coarse:opacity-100");
    expect(hide!.className).toContain("pointer-coarse:pointer-events-auto");
  });

  it("hides the camera in one tap, leaves the chip, and never touches the film", async () => {
    await mount();
    const film = filmVideo();
    const filmAttaches = attached.filter((media) => media === film).length;
    expect(filmAttaches).toBe(1);

    await click(q("watch-camera-pip-hide")!);

    expect(q("watch-camera-pip")).toBeNull();
    expect(filmVideo()).toBe(film);
    expect(attached.filter((media) => media === film).length).toBe(filmAttaches);
    expect(JSON.parse(store.get("pqp:watch-camera-pip")!)).toEqual({
      corner: "bottom-right",
      layout: "stream",
      restore: "pip",
    });
    expect(q("watch-camera-layout")!.getAttribute("data-camera-layout")).toBe("stream");
    const chip = q("watch-camera-show-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Show camera");

    // A few seconds later the chip goes, and the menu is the way back.
    await act(async () => {
      vi.advanceTimersByTime(CAMERA_SHOW_CHIP_MS + 50);
    });
    await settle();
    expect(q("watch-camera-show-chip")).toBeNull();
    expect(q("watch-camera-layout")).not.toBeNull();
  });

  it("the chip brings the camera back in the layout it had", async () => {
    store.set("pqp:watch-camera-pip", JSON.stringify({ corner: "top-left", layout: "pip" }));
    await mount();
    await click(q("watch-camera-pip-hide")!);
    await click(q("watch-camera-show-chip")!);
    expect(q("watch-camera-pip")).not.toBeNull();
    expect(q("watch-camera-show-chip")).toBeNull();
    expect(JSON.parse(store.get("pqp:watch-camera-pip")!)).toMatchObject({
      corner: "top-left",
      layout: "pip",
    });
  });

  it("a player that opens on a camera hidden last time shows the chip, then lets it go", async () => {
    store.set(
      "pqp:watch-camera-pip",
      JSON.stringify({ corner: "bottom-right", layout: "stream", restore: "side" }),
    );
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer src={SRC} cameraSrc={CAMERA} layout="cinema" />
        </TooltipProvider>,
      );
    });
    await settle();
    expect(q("watch-camera-pip")).toBeNull();
    expect(q("watch-camera-show-chip")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(CAMERA_SHOW_CHIP_MS + 50);
    });
    await settle();
    expect(q("watch-camera-show-chip")).toBeNull();
  });

  it("no chip for a party with no camera, hidden or not", async () => {
    store.set("pqp:watch-camera-pip", JSON.stringify({ corner: "bottom-right", layout: "stream" }));
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer src={SRC} layout="cinema" />
        </TooltipProvider>,
      );
    });
    await settle();
    expect(q("watch-camera-show-chip")).toBeNull();
  });

  it("the quick cluster toggles it with no menu", async () => {
    await mount();
    const toggle = q("watch-quick-camera-toggle")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Hide camera");
    await click(toggle);
    expect(q("watch-camera-pip")).toBeNull();
    expect(q("watch-quick-camera-toggle")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("watch-quick-camera-toggle")!.getAttribute("aria-label")).toBe("Show camera");
    await click(q("watch-quick-camera-toggle")!);
    expect(q("watch-camera-pip")).not.toBeNull();
  });

  it("works in fullscreen", async () => {
    await mount({ fullscreen: true });
    await click(q("watch-camera-pip-hide")!);
    expect(q("watch-camera-pip")).toBeNull();
    expect(q("watch-camera-show-chip")).not.toBeNull();
  });

  it("stays reachable under a resting mouse: the chrome fades, the hovered camera's button does not", async () => {
    await mount();
    await act(async () => {
      vi.advanceTimersByTime(IDLE_CHROME_DELAY_MS + 500);
    });
    await settle();
    expect(q("watch-camera-pip-hide")!.className).toContain("opacity-0");
    await act(async () => {
      q("watch-camera-pip")!.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true }),
      );
    });
    await settle();
    expect(q("watch-camera-pip-hide")!.className).toContain("opacity-100");
    expect(q("watch-camera-pip-hide")!.className).not.toMatch(/(^| )opacity-0( |$)/);
  });
});
