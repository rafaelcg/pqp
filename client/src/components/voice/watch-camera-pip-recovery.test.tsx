// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchCameraPip } from "./watch-camera-pip";
import {
  CAMERA_REBUILD_BACKOFF_MS,
  CAMERA_STALL_MS,
  CAMERA_STALL_POLL_MS,
} from "@/lib/camera-stall";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE FROZEN FACE (rehearsal D, 2026-09-25, 13:48:22Z). The presenter's
 * camera froze at t=18.07 with `paused: false` and stayed there for the rest
 * of the show while its playlist kept advancing on the server. hls.js never
 * raised a fatal error, so the component never looked again. This drives the
 * real component with a fake hls.js and a `<video>` whose clock the test owns,
 * and pins the recovery: a nudge to the live edge, then rebuilds of the
 * camera's own instance on a backoff, and nothing at all while the page is
 * hidden or the element is waiting for a tap.
 */

let constructed = 0;
const calls: string[] = [];
const destroyed: number[] = [];
const loaded: string[] = [];

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    readonly id: number;
    private listeners = new Map<string, Array<() => void>>();
    constructor() {
      constructed += 1;
      this.id = constructed;
    }
    on(event: string, cb: () => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    loadSource(url: string) {
      loaded.push(url);
    }
    attachMedia() {
      queueMicrotask(() => {
        for (const cb of this.listeners.get("hlsManifestParsed") ?? []) {
          cb();
        }
      });
    }
    startLoad(position?: number) {
      calls.push(`startLoad(${position}) on #${this.id}`);
    }
    get liveSyncPosition() {
      return 60;
    }
    destroy() {
      destroyed.push(this.id);
    }
  }
  return { default: FakeHls };
});

const CAM_SRC =
  "https://hls.pqp.gg/api/voice/hls-playlist/ad99074f-a4d3-4919-a782-122b7150ed87/1790343652945/cam360p30?t=tok";

