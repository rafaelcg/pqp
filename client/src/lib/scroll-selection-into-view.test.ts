import { describe, expect, it, vi } from "vitest";
import { scrollSelectionIntoView, type ScrollTarget } from "./scroll-selection-into-view";

function fakeTarget() {
  return { scrollIntoView: vi.fn<ScrollTarget["scrollIntoView"]>() };
}

describe("scrollSelectionIntoView", () => {
  it("scrolls the newly selected row into view with block: nearest", () => {
    const targets = [fakeTarget(), fakeTarget(), fakeTarget()];
    scrollSelectionIntoView(targets, 0, 1);
    expect(targets[1].scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
    });
    expect(targets[0].scrollIntoView).not.toHaveBeenCalled();
    expect(targets[2].scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing when the selection did not move", () => {
    const targets = [fakeTarget(), fakeTarget(), fakeTarget()];
    scrollSelectionIntoView(targets, 1, 1);
    for (const target of targets) {
      expect(target.scrollIntoView).not.toHaveBeenCalled();
    }
  });

  it("follows the selection back up, not only down", () => {
    const targets = [fakeTarget(), fakeTarget(), fakeTarget()];
    scrollSelectionIntoView(targets, 2, 0);
    expect(targets[0].scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
    });
  });

  it("follows the wrap from the last row back to the first", () => {
    const targets = [fakeTarget(), fakeTarget(), fakeTarget()];
    scrollSelectionIntoView(targets, 2, 0);
    expect(targets[0].scrollIntoView).toHaveBeenCalledOnce();
    expect(targets[2].scrollIntoView).not.toHaveBeenCalled();
  });

  it("tolerates a missing target instead of throwing", () => {
    const targets: (ScrollTarget | null | undefined)[] = [null, undefined];
    expect(() => scrollSelectionIntoView(targets, 0, 1)).not.toThrow();
  });
});
