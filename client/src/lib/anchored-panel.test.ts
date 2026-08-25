import { describe, expect, it } from "vitest";
import {
  ANCHORED_PANEL_GAP,
  ANCHORED_PANEL_PAD,
  EMOJI_PICKER_SIZE,
  placeAnchoredPanel,
} from "./anchored-panel";

const panel = EMOJI_PICKER_SIZE;
const viewport = { width: 800, height: 600 };
const gap = ANCHORED_PANEL_GAP;
const pad = ANCHORED_PANEL_PAD;

describe("placeAnchoredPanel", () => {
  it("opens above when there is room", () => {
    const anchor = { top: 400, bottom: 430, left: 80, right: 200 };
    const placed = placeAnchoredPanel(anchor, panel, viewport);
    expect(placed.top).toBe(anchor.top - gap - panel.height);
    expect(placed.left).toBe(anchor.left);
    expect(placed.maxHeight).toBe(panel.height);
  });

  it("flips below when the anchor is at the top of the window", () => {
    const anchor = { top: 40, bottom: 72, left: 80, right: 200 };
    const placed = placeAnchoredPanel(anchor, panel, viewport);
    expect(placed.top).toBe(anchor.bottom + gap);
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(
      viewport.height - pad,
    );
  });

  it("stays above when the anchor is at the bottom of the window", () => {
    const anchor = { top: 520, bottom: 560, left: 80, right: 200 };
    const placed = placeAnchoredPanel(anchor, panel, viewport);
    expect(placed.top).toBe(anchor.top - gap - panel.height);
    expect(placed.top).toBeGreaterThanOrEqual(pad);
  });

  it("shrinks to the larger side when neither side fits", () => {
    const short = { width: 800, height: 360 };
    const anchor = { top: 160, bottom: 200, left: 80, right: 200 };
    const placed = placeAnchoredPanel(anchor, panel, short);
    expect(placed.maxHeight).toBeLessThan(panel.height);
    expect(placed.top).toBeGreaterThanOrEqual(pad);
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(
      short.height - pad,
    );
  });

  it("clamps left so a right-edge anchor does not hang off the window", () => {
    const anchor = { top: 400, bottom: 430, left: 700, right: 790 };
    const placed = placeAnchoredPanel(anchor, panel, viewport);
    expect(placed.left + placed.maxWidth).toBeLessThanOrEqual(
      viewport.width - pad,
    );
    expect(placed.left).toBeGreaterThanOrEqual(pad);
  });
});
