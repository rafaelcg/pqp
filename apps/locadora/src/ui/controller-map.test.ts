// @vitest-environment jsdom
/**
 * The controller map's drawing: one chip per button the console has, leaders that are one straight
 * horizontal or vertical segment each and never cross, the listening ring on the live button (or the live
 * direction of the d-pad), the gamepad glow on what is held, and hover or focus lighting the control and its
 * chip together. Where things land on screen at real widths is the e2e rig's job; what can be read from the
 * markup is pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../i18n";
import { BUTTONS_BY_PLATFORM, DPAD, defaultKeymaps, PLATFORMS, type Platform } from "../keymap";
import { boundsOf, CONSOLES, createControllerMap, edgeToward } from "./controller-map";

const t = STRINGS["pt-BR"];

function mount(platform: Platform = "snes", onRemap = vi.fn()) {
  const map = createControllerMap({ t, platform, mapping: defaultKeymaps()[platform], onRemap });
  document.body.append(map.element);
  return { map, onRemap, el: map.element };
}

type Seg = { group: string; x1: number; y1: number; x2: number; y2: number };

function leaders(el: HTMLElement): Seg[] {
  return [...el.querySelectorAll<SVGGElement>(".loc-pad-leader")].map((g) => {
    const [x1, y1, x2, y2] = (g.querySelector("path")!.getAttribute("d")!.match(/-?[\d.]+/g) ?? []).map(Number) as [number, number, number, number];
    return { group: g.dataset.group!, x1, y1, x2, y2 };
  });
}

function crosses(a: Seg, b: Seg): boolean {
  const horizontal = (s: Seg) => s.y1 === s.y2;
  if (horizontal(a) === horizontal(b)) {
    // parallel: only a problem when they share a line and overlap
    if (horizontal(a)) return a.y1 === b.y1 && Math.max(a.x1, a.x2) > Math.min(b.x1, b.x2) && Math.max(b.x1, b.x2) > Math.min(a.x1, a.x2);
    return a.x1 === b.x1 && Math.max(a.y1, a.y2) > Math.min(b.y1, b.y2) && Math.max(b.y1, b.y2) > Math.min(a.y1, a.y2);
  }
  const [h, v] = horizontal(a) ? [a, b] : [b, a];
  const within = (value: number, p: number, q: number) => value >= Math.min(p, q) && value <= Math.max(p, q);
  return within(v.x1, h.x1, h.x2) && within(h.y1, v.y1, v.y2);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the controller map's drawing", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: a chip, a control and a list row for every button group the console has, in the same order`, () => {
      const { el } = mount(platform);
      const groups = [...new Set(BUTTONS_BY_PLATFORM[platform].map((b) => (DPAD.includes(b) ? "dpad" : b)))].sort();
      const chips = [...el.querySelectorAll<HTMLElement>(".loc-pad-callout")].map((c) => c.dataset.group!);
      expect([...chips].sort()).toEqual(groups);
      expect([...el.querySelectorAll<HTMLElement>(".loc-padlist-item")].map((i) => i.dataset.group)).toEqual(chips);
      expect([...el.querySelectorAll<SVGElement>(".loc-pad-ctl")].map((c) => c.dataset.group).sort()).toEqual(groups);
      for (const chip of el.querySelectorAll<HTMLButtonElement>(".loc-pad-callout")) {
        expect(chip.tagName).toBe("BUTTON");
        expect(chip.getAttribute("aria-label")).toMatch(/Trocar tecla$/);
      }
    });

    it(`${platform}: every leader is one straight horizontal or vertical segment, and no two cross`, () => {
      const { el } = mount(platform);
      const segs = leaders(el);
      expect(segs.length).toBe(el.querySelectorAll(".loc-pad-callout").length);
      for (const s of segs) expect(s.x1 === s.x2 || s.y1 === s.y2, `${s.group} is straight`).toBe(true);
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        expect(crosses(segs[i]!, segs[j]!), `${segs[i]!.group} x ${segs[j]!.group}`).toBe(false);
      }
    });
  }

  it("draws the d-pad chip as the four keys of an arrow cluster, and every other chip names its button", () => {
    const { el } = mount("snes");
    const caps = [...el.querySelectorAll<HTMLElement>('.loc-pad-callout[data-group="dpad"] .loc-pad-cluster-key')];
    expect(caps.map((c) => c.dataset.dir)).toEqual(["up", "down", "left", "right"]);
    expect(caps.map((c) => c.textContent)).toEqual(["↑", "↓", "←", "→"]);
    // the picture letters none of its buttons, so the chip says which one it is
    const names = Object.fromEntries([...el.querySelectorAll<HTMLElement>(".loc-pad-callout")].map((c) => [c.dataset.group, c.querySelector(".loc-pad-what")?.textContent ?? null]));
    expect(names).toEqual({ dpad: null, l: "L", r: "R", x: "X", y: "Y", a: "A", b: "B", select: "Select", start: "Start" });
    // the chip's key is the default one
    expect(el.querySelector('.loc-pad-callout[data-group="a"] .loc-pad-key')?.textContent).toBe("Z");
  });

  for (const platform of PLATFORMS) {
    it(`${platform}: the console's own picture, and every hotspot on it (the d-pad's four arms included)`, () => {
      const { el } = mount(platform);
      expect(el.querySelector<HTMLElement>(".loc-padmap")?.dataset.p ?? el.dataset.p).toBe(platform);
      expect(el.querySelector(".loc-pad-pic")).not.toBeNull();
      const art = CONSOLES[platform];
      const pads = [...el.querySelectorAll<SVGElement>(".loc-pad-lit")].map((s) => s.dataset.pad).sort();
      expect(pads).toEqual([...BUTTONS_BY_PLATFORM[platform]].sort());
      // measured on the picture: every hotspot lies inside it
      for (const [pad, hot] of Object.entries(art.hot)) {
        const [x, y, w, h] = boundsOf([hot]);
        expect(x >= 0 && y >= 0 && x + w <= art.art[0] && y + h <= art.art[1], `${platform} ${pad}`).toBe(true);
      }
      // the leaders start on the picture and end outside the hotspot they leave
      for (const seg of leaders(el)) {
        const [px, py, pw] = art.place;
        const ph = (pw * art.art[1]) / art.art[0];
        expect(seg.x1 >= px && seg.x1 <= px + pw && seg.y1 >= py && seg.y1 <= py + ph, `${platform} ${seg.group} starts on the picture`).toBe(true);
        expect(seg.x1 !== seg.x2 || seg.y1 !== seg.y2, `${platform} ${seg.group} has a length`).toBe(true);
      }
    });
  }

  it("has no shoulders on the NES or the Game Boy, and has them on the SNES and the GBA", () => {
    for (const platform of ["nes", "gb"] as const) expect(mount(platform).el.querySelector('[data-group="l"], [data-group="r"]')).toBeNull();
    for (const platform of ["snes", "gba"] as const) expect(mount(platform).el.querySelectorAll('.loc-pad-ctl[data-group="l"], .loc-pad-ctl[data-group="r"]')).toHaveLength(2);
  });

  it("measures where a leader leaves a turned button: the side that faces the chip", () => {
    // a band turned up to the right (SNES L): leaving upwards is the middle of its top side, not its high end
    const [x, y] = edgeToward({ kind: "rect", x: 100, y: 100, w: 100, h: 20, a: -30 }, "up");
    expect(Math.round(x)).toBe(95);
    expect(Math.round(y)).toBe(91);
    expect(edgeToward({ kind: "circle", x: 10, y: 10, r: 5 }, "left")).toEqual([5, 10]);
  });

  it("rings the live button on the drawing while it listens, and only that one", () => {
    const { map, el } = mount("snes");
    expect(el.querySelector(".loc-pad-ring")).toBeNull();
    map.update({ listening: ["a"] });
    expect(el.querySelectorAll(".loc-pad-ring")).toHaveLength(1);
    expect(el.querySelector('.loc-pad-lit[data-pad="a"]')!.classList.contains("is-live")).toBe(true);
    expect(el.querySelector('.loc-pad-ctl[data-group="a"]')!.classList.contains("is-listening")).toBe(true);
    expect(el.querySelector('.loc-pad-callout[data-group="a"] .loc-pad-key')!.textContent).toBe("aperta uma tecla");
    map.update({ listening: [] });
    expect(el.querySelector(".loc-pad-ring")).toBeNull();
  });

  it("rings the d-pad direction being asked for, and marks it on the chip's cluster", () => {
    const { map, el } = mount("nes");
    map.update({ listening: ["left", "right"] });
    expect(el.querySelector('.loc-pad-lit[data-pad="left"]')!.classList.contains("is-live")).toBe(true);
    expect(el.querySelector('.loc-pad-lit[data-pad="up"]')!.classList.contains("is-live")).toBe(false);
    const live = el.querySelector<HTMLElement>(".loc-pad-cluster-key.is-live")!;
    expect(live.dataset.dir).toBe("left");
    expect(live.textContent).toBe("?");
    expect(el.querySelector('.loc-padlist-item[data-group="dpad"] .loc-padlist-what')!.textContent).toBe("Direcional: Esquerda");
  });

  it("lights what a gamepad holds, each d-pad direction on its own", () => {
    const { map, el } = mount("gba");
    map.update({ glow: new Set(["left", "a", "r"]) });
    const glowing = [...el.querySelectorAll<SVGElement>(".loc-pad-lit.is-glowing")].map((s) => s.dataset.pad).sort();
    expect(glowing).toEqual(["a", "left", "r"]);
    map.update({ glow: new Set() });
    expect(el.querySelectorAll(".is-glowing")).toHaveLength(0);
  });

  it("hover or focus on a chip lights its control, its leader and its list row; on the control, its chip", () => {
    const { el } = mount("snes");
    const chip = el.querySelector<HTMLElement>('.loc-pad-callout[data-group="x"]')!;
    chip.dispatchEvent(new Event("pointerover", { bubbles: true }));
    const hot = () => [...el.querySelectorAll<HTMLElement | SVGElement>(".is-hot")].map((n) => `${n.classList[0]}:${n.dataset.group}`).sort();
    expect(hot()).toEqual(["loc-pad-callout:x", "loc-pad-ctl:x", "loc-pad-leader:x", "loc-padlist-item:x"]);
    el.dispatchEvent(new Event("pointerleave"));
    expect(hot()).toEqual([]);
    el.querySelector('.loc-pad-ctl[data-group="dpad"] .loc-pad-lit')!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(hot()).toContain("loc-pad-callout:dpad");
    el.dispatchEvent(new Event("pointerleave"));
    el.querySelector<HTMLElement>('.loc-pad-callout[data-group="b"]')!.focus();
    expect(hot()).toContain("loc-pad-ctl:b");
  });

  it("a click on the control in the drawing starts the same remap its chip does", () => {
    const { el, onRemap } = mount("snes");
    el.querySelector('.loc-pad-ctl[data-group="y"] .loc-pad-lit')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemap).toHaveBeenLastCalledWith(["y"]);
    el.querySelector('.loc-pad-ctl[data-group="dpad"] .loc-pad-lit')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemap).toHaveBeenLastCalledWith(["up", "down", "left", "right"]);
    el.querySelector<HTMLButtonElement>('.loc-pad-callout[data-group="l"]')!.click();
    expect(onRemap).toHaveBeenLastCalledWith(["l"]);
  });

  it("puts no id in the page, so two maps can never clash", () => {
    mount("nes");
    mount("gba");
    expect(document.body.querySelectorAll("[id]")).toHaveLength(0);
  });

  it("gives each list row a crop of the picture at its own button", () => {
    const { el } = mount("gba");
    const glyph = (group: string) => el.querySelector<HTMLElement>(`.loc-padlist-item[data-group="${group}"] .loc-padlist-glyph`)!;
    expect(glyph("a").style.backgroundSize).toMatch(/px/);
    expect(glyph("a").style.backgroundPosition).not.toBe(glyph("b").style.backgroundPosition);
    expect(glyph("dpad").style.backgroundPosition).not.toBe(glyph("a").style.backgroundPosition);
  });

  it("rings only the asked direction on the picture, never the whole d-pad", () => {
    const { map, el } = mount("gb");
    map.update({ listening: ["down"] });
    const ring = el.querySelector(".loc-pad-ring")!;
    // the ring is the arm's own shape (a rectangle), not the round outline around the four arms
    expect(ring.tagName.toLowerCase()).toBe("rect");
    expect(el.querySelectorAll(".loc-pad-ring")).toHaveLength(1);
  });
});
