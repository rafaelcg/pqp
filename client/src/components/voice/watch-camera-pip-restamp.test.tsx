// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchCameraPip } from "./watch-camera-pip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE THIRTY-SECOND REATTACH (rehearsal E, 2026-09-25, after the presenter
 * reloaded at 16:02:24Z). The server restamps `cameraHlsUrl`'s `?t=` on every
 * audience keyframe. The camera applied each restamp with `loadSource`, which
 * on an attached hls.js 1.7 is `detachMedia()` + `attachMedia()`: a new blob
 * every 30 s on the wall clock, and a re-attached player that played its
 * twenty-second window (597 frames) and froze until the next one. A restamp
 * must never reach the player: the loader swaps the token into the requests
 * it makes, and the instance, its MediaSource and its buffer are left alone.
 */

let supported = true;
let constructed = 0;
const destroyed: number[] = [];
/** Every `loadSource`, tagged with the instance and whether it was attached. */
const loads: Array<{ id: number; url: string; attached: boolean }> = [];
let lastConfig: { xhrSetup?: (xhr: XMLHttpRequest, url: string) => void } | null =
  null;
/** Fire an hls.js ERROR on the newest instance. */
let emitError: ((data: { details: string; fatal: boolean }) => void) | null = null;

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() {
      return supported;
    }
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static ErrorDetails = { LEVEL_PARSING_ERROR: "levelParsingError" };
    readonly id: number;
    private attached = false;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(config: typeof lastConfig) {
      constructed += 1;
      this.id = constructed;
      lastConfig = config;
      emitError = (data) => {
        for (const cb of this.listeners.get("hlsError") ?? []) {
          cb("hlsError", data);
        }
      };
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    loadSource(url: string) {
      loads.push({ id: this.id, url, attached: this.attached });
    }
    attachMedia() {
      this.attached = true;
      queueMicrotask(() => {
        for (const cb of this.listeners.get("hlsManifestParsed") ?? []) {
          cb();
        }
      });
    }
    startLoad() {}
    destroy() {
      destroyed.push(this.id);
    }
  }
  return { default: FakeHls };
});

const SESSION =
  "https://hls.pqp.gg/api/voice/hls-playlist/ad99074f-a4d3-4919-a782-122b7150ed87/1790351729293/cam360p30";

/** A token shaped like `mintHlsViewerToken`'s, expiring at `e`. */
function token(e: number, n: number): string {
  const claims = btoa(JSON.stringify({ v: 1, u: "viewer", c: "ch", s: 1, e, i: n }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${claims}.sig${n}`;
}

function stamped(n: number, e = Date.now() + 60 * 60 * 1000): string {
  return `${SESSION}?t=${token(e, n)}&pp=pass`;
}

describe("WatchCameraPip: a restamped token", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlay: typeof HTMLMediaElement.prototype.play;
  let originalCanPlay: typeof HTMLMediaElement.prototype.canPlayType;

  beforeEach(() => {
    supported = true;
    constructed = 0;
    destroyed.length = 0;
    loads.length = 0;
    lastConfig = null;
    originalPlay = HTMLMediaElement.prototype.play;
    originalCanPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.play = vi.fn(
      async () => {},
    ) as unknown as typeof HTMLMediaElement.prototype.play;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLMediaElement.prototype.play = originalPlay;
    HTMLMediaElement.prototype.canPlayType = originalCanPlay;
    vi.restoreAllMocks();
  });

  async function settle() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function render(src: string) {
    await act(async () => {
      root.render(
        <WatchCameraPip src={src} className="h-full w-full" onFrame={() => {}} />,
      );
    });
    await settle();
  }

  /** What the loader would actually request for `url` right now. */
  function requested(url: string): string {
    let opened = url;
    const xhr = {
      open: (_method: string, next: string) => {
        opened = next;
      },
      setRequestHeader: () => {},
    } as unknown as XMLHttpRequest;
    lastConfig!.xhrSetup!(xhr, url);
    return opened;
  }

  it("never reloads, re-attaches or rebuilds hls.js, and the loader carries the fresh token", async () => {
    const urls = [0, 1, 2, 3, 4, 5].map((n) => stamped(n));
    await render(urls[0]!);
    expect(constructed).toBe(1);
    expect(loads).toEqual([{ id: 1, url: urls[0], attached: false }]);

    // Five audience keyframes: two and a half minutes of a live party.
    for (const url of urls.slice(1)) {
      await render(url);
    }

    // The player is the one it was: no `loadSource` on the attached
    // instance (that is `detachMedia` + `attachMedia` in hls.js), no second
    // instance, nothing destroyed.
    expect(loads).toEqual([{ id: 1, url: urls[0], attached: false }]);
    expect(constructed).toBe(1);
    expect(destroyed).toEqual([]);
    expect(container.querySelector("video")!.getAttribute("src")).toBeNull();

    // hls.js keeps polling the URL it attached with; the request goes out on
    // the newest token, the party pass and everything else kept.
    const out = new URL(requested(urls[0]!));
    expect(`${out.origin}${out.pathname}`).toBe(SESSION);
    expect(out.searchParams.get("t")).toBe(new URL(urls[5]!).searchParams.get("t"));
    expect(out.searchParams.get("pp")).toBe("pass");
    // A segment line (presigned bucket or edge segment URL) is left alone.
    const segment = "https://hls.pqp.gg/api/voice/hls-segment/ch/1/seg_00001.ts?sig=x";
    expect(requested(segment)).toBe(segment);
  });

  it("still re-attaches once for a genuinely new camera session", async () => {
    await render(stamped(0));
    const next = stamped(1).replace("/1790351729293/", "/1790351799999/");
    await render(next);
    expect(constructed).toBe(2);
    expect(destroyed).toEqual([1]);
    expect(loads.at(-1)).toEqual({ id: 2, url: next, attached: false });
  });

  it("rebuilds at once when a new camera run collides with the sequence it holds, and not in a loop", async () => {
    await render(stamped(0));
    expect(constructed).toBe(1);
    // The presenter republished the camera: the shared live playlist now
    // lists the new run's segment 3 where this instance holds the old run's.
    await act(async () => {
      emitError!({ details: "levelParsingError", fatal: true });
    });
    await settle();
    expect(constructed).toBe(2);
    expect(destroyed).toEqual([1]);
    // The same failure again straight away is the stall watch's to handle.
    await act(async () => {
      emitError!({ details: "levelParsingError", fatal: true });
    });
    await settle();
    expect(constructed).toBe(2);
    // Any other fatal error is not a new run: no immediate rebuild.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await act(async () => {
      emitError!({ details: "manifestLoadError", fatal: true });
    });
    await settle();
    expect(constructed).toBe(2);
  });

  it("native playback keeps its element on the attached URL until that token nears expiry", async () => {
    supported = false;
    HTMLMediaElement.prototype.canPlayType = (() =>
      "maybe") as typeof HTMLMediaElement.prototype.canPlayType;
    const hour = 60 * 60 * 1000;
    const first = stamped(0, Date.now() + hour);
    await render(first);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(first);

    // Restamps with an hour left on the attached token: the element keeps
    // playing what it has (a new `src` is the element's whole load).
    await render(stamped(1, Date.now() + hour));
    await render(stamped(2, Date.now() + hour));
    expect(video.getAttribute("src")).toBe(first);

    // The attached token is now within the refresh margin: take the fresh one.
    const nearExpiry = stamped(3, Date.now() + hour);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50 * 60 * 1000);
    await render(nearExpiry);
    expect(video.getAttribute("src")).toBe(nearExpiry);
  });
});
