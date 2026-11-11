// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { song } from "@/lib/jam-test-fixtures";
import { JamTile, type JamTileProps } from "./jam-tile";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeEach(() => {
  // jsdom has no layout: give every element a width, so the bars have somewhere to be counted
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 120 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (realWidth) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", realWidth);
  }
  act(() => root.unmount());
  host.remove();
});

function render(overrides: Partial<JamTileProps> = {}, songOverrides: Parameters<typeof song>[0] = {}) {
  const props: JamTileProps = {
    song: song(songOverrides),
    size: "card",
    index: 0,
    onOpen: vi.fn(),
    onPlay: vi.fn(),
    ...overrides,
  };
  act(() =>
    root.render(
      <ul>
        <JamTile {...props} />
      </ul>,
    ),
  );
  return { props, tile: host.querySelector<HTMLElement>("[data-jam-tile]")! };
}

describe("a song's card", () => {
  it("opens from the whole card and plays only from its round button, two separate buttons", () => {
    const { props, tile } = render();
    const open = tile.querySelector<HTMLButtonElement>("[data-jam-open]")!;
    const play = tile.querySelector<HTMLButtonElement>("[data-jam-tile-play]")!;
    expect(open).not.toBe(play);
    // not nested: pressing play must never be pressing the card
    expect(open.contains(play)).toBe(false);
    expect(play.contains(open)).toBe(false);

    act(() => open.click());
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onPlay).not.toHaveBeenCalled();

    act(() => play.click());
    expect(props.onPlay).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it("makes the play button reachable by name, apart from the card", () => {
    const { tile } = render();
    const play = tile.querySelector<HTMLButtonElement>("[data-jam-tile-play]")!;
    expect(play.getAttribute("aria-label")).toBe("Play In Bloom");
    expect(play.tabIndex).toBe(0);
  });

  it("draws a cover photo clean: nothing of ours (no waveform, no chips) is inside the picture", () => {
    const { tile } = render({}, { coverUrl: "https://bucket.test/cover.jpg?sig=1", joinMode: "wanted", wantedInstruments: ["vocals"] });
    expect(tile.hasAttribute("data-jam-tile-cover")).toBe(true);
    const picture = tile.querySelector<HTMLElement>("[data-jam-artwork]")!;
    expect(picture.getAttribute("data-jam-artwork")).toBe("cover");
    expect(picture.querySelector("img[data-jam-cover-photo]")).not.toBeNull();
    expect(picture.querySelector("[data-jam-band-art]")).toBeNull();
    expect(picture.querySelector("[data-jam-need]")).toBeNull();
    // the words and the status live in the footer, outside the picture
    expect(tile.querySelector("[data-jam-open]")!.textContent).toContain("In Bloom");
    expect(tile.querySelector("[data-jam-need]")).not.toBeNull();
  });

  it("falls back to the band, not to a flat box, when the cover is removed", () => {
    const withCover = song({ coverUrl: "https://bucket.test/cover.jpg?sig=1" });
    act(() =>
      root.render(
        <ul>
          <JamTile song={withCover} size="card" index={0} onOpen={() => undefined} onPlay={() => undefined} />
        </ul>,
      ),
    );
    act(() =>
      root.render(
        <ul>
          <JamTile song={{ ...withCover, coverUrl: null }} size="card" index={0} onOpen={() => undefined} onPlay={() => undefined} />
        </ul>,
      ),
    );
    const tile = host.querySelector<HTMLElement>("[data-jam-tile]")!;
    expect(tile.hasAttribute("data-jam-tile-cover")).toBe(false);
    expect(tile.querySelector("[data-jam-band-art]")).not.toBeNull();
    // THE BUG: the waveform's width was measured once, by a ref object read in an effect, so a band that
    // mounted LATER (a cover just removed) was never measured and drew a flat box with no bars. The
    // measuring ref is a callback ref now, and the bars are there.
    expect(tile.querySelectorAll("[data-jam-band-art] span[style*='height']").length).toBeGreaterThan(0);
  });

  it("says what a song needs in a word that stays whole on a narrow card (a short form exists)", () => {
    const { tile } = render({}, { joinMode: "wanted", wantedInstruments: ["vocals", "keys"], instruments: ["guitar"] });
    const need = tile.querySelector<HTMLElement>('[data-jam-need="missing"]')!;
    // long, short and micro forms are all present; the card's width picks one
    expect(need.textContent).toContain("2 missing");
    expect(need.querySelectorAll("span.truncate").length).toBeGreaterThanOrEqual(2);
  });

  it("does not say the default: an open song has no status line, only the exceptions do", () => {
    const { tile } = render();
    expect(tile.querySelector("[data-jam-need]")).toBeNull();
  });

  it("marks a closed song with a lock and the word, not a surprise", () => {
    const { tile } = render({}, { joinMode: "closed" });
    expect(tile.querySelector("[data-jam-tile-closed]")).not.toBeNull();
    expect(tile.querySelector('[data-jam-need="ready"]')!.textContent).toContain("closed");
  });
});
