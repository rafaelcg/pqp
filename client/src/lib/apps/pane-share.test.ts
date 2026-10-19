import { afterEach, describe, expect, it, vi } from "vitest";
import { openPaneCapture, supportsRegionCapture } from "./pane-share";

function fakeStream(track: Record<string, unknown>): MediaStream {
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsRegionCapture", () => {
  it("is false without CropTarget (Safari, Firefox)", () => {
    vi.stubGlobal("MediaStreamTrack", class {});
    expect(supportsRegionCapture()).toBe(false);
  });

  it("is true with CropTarget and cropTo (Chromium)", () => {
    class Track {
      cropTo() {}
    }
    vi.stubGlobal("MediaStreamTrack", Track);
    vi.stubGlobal("CropTarget", { fromElement: async () => ({}) });
    expect(supportsRegionCapture()).toBe(true);
  });
});

describe("openPaneCapture", () => {
  const element = {} as HTMLElement;

  it("asks for the current tab with no audio and crops the track to the pane", async () => {
    const target = { crop: "target" };
    const fromElement = vi.fn(async () => target);
    vi.stubGlobal("CropTarget", { fromElement });
    const cropTo = vi.fn(async () => {});
    const ask = vi.fn(async (_options: DisplayMediaStreamOptions) => fakeStream({ cropTo }));

    const capture = await openPaneCapture(element, { getDisplayMedia: ask, maxFrameRate: 24 });

    expect(capture.cropped).toBe(true);
    expect(fromElement).toHaveBeenCalledWith(element);
    expect(cropTo).toHaveBeenCalledWith(target);
    const asked = ask.mock.calls[0]![0] as Record<string, unknown>;
    expect(asked.audio).toBe(false);
    expect(asked.preferCurrentTab).toBe(true);
    expect(asked.surfaceSwitching).toBe("exclude");
    expect(asked.video).toEqual({ frameRate: { ideal: 24 } });
  });

  it("shares what the person chose when the crop cannot apply (another tab, a screen)", async () => {
    vi.stubGlobal("CropTarget", { fromElement: async () => ({}) });
    const cropTo = vi.fn(async () => {
      throw new DOMException("not this tab", "InvalidStateError");
    });
    const stream = fakeStream({ cropTo });
    const capture = await openPaneCapture(element, { getDisplayMedia: async () => stream });
    expect(capture).toEqual({ stream, cropped: false });
  });

  it("returns the stream untouched where there is no CropTarget", async () => {
    vi.stubGlobal("CropTarget", undefined);
    const stream = fakeStream({});
    const capture = await openPaneCapture(element, { getDisplayMedia: async () => stream });
    expect(capture).toEqual({ stream, cropped: false });
  });

  it("lets the picker's refusal through, so the caller can treat it as a no", async () => {
    const refusal = new DOMException("denied", "NotAllowedError");
    await expect(
      openPaneCapture(element, {
        getDisplayMedia: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
  });
});
