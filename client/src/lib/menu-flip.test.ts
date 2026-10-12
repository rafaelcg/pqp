// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { shouldOpenUp } from "./menu-flip";

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
}

/** A scroller from 0 to 600 with an anchor at `top`..`top + 24`. */
function setup(top: number) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const anchor = document.createElement("div");
  scroller.append(anchor);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => rect(0, 600);
  anchor.getBoundingClientRect = () => rect(top, top + 24);
  return anchor;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shouldOpenUp", () => {
  it("opens down when the menu fits below", () => {
    expect(shouldOpenUp(setup(100), 200)).toBe(false);
  });

  it("opens up on the last row, where the scroller would clip it", () => {
    expect(shouldOpenUp(setup(540), 200)).toBe(true);
  });

  it("stays down when there is even less room above", () => {
    expect(shouldOpenUp(setup(20), 590)).toBe(false);
  });
});
