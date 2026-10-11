// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityHomeMedia } from "@pqp/shared";

/**
 * The Baú player's subtitle wiring: when it asks for tracks, what it hands the
 * <video>, which track is live, whether it starts on, and the CC button. jsdom
 * has no media pipeline and no TextTrack, so the cue list is a stand-in with
 * the same shape a browser gives (`id`, `mode`, `activeCues`, `cuechange`).
 */

const fetchCaptions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchCommunityHomeCaptions: fetchCaptions }));

const { UnlockedMedia } = await import("./community-home-media");
const { resetCaptionsPreferenceForTests, COMMUNITY_HOME_CAPTIONS_PREF_KEY } = await import(
  "@/lib/community-home/captions"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const video: CommunityHomeMedia = {
  kind: "video",
  name: "lancamento.mp4",
  contentType: "video/mp4",
  byteSize: 1024,
  url: "https://bucket.example/lancamento.mp4?sig=1",
  youtubeUrl: null,
  twitchUrl: null,
};

const SERVER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const POST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

class FakeTrack extends EventTarget {
  mode: TextTrackMode = "disabled";
  activeCues: Array<{ text: string }> | null = null;
  constructor(readonly id: string) {
    super();
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let blobs = 0;

beforeEach(() => {
  fetchCaptions.mockReset();
  fetchCaptions.mockResolvedValue({
    tracks: [
      { lang: "pt", source: true, auto: true, vtt: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nfrase\n" },
      { lang: "en", source: false, auto: true, vtt: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n[en] frase\n" },
    ],
  });
  blobs = 0;
  URL.createObjectURL = vi.fn(() => `blob:track-${++blobs}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.localStorage.clear();
  resetCaptionsPreferenceForTests();
});

async function mount(sourceLang: string | null, media: CommunityHomeMedia = video, durationMs: number | null = 65_000) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <UnlockedMedia
        media={media}
        flush
        captions={sourceLang ? { serverId: SERVER, postId: POST, sourceLang, durationMs } : null}
      />,
    );
  });
  return host;
}

async function loadDuration(el: HTMLElement, seconds: number) {
  const v = el.querySelector("video")!;
  Object.defineProperty(v, "duration", { value: seconds, configurable: true });
  await act(async () => {
    v.dispatchEvent(new Event("loadedmetadata"));
  });
}

/** Give the <video> a text track list the way a browser builds one from its <track> children. */
function fakeTextTracks(el: HTMLVideoElement) {
  const tracks = [new FakeTrack("cc-source"), new FakeTrack("cc-en")];
  const list = Object.assign(tracks, {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.defineProperty(el, "textTracks", { value: list, configurable: true });
  return tracks;
}

async function approach(el: HTMLElement) {
  const wrap = el.querySelector("[data-home-video]")!;
  await act(async () => {
    wrap.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    wrap.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  });
  await act(async () => {});
}

describe("Baú video subtitles", () => {
  it("a video without subtitles has no CC button and asks for nothing", async () => {
    const el = await mount(null);
    expect(el.querySelector("[data-home-video-cc]")).toBeNull();
    await approach(el);
    expect(fetchCaptions).not.toHaveBeenCalled();
    expect(el.querySelector("track")?.getAttribute("kind")).toBe("captions");
  });

  it("does not fetch for every video in the feed: only once the reader comes near it", async () => {
    const el = await mount("pt");
    expect(fetchCaptions).not.toHaveBeenCalled();
    await approach(el);
    expect(fetchCaptions).toHaveBeenCalledWith(SERVER, POST, "en");
  });

  it("hands the <video> one <track kind=subtitles> per language, through blob: URLs", async () => {
    const el = await mount("pt");
    await approach(el);
    const tracks = [...el.querySelectorAll("track")];
    expect(tracks.map((t) => [t.kind, t.srclang, t.getAttribute("src"), t.label])).toEqual([
      ["subtitles", "pt", "blob:track-1", "Portuguese (automatic)"],
      ["subtitles", "en", "blob:track-2", "English (automatic)"],
    ]);
  });

  it("a Portuguese video read in English starts with English subtitles on and draws the cue", async () => {
    const el = await mount("pt");
    const video = el.querySelector("video")!;
    const [source, english] = fakeTextTracks(video);
    expect(el.querySelector("[data-home-video-cc]")?.getAttribute("data-home-video-cc")).toBe("on");
    expect(el.querySelector("[data-home-video-cc]")?.getAttribute("aria-pressed")).toBe("true");
    await approach(el);
    expect(english!.mode).toBe("hidden");
    expect(source!.mode).toBe("disabled");

    english!.activeCues = [{ text: "[en] frase" }];
    await act(async () => {
      english!.dispatchEvent(new Event("cuechange"));
    });
    expect(el.querySelector("[data-home-video-cue]")?.textContent).toBe("[en] frase");

    // CC off: the track is disabled and the words go away.
    await act(async () => {
      (el.querySelector("[data-home-video-cc]") as HTMLButtonElement).click();
    });
    expect(english!.mode).toBe("disabled");
    expect(el.querySelector("[data-home-video-cue]")).toBeNull();
    expect(window.localStorage.getItem(COMMUNITY_HOME_CAPTIONS_PREF_KEY)).toBe("off");
  });

  it("a video in the reader's own language starts with subtitles off, and CC turns them on", async () => {
    const el = await mount("en");
    const button = el.querySelector("[data-home-video-cc]") as HTMLButtonElement;
    expect(button.getAttribute("data-home-video-cc")).toBe("off");
    expect(button.getAttribute("aria-label")).toBe("Turn on subtitles");
    await act(async () => button.click());
    await act(async () => {});
    expect(fetchCaptions).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("data-home-video-cc")).toBe("on");
    expect(window.localStorage.getItem(COMMUNITY_HOME_CAPTIONS_PREF_KEY)).toBe("on");
  });

  it("a failed fetch leaves the player as it always was, and the next approach asks again", async () => {
    fetchCaptions.mockRejectedValueOnce(new Error("offline"));
    const el = await mount("pt");
    await approach(el);
    expect(el.querySelector("track")?.getAttribute("kind")).toBe("captions");
    expect(el.querySelector("[data-home-video-play]")).not.toBeNull();
    await approach(el);
    expect(fetchCaptions).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll("track[kind=subtitles]")).toHaveLength(2);
  });

  describe("on the phone cut", () => {
    const withCut: CommunityHomeMedia = {
      ...video,
      mobile: {
        name: "lancamento-9x16.mp4",
        contentType: "video/mp4",
        byteSize: 512,
        url: "https://bucket.example/lancamento-9x16.mp4?sig=1",
      },
    };
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
      window.matchMedia = ((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      vi.restoreAllMocks();
    });

    it("shows the subtitles when its length matches the transcribed video", async () => {
      const el = await mount("pt", withCut);
      expect(el.querySelector("[data-home-video-rendition]")?.getAttribute("data-home-video-rendition")).toBe("mobile");
      // Unknown until the file says how long it is.
      expect(el.querySelector("[data-home-video-cc]")).toBeNull();
      await loadDuration(el, 65.4);
      expect(el.querySelector("[data-home-video-cc]")?.getAttribute("data-home-video-cc")).toBe("on");
    });

    it("hides them when the cut was edited to another length", async () => {
      const el = await mount("pt", withCut);
      await loadDuration(el, 48);
      expect(el.querySelector("[data-home-video-cc]")).toBeNull();
      await approach(el);
      expect(fetchCaptions).not.toHaveBeenCalled();
    });
  });

  it("revokes its blob: URLs when the player goes away", async () => {
    const el = await mount("pt");
    await approach(el);
    await act(async () => root?.unmount());
    root = null;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-2");
    void el;
  });
});
