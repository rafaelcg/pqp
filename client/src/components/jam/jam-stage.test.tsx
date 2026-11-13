// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamInstrument } from "@pqp/shared";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { track } from "@/lib/jam-test-fixtures";
import { JamStage } from "./jam-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fresh tree: the stage measures its width once on mount, so a test about another width starts over. */
function remount() {
  act(() => root.unmount());
  root = createRoot(host);
}

const IDLE: JamLaneMix = { muted: false, solo: false, volume: 1 };

/** `videoEvery`: every Nth recording has a video (1 is all of them, 0 none). */
function recordings(count: number, videoEvery = 1) {
  return Array.from({ length: count }, (_, index) =>
    track({
      id: `id-${index}`,
      authorId: `author-${index}`,
      authorName: `Pessoa ${index}`,
      instrument: (["guitar", "bass", "drums", "keys", "vocals", "other"] as const)[index % 6]!,
      videoUrl: videoEvery > 0 && index % videoEvery === 0 ? `https://example.test/v${index}.webm` : null,
      peaks: [0.1, 0.8, 0.4, 0.9, 0.2],
      durationMs: 5000,
    }),
  );
}

/** A clock the test drives by hand. */
function fakeClock() {
  const listeners = new Set<(positionMs: number, durationMs: number) => void>();
  let last = 0;
  const clock: JamClock = {
    subscribe(listener) {
      listeners.add(listener);
      listener(last, 5000);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    clock,
    listeners,
    emit: (positionMs: number) => {
      last = positionMs;
      for (const listener of listeners) {
        listener(positionMs, 5000);
      }
    },
  };
}

interface Extra {
  lanes?: Record<string, JamLaneMix>;
  anySolo?: boolean;
  viewerId?: string | null;
  videoEvery?: number;
  missing?: readonly JamInstrument[];
  onRecord?: (instrument: JamInstrument) => void;
  onSolo?: (trackId: string) => void;
  clock?: JamClock;
  playing?: boolean;
}

function render(count: number, extra: Extra = {}) {
  const attachVideo = vi.fn((_trackId: string, _element: HTMLVideoElement) => () => undefined);
  const onSolo = extra.onSolo ?? vi.fn();
  act(() =>
    root.render(
      <JamStage
        tracks={recordings(count, extra.videoEvery ?? 1)}
        viewerId={extra.viewerId ?? null}
        lanes={extra.lanes ?? {}}
        anySolo={extra.anySolo ?? false}
        attachVideo={attachVideo}
        clock={extra.clock ?? fakeClock().clock}
        onSolo={onSolo}
        missing={extra.missing}
        onRecord={extra.onRecord}
        playing={extra.playing}
      />,
    ),
  );
  return { attachVideo, onSolo, stage: host.querySelector<HTMLElement>("[data-jam-stage]")! };
}

function tilesOf(stage: HTMLElement) {
  return [...stage.querySelectorAll<HTMLElement>("[data-jam-stage-grid] > *")];
}

/** The grid area a tile was placed on: [colStart, colEnd, rowStart, rowEnd), from its inline style. */
function areaOf(tile: HTMLElement) {
  const col = /(\d+) \/ span (\d+)/.exec(tile.style.gridColumn)!;
  const row = /(\d+) \/ span (\d+)/.exec(tile.style.gridRow)!;
  return { col0: Number(col[1]), col1: Number(col[1]) + Number(col[2]), row0: Number(row[1]), row1: Number(row[1]) + Number(row[2]) };
}

describe("the stage's mosaic", () => {
  it("draws one tile per recording in the mix, with a video or without, each video followed on the engine's clock by its own id", () => {
    const { attachVideo, stage } = render(4, { videoEvery: 2 });
    const tiles = stage.querySelectorAll("[data-jam-stage-tile]");
    expect(tiles).toHaveLength(4);
    expect([...tiles].map((tile) => tile.getAttribute("data-jam-stage-kind"))).toEqual(["video", "audio", "video", "audio"]);
    // a video tile has a muted video; an audio-only one has none
    expect(stage.querySelectorAll("video")).toHaveLength(2);
    for (const video of stage.querySelectorAll("video")) {
      expect(video.muted).toBe(true);
    }
    expect(attachVideo.mock.calls.map((call) => call[0]).sort()).toEqual(["id-0", "id-2"]);
    expect(new Set(attachVideo.mock.calls.map((call) => call[1])).size).toBe(2);
  });

  it("attaches a video that arrives on a track already on the stage, and lets go of one that leaves", () => {
    const detach = vi.fn();
    const attachVideo = vi.fn((_trackId: string, _element: HTMLVideoElement) => detach);
    const draw = (videoUrl: string | null) =>
      act(() =>
        root.render(
          <JamStage
            tracks={[track({ id: "same", videoUrl })]}
            viewerId={null}
            lanes={{}}
            anySolo={false}
            attachVideo={attachVideo}
            clock={fakeClock().clock}
            onSolo={() => undefined}
          />,
        ),
      );
    draw(null);
    expect(attachVideo).not.toHaveBeenCalled();
    draw("https://example.test/new.webm");
    expect(attachVideo).toHaveBeenCalledTimes(1);
    expect(attachVideo.mock.calls[0]![0]).toBe("same");
    draw(null);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("draws a mosaic even when no recording has a video", () => {
    const { stage } = render(2, { videoEvery: 0 });
    expect(stage.querySelectorAll("[data-jam-stage-tile]")).toHaveLength(2);
    expect(stage.querySelectorAll("video")).toHaveLength(0);
    expect(stage.querySelectorAll("[data-jam-stage-art]")).toHaveLength(2);
  });

  for (let count = 1; count <= 9; count += 1) {
    it(`${count} tiles tile the stage exactly: every grid unit is in exactly one tile`, () => {
      const { stage } = render(count, { videoEvery: 2 });
      const tiles = tilesOf(stage);
      expect(tiles).toHaveLength(count);
      const cols = Number(stage.getAttribute("data-jam-stage-columns"));
      const rows = Number(stage.getAttribute("data-jam-stage-rows"));
      const seen = new Map<string, number>();
      for (const tile of tiles) {
        const area = areaOf(tile);
        expect(area.col1 - 1).toBeLessThanOrEqual(cols);
        expect(area.row1 - 1).toBeLessThanOrEqual(rows);
        for (let row = area.row0; row < area.row1; row += 1) {
          for (let col = area.col0; col < area.col1; col += 1) {
            seen.set(`${col},${row}`, (seen.get(`${col},${row}`) ?? 0) + 1);
          }
        }
      }
      expect(seen.size).toBe(cols * rows);
      expect([...seen.values()].every((times) => times === 1)).toBe(true);
    });
  }

  it("is the first eight and a +N tile past nine", () => {
    const { stage } = render(12);
    expect(stage.querySelectorAll("[data-jam-stage-tile]")).toHaveLength(8);
    const more = stage.querySelector("[data-jam-stage-more]")!;
    expect(more.textContent).toBe("+4");
    expect(more.getAttribute("aria-label")).toBe("4 more recordings");
    expect(tilesOf(stage)).toHaveLength(9);
  });

  it("is 16:9 on a wide panel, 4:3 on a narrow one and square on a phone", () => {
    const wide = render(2).stage.querySelector<HTMLElement>("[data-jam-stage-grid]")!;
    expect(parseFloat(wide.style.aspectRatio)).toBeCloseTo(16 / 9, 6);
    for (const [width, ratio] of [
      [540, 4 / 3],
      [366, 1],
    ] as const) {
      remount();
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
      const grid = render(2).stage.querySelector<HTMLElement>("[data-jam-stage-grid]")!;
      expect(parseFloat(grid.style.aspectRatio)).toBeCloseTo(ratio, 6);
      vi.restoreAllMocks();
    }
  });

  it("stacks two on a phone and puts two side by side on a wide panel", () => {
    expect(render(2).stage.getAttribute("data-jam-stage-columns")).toBe("2");
    remount();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(366);
    const phone = render(2).stage;
    expect(phone.getAttribute("data-jam-stage-columns")).toBe("1");
    expect(phone.getAttribute("data-jam-stage-rows")).toBe("2");
  });

  it("gives the big tile of three to the video, and keeps the tiles in the band's order in the document", () => {
    // only the LAST recording has a video
    const { stage } = render(3, { videoEvery: 0 });
    expect(tilesOf(stage).map((tile) => tile.getAttribute("data-jam-stage-tile"))).toEqual(["id-0", "id-1", "id-2"]);
    const withVideo = (() => {
      act(() =>
        root.render(
          <JamStage
            tracks={recordings(3, 0).map((one, index) => (index === 2 ? { ...one, videoUrl: "https://example.test/v.webm" } : one))}
            viewerId={null}
            lanes={{}}
            anySolo={false}
            attachVideo={() => () => undefined}
            clock={fakeClock().clock}
            onSolo={() => undefined}
          />,
        ),
      );
      return host.querySelector<HTMLElement>("[data-jam-stage]")!;
    })();
    const big = areaOf(withVideo.querySelector<HTMLElement>('[data-jam-stage-tile="id-2"]')!);
    expect(big.col1 - big.col0).toBe(2);
    expect(big.row1 - big.row0).toBe(2);
    // the document order is still the band's, not the grid's
    expect(tilesOf(withVideo).map((tile) => tile.getAttribute("data-jam-stage-tile"))).toEqual(["id-0", "id-1", "id-2"]);
  });

  it("names the person on a small caption with the instrument's mark, and says 'you' for the viewer", () => {
    const { stage } = render(2, { viewerId: "author-1" });
    const chips = [...stage.querySelectorAll("[data-jam-stage-chip]")];
    expect(chips.map((chip) => chip.querySelector("[data-jam-caption-person]")!.textContent)).toEqual(["Pessoa 0", "you"]);
    // a tile big enough also says the instrument in words, after the name
    expect(chips.map((chip) => chip.querySelector("[data-jam-caption-label]")!.textContent)).toEqual([" · guitar", " · bass"]);
    expect(chips[0]!.querySelector("span[aria-hidden]")!.className).toMatch(/bg-inst-guitar/);
  });

  it("dims the tile of a muted lane, and every lane that is not soloed while another one is", () => {
    const muted = render(2, { lanes: { "id-0": { ...IDLE, muted: true } } }).stage;
    expect(muted.querySelector('[data-jam-stage-tile="id-0"]')!.getAttribute("data-dimmed")).toBe("true");
    expect(muted.querySelector('[data-jam-stage-tile="id-1"]')!.getAttribute("data-dimmed")).toBeNull();

    const solo = render(3, { lanes: { "id-1": { ...IDLE, solo: true } }, anySolo: true }).stage;
    expect(solo.querySelector('[data-jam-stage-tile="id-1"]')!.getAttribute("data-dimmed")).toBeNull();
    expect(solo.querySelector('[data-jam-stage-tile="id-0"]')!.getAttribute("data-dimmed")).toBe("true");
    expect(solo.querySelector('[data-jam-stage-tile="id-2"]')!.getAttribute("data-dimmed")).toBe("true");
    // dimming is a neutral darkening (never a wash toward the page, which reads as disabled on a light theme), eased only for people who accept motion
    expect(solo.querySelector("video")!.className).toContain("motion-safe:transition");
    expect(solo.querySelector("video")!.className).toContain("brightness-");
  });

  it("dims a tile with no video through its art, not only through a video", () => {
    const { stage } = render(2, { videoEvery: 0, lanes: { "id-0": { ...IDLE, muted: true } } });
    expect(stage.querySelector('[data-jam-stage-tile="id-0"] [data-jam-stage-art]')!.className).toContain("opacity-40");
    expect(stage.querySelector('[data-jam-stage-tile="id-1"] [data-jam-stage-art]')!.className).not.toContain("opacity-40");
  });

  it("offers full screen only where the browser has it", () => {
    expect(render(1).stage.querySelector("[data-jam-stage-fullscreen]")).toBeNull();
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    try {
      const button = render(1).stage.querySelector<HTMLButtonElement>("[data-jam-stage-fullscreen]")!;
      expect(button.getAttribute("aria-label")).toBe("Full screen");
    } finally {
      delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    }
  });
});

describe("a tile is the solo button", () => {
  it("is a button with aria-pressed that says what it does, and calls onSolo with its track", () => {
    const onSolo = vi.fn();
    const { stage } = render(3, { onSolo });
    const tile = stage.querySelector<HTMLButtonElement>('[data-jam-stage-tile="id-1"]')!;
    expect(tile.tagName).toBe("BUTTON");
    expect(tile.type).toBe("button");
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    expect(tile.getAttribute("aria-label")).toBe("Bass, Pessoa 1. Hear only this one");
    act(() => tile.click());
    expect(onSolo).toHaveBeenCalledWith("id-1");
    expect(onSolo).toHaveBeenCalledTimes(1);
  });

  it("shows the tile that is soloed as pressed, with a visible 'Only this' mark, and no other", () => {
    const { stage } = render(3, { lanes: { "id-2": { ...IDLE, solo: true } }, anySolo: true });
    const pressed = [...stage.querySelectorAll("[data-jam-stage-tile]")].filter((tile) => tile.getAttribute("aria-pressed") === "true");
    expect(pressed.map((tile) => tile.getAttribute("data-jam-stage-tile"))).toEqual(["id-2"]);
    expect(pressed[0]!.querySelector("[data-jam-stage-solo-badge]")!.textContent).toBe("Only this");
    expect(stage.querySelectorAll("[data-jam-stage-solo-badge]")).toHaveLength(1);
  });

  it("is reachable and operable by keyboard: a real button, in tab order, never tabindex -1", () => {
    const { stage } = render(2);
    for (const tile of stage.querySelectorAll("[data-jam-stage-tile]")) {
      expect(tile.getAttribute("tabindex")).toBeNull();
    }
  });
});

describe("a tile with no video", () => {
  it("sits on the ONE neutral tile ground (never a tint of the instrument, never a translucent wash), with the person and the instrument's chip on it", () => {
    const { stage } = render(1, { videoEvery: 0 });
    const tile = stage.querySelector('[data-jam-stage-tile="id-0"]')!;
    expect(tile.className).toMatch(/(^|\s)bg-tile(\s|$)/);
    expect(tile.className).not.toMatch(/bg-tile-[a-z]|color-mix|bg-inst-|\/\d+\b/);
    expect(tile.querySelector("[data-jam-person]")).not.toBeNull();
    expect(tile.querySelector("svg")).not.toBeNull();
    // the ink of the strip is the tile's own
    expect(tile.querySelector("[data-jam-stage-art]")!.className).toContain("text-tile-guitar-ink");
  });

  it("is the person alone at rest: no level strip, and no clock subscription for one", () => {
    const { clock, listeners } = fakeClock();
    const { stage } = render(2, { videoEvery: 0, clock });
    expect(stage.querySelector("[data-jam-stage-level]")).toBeNull();
    expect(stage.querySelectorAll("[data-jam-person]")).toHaveLength(2);
    expect(listeners.size).toBe(0);
  });

  it("gains its level strip when the song plays and loses it on pause", () => {
    const { clock } = fakeClock();
    const draw = (playing: boolean) => render(1, { videoEvery: 0, clock, playing }).stage;
    expect(draw(true).querySelectorAll("[data-jam-stage-level]")).toHaveLength(1);
    expect(draw(false).querySelector("[data-jam-stage-level]")).toBeNull();
  });

  it("has a level strip whose bars follow the take's peaks at the song clock, and move when the clock does", () => {
    const { clock, emit } = fakeClock();
    const { stage } = render(1, { videoEvery: 0, clock, playing: true });
    const bars = [...stage.querySelectorAll<HTMLElement>("[data-jam-stage-level] > span")];
    expect(bars).toHaveLength(29);
    const scale = (bar: HTMLElement) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)![1]);
    act(() => emit(1000));
    // the song is at 1 s of 5: peaks are 1 s each, so the middle bar is the second peak (0.8)
    expect(scale(bars[14]!)).toBeCloseTo(0.14 + 0.86 * 0.8, 2);
    const before = bars.map(scale);
    act(() => emit(3000));
    expect(scale(bars[14]!)).toBeCloseTo(0.14 + 0.86 * 0.9, 2);
    expect(bars.map(scale)).not.toEqual(before);
  });

  it("does not subscribe a video tile to the clock for a level it does not draw", () => {
    const { clock, listeners } = fakeClock();
    render(2, { videoEvery: 1, clock });
    expect(listeners.size).toBe(0);
  });

  it("stays still when motion is not wanted: the whole take as a picture, no clock subscription, no easing", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }));
    const { clock, listeners, emit } = fakeClock();
    const { stage } = render(1, { videoEvery: 0, clock, playing: true });
    expect(listeners.size).toBe(0);
    const bars = [...stage.querySelectorAll<HTMLElement>("[data-jam-stage-level] > span")];
    const before = bars.map((bar) => bar.style.transform);
    expect(before.some((value) => value !== "scaleY(0.000)")).toBe(true);
    act(() => emit(3000));
    expect(bars.map((bar) => bar.style.transform)).toEqual(before);
    // the easing lives in `lib/jam-tile.css` under `prefers-reduced-motion: no-preference` only
  });

  it("stops listening to the clock when it leaves", () => {
    const { clock, listeners } = fakeClock();
    render(1, { videoEvery: 0, clock, playing: true });
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(host);
  });
});

