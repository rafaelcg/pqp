// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useScrub, type Scrub } from "@/components/voice/use-scrub";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(onSeek: (value: number) => void) {
  let scrub!: Scrub;
  function Probe() {
    scrub = useScrub(onSeek);
    return <span data-preview={String(scrub.preview)} />;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
  const preview = () => host.querySelector("span")?.getAttribute("data-preview");
  return { get scrub() { return scrub; }, preview };
}

describe("useScrub", () => {
  /*
   * The order a controlled Radix slider produces for a key press: the
   * updater fires the commit, and the change follows it.
   */
  it("seeks once on a key press and holds no preview afterwards", () => {
    const seeks: number[] = [];
    const probe = mount((value) => seeks.push(value));
    act(() => {
      probe.scrub.onValueCommit(45_250);
      probe.scrub.onValueChange(45_250);
    });
    expect(seeks).toEqual([45_250]);
    expect(probe.preview()).toBe("null");
  });

  it("does not freeze after several key presses", () => {
    const seeks: number[] = [];
    const probe = mount((value) => seeks.push(value));
    for (const value of [1_000, 2_000, 3_000]) {
      act(() => {
        probe.scrub.onValueCommit(value);
        probe.scrub.onValueChange(value);
      });
    }
    expect(seeks).toEqual([1_000, 2_000, 3_000]);
    expect(probe.preview()).toBe("null");
  });

  it("previews while a drag is in progress, and seeks once on release", () => {
    const seeks: number[] = [];
    const probe = mount((value) => seeks.push(value));
    act(() => probe.scrub.rootProps.onPointerDown());
    act(() => probe.scrub.onValueChange(10_000));
    expect(probe.preview()).toBe("10000");
    expect(seeks).toEqual([]);
    act(() => probe.scrub.onValueChange(20_000));
    expect(probe.preview()).toBe("20000");
    act(() => probe.scrub.onValueCommit(20_000));
    expect(seeks).toEqual([20_000]);
    expect(probe.preview()).toBe("null");
  });

  it("drops the preview when a drag is cancelled", () => {
    const probe = mount(() => {});
    act(() => probe.scrub.rootProps.onPointerDown());
    act(() => probe.scrub.onValueChange(10_000));
    expect(probe.preview()).toBe("10000");
    act(() => probe.scrub.rootProps.onPointerCancel());
    expect(probe.preview()).toBe("null");
  });

  /* A keyboard step to a value a drag just committed is still a step. */
  it("seeks again once the value changes", () => {
    const seeks: number[] = [];
    const probe = mount((value) => seeks.push(value));
    act(() => {
      probe.scrub.onValueCommit(5_000);
      probe.scrub.onValueChange(5_000);
      probe.scrub.onValueChange(5_250);
    });
    expect(seeks).toEqual([5_000, 5_250]);
  });
});
