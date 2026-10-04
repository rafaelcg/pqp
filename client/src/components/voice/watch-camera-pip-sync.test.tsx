// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchCameraPip, type FilmClockReading } from "./watch-camera-pip";
import { CAMERA_SYNC_TICK_MS } from "@/lib/camera-sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE CAMERA HELD TO THE FILM, WIRED (2026-10-03). `lib/camera-sync.ts` pins
 * the policy; this drives the real `WatchCameraPip` with a fake hls.js whose
 * `playingDate` and playlist the test owns, and a film clock it hands in, and
 * checks what the component does to the CAMERA's element: a seek of exactly
 * the drift, a rate within 5 %, and with the flag off nothing at all, the
 * film clock not even read.
 */

const FILM_WALL = 1_790_000_000_000;
let constructed = 0;
/** The camera's wall clock at `currentTime` 0: what PDT maps 0 to. */
let cameraWallAtZero = FILM_WALL - 13_000;
/** The film's wall clock now; the camera's playlist edge moves with it. */
let filmNow = FILM_WALL;
const instances: { playingDate: Date | null }[] = [];

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static ErrorDetails = { LEVEL_PARSING_ERROR: "levelParsingError" };
    media: HTMLVideoElement | null = null;
    private listeners = new Map<string, Array<() => void>>();
    constructor() {
      constructed += 1;
      instances.push(this);
    }
    on(event: string, cb: () => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    loadSource() {}
    attachMedia(media: HTMLVideoElement) {
      this.media = media;
      queueMicrotask(() => {
        for (const cb of this.listeners.get("hlsManifestParsed") ?? []) {
          cb();
        }
      });
    }
    startLoad() {}
    get liveSyncPosition() {
      return 0;
    }
    /** hls.js's own reading: the PDT under the playhead. */
    get playingDate() {
      return this.media ? new Date(cameraWallAtZero + this.media.currentTime * 1000) : null;
    }
    /** One rendition whose newest fragment ends 20 s after the film's frame. */
    get levels() {
      return [
        {
          details: {
            fragments: [{ programDateTime: filmNow + 16_000, duration: 4 }],
          },
        },
      ];
    }
    destroy() {}
  }
  return { default: FakeHls };
});

const CAM_SRC =
  "https://hls.pqp.gg/api/voice/hls-playlist/ad99074f-a4d3-4919-a782-122b7150ed87/1790343652945/cam360p30?t=tok";