describe("the part the song asks for", () => {
  it("is one dashed tile in the mosaic, in that instrument's colour, that opens the recording for that instrument", () => {
    const onRecord = vi.fn();
    const { stage } = render(3, { missing: ["bass"], onRecord });
    expect(stage.querySelectorAll("[data-jam-stage-tile]")).toHaveLength(3);
    const slot = stage.querySelector<HTMLButtonElement>('[data-jam-stage-slot="bass"]')!;
    expect(slot.textContent).toBe("Your bass here");
    expect(slot.querySelector(".border-dashed")!.className).toContain("border-tile-bass-ink");
    // it is a tile of the grid like the others: four tiles now
    expect(tilesOf(stage)).toHaveLength(4);
    act(() => slot.click());
    expect(onRecord).toHaveBeenCalledWith("bass");
  });

  it("is not there when the viewer may not record", () => {
    const { stage } = render(3, { missing: ["bass"] });
    expect(stage.querySelector("[data-jam-stage-slot]")).toBeNull();
    expect(tilesOf(stage)).toHaveLength(3);
  });

  it("keeps its place when the band is big, and the recordings fold into +N instead", () => {
    const { stage } = render(9, { missing: ["bass"], onRecord: () => undefined });
    expect(stage.querySelector('[data-jam-stage-slot="bass"]')).not.toBeNull();
    expect(stage.querySelector("[data-jam-stage-more]")!.textContent).toBe("+2");
    expect(tilesOf(stage)).toHaveLength(9);
  });
});
