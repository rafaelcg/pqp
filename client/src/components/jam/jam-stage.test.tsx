// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamLaneMix } from "@/hooks/use-jam-playback";
import { track } from "@/lib/jam-test-fixtures";
import { JamStage, stageColumns } from "./jam-stage";

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
});

const IDLE: JamLaneMix = { muted: false, solo: false, volume: 1 };

function recordings(count: number) {
  return Array.from({ length: count }, (_, index) =>
    track({
      id: `id-${index}`,
      authorId: `author-${index}`,
      authorName: `Pessoa ${index}`,
      instrument: (["guitar", "bass", "drums", "keys", "vocals", "other"] as const)[index % 6]!,
      videoUrl: `https://example.test/v${index}.webm`,
    }),
  );
}

function render(count: number, extra: { lanes?: Record<string, JamLaneMix>; anySolo?: boolean; viewerId?: string | null } = {}) {
  const attachVideo = vi.fn((_trackId: string, _element: HTMLVideoElement) => () => undefined);
  act(() =>
    root.render(
      <JamStage
        tracks={recordings(count)}
        viewerId={extra.viewerId ?? null}
        lanes={extra.lanes ?? {}}
        anySolo={extra.anySolo ?? false}
        attachVideo={attachVideo}
      />,
    ),
  );
  return { attachVideo, stage: host.querySelector<HTMLElement>("[data-jam-stage]")! };
}

describe("the stage's grid", () => {
  it("is one large tile for one video, two side by side, three in a row, then an even grid", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((count) => stageColumns(count))).toEqual([1, 2, 3, 2, 3, 3, 4, 4]);
  });

  it("stacks up to three when the stage is narrow, so each tile is bigger than a thumbnail", () => {
    expect([1, 2, 3, 4, 5, 6].map((count) => stageColumns(count, true))).toEqual([1, 1, 1, 2, 2, 2]);
  });
});

describe("the stage", () => {
  it("draws one 16:9 tile per recording with a video, each followed on the engine's clock by its own id", () => {
    const { attachVideo, stage } = render(3);
    const tiles = stage.querySelectorAll("[data-jam-stage-tile]");
    expect(tiles).toHaveLength(3);
    expect(stage.getAttribute("data-jam-stage-columns")).toBe("3");
    for (const tile of tiles) {
      expect(tile.className).toContain("aspect-video");
      const video = tile.querySelector("video")!;
      // the sound is the mix: a stage video is always muted
      expect(video.muted).toBe(true);
    }
    expect(attachVideo.mock.calls.map((call) => call[0]).sort()).toEqual(["id-0", "id-1", "id-2"]);
    expect(new Set(attachVideo.mock.calls.map((call) => call[1])).size).toBe(3);
  });

  it("is capped at 55% of the window's height for one row, a little less for several, by tile count and rows", () => {
    expect(render(2).stage.className).toContain("[--stage-h:55vh]");
    const four = render(4).stage;
    expect(four.className).toContain("[--stage-h:46vh]");
    const grid = four.firstElementChild as HTMLElement;
    // 2 columns x 2 rows of 16:9: the grid is at most 2 * (55vh / 2) * 16/9 wide
    expect(grid.style.maxWidth).toContain("calc(2 * (var(--stage-h) / 2)");
  });

  it("names the person on a chip with the instrument's colour as a dot, and says 'you' for the viewer", () => {
    const { stage } = render(2, { viewerId: "author-1" });
    const chips = [...stage.querySelectorAll("[data-jam-stage-chip]")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Pessoa 0", "you"]);
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
    // dimming is an opacity, which is allowed to ease only for people who accept motion
    expect(solo.querySelector("video")!.className).toContain("motion-safe:transition");
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