describe("WatchCameraPip: the camera follows the film", { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlay: typeof HTMLMediaElement.prototype.play;
  let clock: number;
  let visibility: DocumentVisibilityState;
  let filmReads: number;
  let film: FilmClockReading;
  const filmClock = () => {
    filmReads += 1;
    return film;
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    constructed = 0;
    instances.length = 0;
    cameraWallAtZero = FILM_WALL - 13_000;
    filmNow = FILM_WALL;
    clock = 0;
    filmReads = 0;
    film = { wallMs: FILM_WALL, playing: true, rate: 1 };
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  function video(): HTMLVideoElement {
    return container.querySelector("video")!;
  }

  async function mount(sync: boolean) {
    await act(async () => {
      root.render(
        <WatchCameraPip
          src={CAM_SRC}
          className="h-full w-full"
          onFrame={() => {}}
          sync={sync}
          filmClock={filmClock}
        />,
      );
    });
    const el = video();
    Object.defineProperty(el, "currentTime", {
      configurable: true,
      get: () => clock,
      set: (v: number) => {
        clock = v;
      },
    });
    Object.defineProperty(el, "paused", { configurable: true, get: () => false });
    Object.defineProperty(el, "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(el, "seeking", { configurable: true, get: () => false });
    for (let i = 0; i < 100 && constructed === 0; i += 1) {
      await settle();
    }
    expect(constructed).toBe(1);
  }

  /** One controller tick, with both pictures advancing `seconds` meanwhile. */
  async function tick(seconds = CAMERA_SYNC_TICK_MS / 1000) {
    clock += seconds * video().playbackRate;
    film = { ...film, wallMs: film.wallMs! + seconds * 1000 * film.rate };
    filmNow = film.wallMs!;
    await act(async () => {
      vi.advanceTimersByTime(CAMERA_SYNC_TICK_MS);
    });
    await settle();
  }

  function driftMs(): number {
    return cameraWallAtZero + clock * 1000 - film.wallMs!;
  }

  it("seeks a camera 13 s behind onto the film at its first frame", async () => {
    await mount(true);
    expect(driftMs()).toBeCloseTo(-13_000, 0);
    await act(async () => {
      video().dispatchEvent(new Event("playing"));
    });
    // The 'playing' event itself ran a tick: no waiting a second for it.
    expect(Math.abs(driftMs())).toBeLessThan(5);
    for (let i = 0; i < 10; i += 1) {
      await tick();
    }
    expect(Math.abs(driftMs())).toBeLessThan(100);
    expect(video().playbackRate).toBeGreaterThanOrEqual(0.95);
    expect(video().playbackRate).toBeLessThanOrEqual(1.05);
    expect(container.querySelector("[data-camera-sync]")).not.toBeNull();
  });

  it("nudges a small drift with the rate, never more than 5 %", async () => {
    cameraWallAtZero = FILM_WALL - 600;
    await mount(true);
    await tick();
    expect(video().playbackRate).toBeGreaterThan(1);
    expect(video().playbackRate).toBeLessThanOrEqual(1.05);
    for (let i = 0; i < 40; i += 1) {
      await tick();
      expect(video().playbackRate).toBeGreaterThanOrEqual(0.95);
      expect(video().playbackRate).toBeLessThanOrEqual(1.05);
    }
    expect(Math.abs(driftMs())).toBeLessThan(100);
  });

  it("leaves a hidden page alone", async () => {
    await mount(true);
    visibility = "hidden";
    await tick();
    await tick();
    expect(driftMs()).toBeLessThan(-12_000);
    visibility = "visible";
    await tick();
    expect(Math.abs(driftMs())).toBeLessThan(5);
  });

  it("does nothing while the film is not playing", async () => {
    await mount(true);
    film = { ...film, playing: false };
    await tick();
    await tick();
    expect(driftMs()).toBeLessThan(-12_000);
    expect(video().playbackRate).toBe(1);
  });

  it("with the flag off, touches nothing and never reads the film", async () => {
    await mount(false);
    await act(async () => {
      video().dispatchEvent(new Event("playing"));
    });
    for (let i = 0; i < 5; i += 1) {
      await tick();
    }
    expect(driftMs()).toBeCloseTo(-13_000, -1);
    expect(video().playbackRate).toBe(1);
    expect(filmReads).toBe(0);
    expect(container.querySelector("[data-camera-sync]")).toBeNull();
    expect((window as { pqpCameraSync?: unknown }).pqpCameraSync).toBeUndefined();
  });

  it("answers pqpCameraSync() in the console while it runs, and hands the rate back when it stops", async () => {
    cameraWallAtZero = FILM_WALL - 600;
    await mount(true);
    await tick();
    const readout = (window as { pqpCameraSync?: () => { driftMs: number; reason: string } }).pqpCameraSync;
    expect(readout).toBeTypeOf("function");
    expect(readout!().reason).toBe("nudge");
    expect(video().playbackRate).not.toBe(1);
    const el = video();
    // The flag turned off under a running party.
    await act(async () => {
      root.render(
        <WatchCameraPip
          src={CAM_SRC}
          className="h-full w-full"
          onFrame={() => {}}
          sync={false}
          filmClock={filmClock}
        />,
      );
    });
    expect(el.playbackRate).toBe(1);
    expect((window as { pqpCameraSync?: unknown }).pqpCameraSync).toBeUndefined();
  });
});
