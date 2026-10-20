// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { translateMessage } from "@/lib/i18n";
import { MusicSpeakerControl } from "@/components/voice/music-speaker-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const onMute = vi.fn();
const onVolume = vi.fn();

function stubMedia(hover: boolean, wide = true) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("hover: hover")
      ? hover
      : query.includes("min-width")
        ? wide
        : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

async function mount(
  props: { volume?: number; muted?: boolean; slider?: boolean } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <MusicSpeakerControl
          volume={props.volume ?? 40}
          muted={props.muted ?? false}
          slider={props.slider}
          onMute={onMute}
          onVolume={onVolume}
        />
      </TooltipProvider>,
    );
  });
}

const speaker = () =>
  host!.querySelector<HTMLButtonElement>("[data-music-speaker]")!;
const rootEl = () =>
  host!.querySelector<HTMLElement>("[data-music-speaker-root]")!;
const flyout = () => host!.querySelector("[data-music-volume-flyout]");

/** jsdom has no focus-visible heuristic, so a keyboard focus is stood in for. */
function keyboardFocus() {
  const real = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ":focus-visible" ? true : real.call(this, selector);
  });
}

function key(target: Element, name: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

beforeEach(() => {
  onMute.mockReset();
  onVolume.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MusicSpeakerControl on a mouse", () => {
  beforeEach(() => stubMedia(true));

  it("keeps the click as mute and shows no slider until hovered", async () => {
    await mount();
    expect(flyout()).toBeNull();
    await act(async () => speaker().click());
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("opens the slider on hover with a spoken value, and closes after leaving", async () => {
    vi.useFakeTimers();
    try {
      await mount({ volume: 40 });
      await act(async () => {
        rootEl().dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      });
      expect(flyout()).not.toBeNull();
      const thumb = flyout()!.querySelector('[role="slider"]')!;
      expect(thumb.getAttribute("aria-valuetext")).toBe(
        translateMessage("music.volume.valueText", { percent: 40 }),
      );
      expect(thumb.getAttribute("aria-valuenow")).toBe("40");
      await act(async () => {
        rootEl().dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
        vi.advanceTimersByTime(400);
      });
      expect(flyout()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens for keyboard focus, and the slider takes arrows, Home and End", async () => {
    keyboardFocus();
    await mount({ volume: 40 });
    await act(async () => speaker().focus());
    expect(flyout()).not.toBeNull();
    const thumb = flyout()!.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      thumb.focus();
      key(thumb, "ArrowRight");
    });
    expect(onVolume).toHaveBeenLastCalledWith(45);
    await act(async () => key(thumb, "ArrowLeft"));
    expect(onVolume).toHaveBeenLastCalledWith(35);
    await act(async () => key(thumb, "End"));
    expect(onVolume).toHaveBeenLastCalledWith(100);
    await act(async () => key(thumb, "Home"));
    expect(onVolume).toHaveBeenLastCalledWith(0);
  });

  it("does not hold the slider open after a mouse click leaves focus on the speaker", async () => {
    await mount();
    await act(async () => speaker().focus());
    expect(flyout()).toBeNull();
  });

  it("closes on Escape and puts focus back on the speaker", async () => {
    keyboardFocus();
    await mount();
    await act(async () => speaker().focus());
    expect(flyout()).not.toBeNull();
    await act(async () => key(speaker(), "Escape"));
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(speaker());
  });

  it("moves the level a notch at a time and stops the page scrolling", async () => {
    await mount({ volume: 40 });
    const up = new WheelEvent("wheel", {
      deltaY: -40,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      speaker().dispatchEvent(up);
    });
    expect(up.defaultPrevented).toBe(true);
    expect(onVolume).toHaveBeenLastCalledWith(45);
  });

  it("does not take a wheel anywhere else", async () => {
    await mount();
    const elsewhere = new WheelEvent("wheel", {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it("wheels up from muted to one step above the kept level, and down stays silent", async () => {
    await mount({ volume: 40, muted: true });
    await act(async () => {
      speaker().dispatchEvent(
        new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true }),
      );
    });
    expect(onVolume).not.toHaveBeenCalled();
    await act(async () => {
      speaker().dispatchEvent(
        new WheelEvent("wheel", { deltaY: -40, bubbles: true, cancelable: true }),
      );
    });
    expect(onVolume).toHaveBeenLastCalledWith(45);
  });

  it("changes glyph between muted, low, medium and high", async () => {
    const glyphFor = async (volume: number, muted = false) => {
      await act(async () => root?.unmount());
      host?.remove();
      await mount({ volume, muted });
      return host!
        .querySelector("[data-music-glyph]")!
        .getAttribute("data-music-glyph");
    };
    expect(await glyphFor(0)).toBe("muted");
    expect(await glyphFor(60, true)).toBe("muted");
    expect(await glyphFor(20)).toBe("low");
    expect(await glyphFor(50)).toBe("medium");
    expect(await glyphFor(90)).toBe("high");
  });

  it("keeps the composer's inline slider, hidden by width rather than removed", async () => {
    await mount({ slider: true });
    const inline = host!.querySelector("[data-music-volume]")!;
    expect(inline.className).toContain("@min-[40rem]:flex");
  });
});

describe("MusicSpeakerControl on touch or a narrow window", () => {
  beforeEach(() => stubMedia(false));

  it("opens a popover with the slider and a mute switch on tap, without muting", async () => {
    await mount({ volume: 40 });
    expect(speaker().getAttribute("aria-expanded")).toBe("false");
    await act(async () => speaker().click());
    expect(onMute).not.toHaveBeenCalled();
    expect(speaker().getAttribute("aria-expanded")).toBe("true");
    expect(flyout()!.querySelector('[role="slider"]')).not.toBeNull();
    const toggle = flyout()!.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(onMute).toHaveBeenCalledTimes(1);
  });

  it("shows the switch on when muted", async () => {
    await mount({ volume: 40, muted: true });
    await act(async () => speaker().click());
    expect(
      flyout()!.querySelector('[role="switch"]')!.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("closes on a tap outside and on Escape", async () => {
    await mount();
    await act(async () => speaker().click());
    expect(flyout()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(flyout()).toBeNull();
    await act(async () => speaker().click());
    await act(async () => key(speaker(), "Escape"));
    expect(flyout()).toBeNull();
  });

  it("gives touch targets 44px", async () => {
    await mount({ slider: true });
    expect(speaker().className).toContain("pointer-coarse:h-11");
    await act(async () => speaker().click());
    expect(
      flyout()!.querySelector("[data-slider]")!.className,
    ).toContain("pointer-coarse:h-11");
  });
});
