// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarqueeText } from "@/components/ui/marquee-text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** jsdom has no layout, so the two widths the component reads are stubbed. */
let fireResize: (() => void) | null = null;
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    fireResize = () => this.callback();
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

function widths(host: HTMLElement, clip: number, copy: number) {
  const clipEl = host.querySelector("span") as HTMLElement;
  Object.defineProperty(clipEl, "clientWidth", { value: clip, configurable: true });
  for (const el of host.querySelectorAll("[data-marquee-copy]")) {
    Object.defineProperty(el, "scrollWidth", { value: copy, configurable: true });
  }
}

let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(text: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<MarqueeText text={text} />);
  });
  return host;
}

const copies = () => host.querySelectorAll("[data-marquee-copy], .pl-8").length;

describe("MarqueeText", () => {
  it("draws one copy while the text fits", () => {
    mount("Tempo Perdido");
    widths(host, 400, 120);
    act(() => fireResize?.());
    expect(copies()).toBe(1);
    expect(host.querySelector(".pqp-marquee")).toBeNull();
  });

  it("draws the second copy and scrolls once it does not fit", () => {
    mount("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)");
    widths(host, 160, 480);
    act(() => fireResize?.());
    expect(copies()).toBe(2);
    expect(host.querySelector(".pqp-marquee")).not.toBeNull();
  });

  /*
   * The latch: measuring the PAIR keeps the answer at yes while the box
   * grows, so a box wide enough for one copy and a bit shows the spare one.
   */
  it("puts the spare copy away when the box grows enough for one", () => {
    mount("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)");
    widths(host, 160, 480);
    act(() => fireResize?.());
    expect(copies()).toBe(2);

    widths(host, 600, 480);
    act(() => fireResize?.());
    expect(copies()).toBe(1);
    expect(host.querySelector(".pqp-marquee")).toBeNull();
  });
});
