// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JamRowArt, JamRowIcon } from "./jam-row-art";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const draw = (element: ReactElement) => act(() => root.render(element));
const art = () => host.querySelector("[data-jam-art]");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("JamRowArt", () => {
  it("is decoration: hidden from assistive tech and carries the mood and selection as data", () => {
    draw(<JamRowArt mood="news" selected={false} />);
    expect(art()?.getAttribute("aria-hidden")).toBe("true");
    expect(art()?.getAttribute("data-mood")).toBe("news");
    expect(art()?.getAttribute("data-selected")).toBe("false");
    expect(host.querySelector(".jam-art-here")).toBeNull();
  });

  it("draws the open-page marker only while selected", () => {
    draw(<JamRowArt mood="quiet" selected />);
    expect(host.querySelector(".jam-art-here")).not.toBeNull();
    draw(<JamRowArt mood="quiet" selected={false} />);
    expect(host.querySelector(".jam-art-here")).toBeNull();
  });

  it("stops animating while the tab is hidden and resumes when it is visible again", () => {
    draw(<JamRowArt mood="playing" selected />);
    expect(art()?.getAttribute("data-alive")).toBe("true");
    const set = (state: DocumentVisibilityState) =>
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => {
      set("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(art()?.getAttribute("data-alive")).toBe("false");
    act(() => {
      set("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(art()?.getAttribute("data-alive")).toBe("true");
  });
});

describe("JamRowIcon", () => {
  it("follows the mood and is hidden from assistive tech", () => {
    draw(<JamRowIcon mood="playing" />);
    const icon = host.querySelector("[data-jam-icon]");
    expect(icon?.getAttribute("data-mood")).toBe("playing");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
