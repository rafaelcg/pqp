// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cornerSpaceNow, reserveCornerSpace } from "./corner-space";

const root = () => document.documentElement;

function card(height: number): HTMLElement {
  const element = document.createElement("aside");
  Object.defineProperty(element, "offsetHeight", { configurable: true, get: () => height });
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("room for a phone's corner card", () => {
  it("makes the page stop above a card for as long as it is up, and gives the room back", () => {
    expect(root().hasAttribute("data-corner-space")).toBe(false);
    const release = reserveCornerSpace(card(240));
    expect(root().hasAttribute("data-corner-space")).toBe(true);
    expect(root().style.getPropertyValue("--pqp-corner-space")).toBe("260px");
    release();
    expect(root().hasAttribute("data-corner-space")).toBe(false);
    expect(root().style.getPropertyValue("--pqp-corner-space")).toBe("");
    expect(cornerSpaceNow()).toBe(0);
  });

  it("takes the tallest of the cards that share the corner, not their sum, and lets go one at a time", () => {
    const releaseSmall = reserveCornerSpace(card(120));
    const releaseTall = reserveCornerSpace(card(300));
    expect(root().style.getPropertyValue("--pqp-corner-space")).toBe("320px");
    releaseTall();
    expect(root().style.getPropertyValue("--pqp-corner-space")).toBe("140px");
    releaseSmall();
    expect(root().hasAttribute("data-corner-space")).toBe(false);
  });

  it("asks for nothing for a card with no height (not laid out), so the page keeps its own", () => {
    const release = reserveCornerSpace(card(0));
    expect(root().hasAttribute("data-corner-space")).toBe(false);
    release();
  });

  it("the shell's rule is a phone's only, and ends the page above the card", () => {
    const css = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    const rule = css.slice(css.indexOf("A phone's corner card never covers"));
    expect(rule).toMatch(/@media \(max-width: 39\.999rem\)/);
    expect(rule).toMatch(/html\[data-app-shell\]\[data-corner-space\] #root/);
    expect(rule).toMatch(/calc\(100dvh - var\(--pqp-corner-space, 0px\)\)/);
  });

  it("a keyboard hint is for a window with room for a keyboard: the shortcuts card needs the sm breakpoint too", () => {
    const app = readFileSync(path.resolve(process.cwd(), "src/App.tsx"), "utf8");
    const gate = app.slice(app.indexOf("      shortcuts:\n        wantsShortcutsHint &&"), app.indexOf("attachedFeatureHint === null,"));
    expect(gate).toContain("voiceCleanDesktopViewport &&");
  });

  it("the Jam card leaves its picture to the desktop, so a phone's card is a short one", () => {
    const hint = readFileSync(path.resolve(process.cwd(), "src/components/layout/jam-announcement-hint.tsx"), "utf8");
    expect(hint).toContain("phoneHero={false}");
  });
});