describe("WatchCameraPip: a frozen camera recovers", { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;
  let originalPlay: typeof HTMLMediaElement.prototype.play;
  let playMock: ReturnType<typeof vi.fn>;
  let visibility: DocumentVisibilityState;
  /** The element's clock, owned by the test. */
  let clock: number;
  let paused: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    constructed = 0;
    calls.length = 0;
    destroyed.length = 0;
    loaded.length = 0;
    clock = 0;
    paused = false;
    visibility = "visible";
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    originalPlay = HTMLMediaElement.prototype.play;
    playMock = vi.fn(async () => {});
    HTMLMediaElement.prototype.play =
      playMock as unknown as typeof HTMLMediaElement.prototype.play;
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

  async function mount(props: { hasVoiceAudio?: boolean } = {}) {
    await act(async () => {
      root.render(
        <WatchCameraPip
          src={CAM_SRC}
          hasVoiceAudio={props.hasVoiceAudio}
          className="h-full w-full"
          onFrame={() => {}}
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
    Object.defineProperty(el, "paused", {
      configurable: true,
      get: () => paused,
    });
    for (let i = 0; i < 100 && constructed === 0; i += 1) {
      await settle();
    }
    expect(constructed).toBe(1);
    await act(async () => {
      el.dispatchEvent(new Event("playing"));
    });
  }

  /** Advance `ms` in poll steps; `advance` moves the element's clock too. */
  async function run(ms: number, advance = false) {
    for (let i = 0; i < ms / CAMERA_STALL_POLL_MS; i += 1) {
      if (advance) {
        clock += CAMERA_STALL_POLL_MS / 1000;
      }
      await act(async () => {
        vi.advanceTimersByTime(CAMERA_STALL_POLL_MS);
      });
      await settle();
    }
  }

  /** Poll until the `n`th hls.js exists; returns the milliseconds it took. */
  async function runUntilConstructed(n: number): Promise<number> {
    let elapsed = 0;
    while (constructed < n && elapsed < 10 * 60_000) {
      await run(CAMERA_STALL_POLL_MS);
      elapsed += CAMERA_STALL_POLL_MS;
    }
    expect(constructed).toBe(n);
    return elapsed;
  }

  it("leaves a playing camera alone", async () => {
    await mount();
    await run(120_000, true);
    expect(calls).toEqual([]);
    expect(constructed).toBe(1);
  });

  it("nudges to the live edge first, then rebuilds its own hls.js, with backoff", async () => {
    await mount();
    await run(10_000, true);
    clock = 18.07;
    await run(CAMERA_STALL_MS + CAMERA_STALL_POLL_MS * 2);
    // Step one: restart loading at the live edge and jump over the hole.
    expect(calls).toEqual(["startLoad(-1) on #1"]);
    expect(clock).toBe(60);
    expect(constructed).toBe(1);

    // Still frozen at the edge it jumped to: a rebuild, on the freshest URL,
    // backoff[0] after the nudge (Math.random 0.5 is zero jitter).
    const toNudgeRebuild = await runUntilConstructed(2);
    expect(toNudgeRebuild).toBeGreaterThanOrEqual(CAMERA_REBUILD_BACKOFF_MS[0]!);
    expect(toNudgeRebuild).toBeLessThanOrEqual(
      CAMERA_REBUILD_BACKOFF_MS[0]! + CAMERA_STALL_POLL_MS,
    );
    expect(destroyed).toEqual([1]);
    expect(loaded.at(-1)).toBe(CAM_SRC);

    // Still frozen: each next rebuild waits out the next step, never a tick.
    const second = await runUntilConstructed(3);
    expect(second).toBeGreaterThanOrEqual(CAMERA_REBUILD_BACKOFF_MS[1]!);
    const third = await runUntilConstructed(4);
    expect(third).toBeGreaterThanOrEqual(CAMERA_REBUILD_BACKOFF_MS[2]!);
    // The rebuilds never start the nudge over, and never touch loading
    // anywhere else.
    expect(calls).toEqual(["startLoad(-1) on #1"]);
    expect(
      warn.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes("rebuilding its player"),
      ),
    ).toHaveLength(3);
  });

  it("does nothing while the page is hidden", async () => {
    await mount();
    await run(4_000, true);
    visibility = "hidden";
    await run(5 * 60_000);
    expect(calls).toEqual([]);
    expect(constructed).toBe(1);
  });

  it("does nothing while unmuted autoplay waits for a tap, and keeps the voice audible after a rebuild", async () => {
    playMock.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    await act(async () => {
      root.render(
        <WatchCameraPip
          src={CAM_SRC}
          hasVoiceAudio
          hasVideo={false}
          className="h-full w-full"
          onFrame={() => {}}
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
    paused = true;
    Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
    for (let i = 0; i < 100 && constructed === 0; i += 1) {
      await settle();
    }
    await settle();
    expect(
      container.querySelector('[data-testid="watch-camera-pip-tap-to-hear"]'),
    ).not.toBeNull();
    await run(3 * 60_000);
    expect(calls).toEqual([]);
    expect(constructed).toBe(1);

    // The tap: playing, then the voice freezes. It recovers like the picture.
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="watch-camera-pip-tap-to-hear"]',
    )!;
    await act(async () => {
      button.click();
    });
    paused = false;
    await act(async () => {
      el.dispatchEvent(new Event("playing"));
    });
    await run(4_000, true);
    await run(CAMERA_STALL_MS + CAMERA_REBUILD_BACKOFF_MS[0]! + CAMERA_STALL_POLL_MS * 4);
    expect(constructed).toBe(2);
    expect(el.muted).toBe(false);
  });

  it("stops watching once the camera is unmounted (hidden, or no longer announced)", async () => {
    await mount();
    await run(4_000, true);
    act(() => root.unmount());
    root = createRoot(container);
    await run(5 * 60_000);
    expect(calls).toEqual([]);
    expect(constructed).toBe(1);
  });
});
