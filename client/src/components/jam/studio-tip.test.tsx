// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioTip } from "./jam-studio-parts";

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

describe("the studio's first-run tip", () => {
  it("is drawn inside the studio, not through the corner queue", () => {
    act(() => root.render(<StudioTip />));
    const tip = host.querySelector("[data-jam-studio-tip]");
    expect(tip).not.toBeNull();
    // the corner card frame is what a standing card can sit on top of the post button with
    expect(host.querySelector("[data-corner-card]")).toBeNull();
    expect(tip?.textContent).toContain("headphones");
  });

  it("goes away when dismissed", () => {
    act(() => root.render(<StudioTip />));
    const dismiss = host.querySelector<HTMLButtonElement>("[data-jam-studio-tip] button");
    expect(dismiss).not.toBeNull();
    act(() => dismiss!.click());
    expect(host.querySelector("[data-jam-studio-tip]")).toBeNull();
  });
});
