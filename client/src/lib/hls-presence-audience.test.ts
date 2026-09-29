import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_HLS_PRESENCE_MAX_SPAN_MS } from "@pqp/shared";
import {
  createHlsVisibilityMeter,
  hlsDeviceClass,
  sendHlsPresence,
} from "./hls-playback";

describe("hlsDeviceClass", () => {
  it("judges by pointer and screen, three values and no finer", () => {
    expect(hlsDeviceClass({ coarsePointer: false, shortSidePx: 900 })).toBe("desktop");
    // A small window on a desktop is still a desktop: no touch, no phone.
    expect(hlsDeviceClass({ coarsePointer: false, shortSidePx: 320 })).toBe("desktop");
    expect(hlsDeviceClass({ coarsePointer: true, shortSidePx: 390 })).toBe("phone");
    expect(hlsDeviceClass({ coarsePointer: true, shortSidePx: 820 })).toBe("tablet");
  });

  it("falls back to desktop when the browser cannot say", () => {
    expect(hlsDeviceClass()).toBe("desktop");
  });
});

describe("createHlsVisibilityMeter", () => {
  function setup() {
    let now = 1_000_000;
    let hidden = false;
    const meter = createHlsVisibilityMeter({ isHidden: () => hidden, now: () => now });
    return {
      meter,
      advance(ms: number) {
        now += ms;
      },
      setHidden(value: boolean) {
        hidden = value;
        meter.change();
      },
    };
  }

  it("splits a beat between foreground and background at the moment it changed", () => {
    const { meter, advance, setHidden } = setup();
    advance(5_000);
    setHidden(true);
    advance(25_000);
    expect(meter.take()).toEqual({ visibleMs: 5_000, hiddenMs: 25_000 });
    // Nothing is owed twice.
    advance(30_000);
    setHidden(false);
    advance(10_000);
    expect(meter.take()).toEqual({ visibleMs: 10_000, hiddenMs: 30_000 });
  });

  it("does not count time spent paused, and resumes counting when it plays again", () => {
    let now = 1_000_000;
    let playing = true;
    const meter = createHlsVisibilityMeter({
      isHidden: () => false,
      isPlaying: () => playing,
      now: () => now,
    });
    now += 10_000;
    playing = false;
    meter.change();
    // Ten minutes paused: never owed to anybody.
    now += 600_000;
    playing = true;
    meter.change();
    now += 20_000;
    expect(meter.take()).toEqual({ visibleMs: 30_000, hiddenMs: 0 });
  });

  it("a tab hidden while paused counts as neither", () => {
    let now = 0;
    const playing = false;
    let hidden = false;
    const meter = createHlsVisibilityMeter({
      isHidden: () => hidden,
      isPlaying: () => playing,
      now: () => now,
    });
    now += 30_000;
    hidden = true;
    meter.change();
    now += 30_000;
    expect(meter.take()).toEqual({ visibleMs: 0, hiddenMs: 0 });
  });

  it("caps one beat at the most the server accepts", () => {
    const { meter, advance } = setup();
    advance(LIVE_HLS_PRESENCE_MAX_SPAN_MS * 3);
    expect(meter.take().visibleMs).toBe(LIVE_HLS_PRESENCE_MAX_SPAN_MS);
  });
});

describe("sendHlsPresence extras", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the coarse device and spans beside the token, and nothing else", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", fetchMock);
    sendHlsPresence("tok", "jwt", { device: "phone", visibleMs: 25_000, hiddenMs: 5_000 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      sessionToken: "tok",
      device: "phone",
      visibleMs: 25_000,
      hiddenMs: 5_000,
    });
  });
});
