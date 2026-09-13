import { describe, expect, it } from "vitest";
import {
  blocksGoLive,
  desktopSharesTabAudio,
  goLiveChecklist,
  isFirefoxUserAgent,
  type GoLiveChecklistInput,
} from "./watch-party-go-live-checklist";

const BASE: GoLiveChecklistInput = {
  isFirefox: false,
  isDesktopShell: false,
  desktopSharesTabAudio: false,
  hasAudioTrack: null,
  quality: "720p",
  cameraOn: false,
};

describe("goLiveChecklist", () => {
  it("is all-clear on Chrome with nothing picked yet, 720p, no camera", () => {
    const items = goLiveChecklist(BASE);
    expect(items.map((item) => item.id)).toEqual(["browser", "quality", "camera"]);
    expect(items.every((item) => item.tone === "ok")).toBe(true);
    expect(blocksGoLive(items)).toBe(false);
  });

  it("blocks on Firefox, and only Firefox blocks", () => {
    const items = goLiveChecklist({ ...BASE, isFirefox: true });
    expect(items.find((item) => item.id === "browser")?.tone).toBe("block");
    expect(blocksGoLive(items)).toBe(true);
  });

  it("hints, rather than blocks, on a desktop shell too old to promise tab audio", () => {
    const items = goLiveChecklist({
      ...BASE,
      isDesktopShell: true,
      desktopSharesTabAudio: false,
    });
    expect(items.find((item) => item.id === "browser")?.tone).toBe("hint");
    expect(blocksGoLive(items)).toBe(false);
  });

  it("is ok on a desktop shell whose capability object covers both halves", () => {
    const items = goLiveChecklist({
      ...BASE,
      isDesktopShell: true,
      desktopSharesTabAudio: true,
    });
    expect(items.find((item) => item.id === "browser")?.tone).toBe("ok");
  });

  it("says nothing about tab audio until a capture is picked", () => {
    const items = goLiveChecklist({ ...BASE, hasAudioTrack: null });
    expect(items.find((item) => item.id === "tabAudio")).toBeUndefined();
  });

  it("hints once a capture with no audio track is picked", () => {
    const items = goLiveChecklist({ ...BASE, hasAudioTrack: false });
    expect(items.find((item) => item.id === "tabAudio")?.tone).toBe("hint");
    expect(blocksGoLive(items)).toBe(false);
  });

  it("is ok once the picked capture carries audio", () => {
    const items = goLiveChecklist({ ...BASE, hasAudioTrack: true });
    expect(items.find((item) => item.id === "tabAudio")?.tone).toBe("ok");
  });

  it("hints on the 1080p opt-in", () => {
    const items = goLiveChecklist({ ...BASE, quality: "1080p" });
    expect(items.find((item) => item.id === "quality")?.tone).toBe("hint");
  });

  it("hints when the camera is on", () => {
    const items = goLiveChecklist({ ...BASE, cameraOn: true });
    expect(items.find((item) => item.id === "camera")?.tone).toBe("hint");
  });

  it("stacks every hint at once without ever blocking", () => {
    const items = goLiveChecklist({
      ...BASE,
      hasAudioTrack: false,
      quality: "1080p",
      cameraOn: true,
    });
    expect(items.every((item) => item.tone !== "block")).toBe(true);
    expect(blocksGoLive(items)).toBe(false);
  });
});

describe("isFirefoxUserAgent", () => {
  it("recognises desktop and mobile Firefox", () => {
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe(true);
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
      ),
    ).toBe(true);
  });

  it("does not mistake Chrome, Safari or SeaMonkey for Firefox", () => {
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe(false);
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; rv:2.53) Gecko/20100101 SeaMonkey/2.53 Firefox/102.0",
      ),
    ).toBe(false);
  });

  it("does not crash, and answers false, on an empty string", () => {
    expect(isFirefoxUserAgent("")).toBe(false);
  });
});

describe("desktopSharesTabAudio", () => {
  it("is false with nothing, an old shell, or a partial capability object", () => {
    expect(desktopSharesTabAudio(undefined)).toBe(false);
    expect(desktopSharesTabAudio(null)).toBe(false);
    expect(desktopSharesTabAudio({})).toBe(false);
    expect(desktopSharesTabAudio({ canShareScreen: true })).toBe(false);
    expect(desktopSharesTabAudio({ sharePickerOffersAudio: true })).toBe(
      false,
    );
  });

  it("is true only once both flags are set", () => {
    expect(
      desktopSharesTabAudio({
        canShareScreen: true,
        sharePickerOffersAudio: true,
      }),
    ).toBe(true);
  });
});
