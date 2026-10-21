/**
 * The controller map (mock 2, SPEC 4.2 and 14): the picture of the console being shown (`src/art/pad-*.webp`,
 * pixel art, never redrawn in code), a hotspot laid over each of its buttons, a keycap chip beside each control
 * saying which key it has, and the listening state on the one being rebound. Click or Enter on a chip (or a click
 * on the button in the picture) asks `onRemap` for that button; the d-pad is one chip, drawn as the four keys of a
 * keyboard's arrow cluster, that asks for its four directions in turn.
 *
 * Coordinates. Each console's hotspots are measured on its picture, in the picture's own pixels (`CONSOLES`), and
 * were checked by drawing every one of them over a screenshot. The picture sits in a box of `W` x `H` units at
 * `place`, the chips and leaders are laid out in those units, and an SVG over the box draws the hotspots with the
 * picture's own transform, so a hotspot lands on its button at every size.
 *
 * Layout. Every chip is anchored by the edge that faces its control and grows away from it, into room nothing
 * else uses, so a longer key ("Enter", "Space") or the listening line never runs into a neighbour; every leader is
 * one straight horizontal or vertical segment from the control's edge to that chip, so no two cross and none
 * crosses a button. The chips are HTML, positioned in the box's units, so their text stays at a real 12 to 13 px
 * whatever the picture is scaled to. Under 560 px the box is cropped to the controller, the chips and leaders go,
 * and the same buttons are a list of 48 px rows, each with a crop of the picture at that button (onboarding.css).
 *
 * It draws and nothing else: keys, rules and the listening session are `keymap.ts`, gamepad polling is
 * `gamepad.ts`, and whoever mounts this feeds both in through `update`.
 */
import type { Strings } from "../i18n";
import { DPAD, dpadIsArrows, keyLabel, type PadButton, type Platform } from "../keymap";
import type { KeyMap } from "../runtime";
import { fill } from "./dom";

export type ControllerMapStrings = Pick<
  Strings,
  | "pad.dpad"
  | "pad.arrows"
  | "pad.button"
  | "pad.change"
  | "pad.listening"
  | "pad.up"
  | "pad.down"
  | "pad.left"
  | "pad.right"
  | "onb.map"
>;

export interface ControllerMapState {
  platform: Platform;
  mapping: KeyMap;
  /** The buttons being listened for, the first is the live one; empty or absent: not listening. */
  listening?: readonly PadButton[];
  /** Buttons a connected gamepad is holding right now. */
  glow?: ReadonlySet<PadButton>;
}

export interface ControllerMapOptions extends ControllerMapState {
  t: ControllerMapStrings;
  /** A chip was clicked, or Enter or Space on it, or its button on the picture: the buttons to listen for. */
  onRemap: (buttons: PadButton[]) => void;
}

export interface ControllerMap {
  /** The picture with its chips and, beside it, the list of the same buttons a narrow pane shows instead. */
  readonly element: HTMLElement;
  /** Redraws what changed. The chip that had focus keeps it. */
  update(state: Partial<ControllerMapState>): void;
  /** Puts the focus on the control for a button group (`dpad`, `a`, ...), whichever of the two layouts is showing. */
  focusGroup(group: string): void;
}

const SVG = "http://www.w3.org/2000/svg";
/** The box's units. Every console uses the same box, so switching tabs never moves what is around it. */
export const W = 720;
export const H = 440;

type Pt = readonly [number, number];
type Attrs = Record<string, string | number | undefined>;

/** A hotspot, in the picture's own pixels: a round button, or a rectangle turned by `a` degrees (clockwise). */
export type Hot = { kind: "circle"; x: number; y: number; r: number } | { kind: "rect"; x: number; y: number; w: number; h: number; a: number };

/**
 * Where a chip goes. `l` / `r`: the chip is left / right of its control, centred on the leader (horizontal), and
 * `edge` is the x of the chip's facing edge. `tl` / `tr` / `bl` / `br`: the chip is above / below and grows left /
 * right from the leader (vertical), and `edge` is the y of its facing edge. `via` is the hotspot the leader starts
 * from (the d-pad's chip leaves from one of its arms).
 */
type Anchor = "l" | "r" | "tl" | "tr" | "bl" | "br";

interface Spot {
  group: string;
  anchor: Anchor;
  edge: number;
  via?: PadButton;
}

export interface ConsoleArt {
  /** The picture's size in pixels. */
  art: readonly [number, number];
  /** Where the picture sits in the box: left, top and width in box units (the height follows the picture). */
  place: readonly [number, number, number];
  /** The controller alone, for the narrow layout's crop: x, y, width, height in box units. */
  crop: readonly [number, number, number, number];
  hot: Readonly<Partial<Record<PadButton, Hot>>>;
  spots: readonly Spot[];
}

const circle = (x: number, y: number, r: number): Hot => ({ kind: "circle", x, y, r });
const rect = (x: number, y: number, w: number, h: number, a = 0): Hot => ({ kind: "rect", x, y, w, h, a });

/* ---- the four pictures, measured ---- */

const NES: ConsoleArt = {
  art: [640, 477],
  place: [140, 60, 440],
  crop: [130, 52, 460, 344],
  hot: {
    up: rect(168, 276, 22, 26, -32),
    down: rect(195, 320, 22, 26, -32),
    left: rect(154, 307, 28, 21, -20),
    right: rect(208, 287, 28, 21, -20),
    select: rect(316, 282, 40, 20, -18),
    start: rect(378, 256, 40, 20, -18),
    b: circle(459, 213, 24),
    a: circle(522, 187, 24),
  },
  spots: [
    { group: "dpad", anchor: "l", edge: 130, via: "left" },
    { group: "b", anchor: "tl", edge: 150 },
    { group: "a", anchor: "tr", edge: 150 },
    { group: "select", anchor: "bl", edge: 396 },
    { group: "start", anchor: "br", edge: 396 },
  ],
};

const SNES: ConsoleArt = {
  art: [640, 428],
  place: [110, 64, 470],
  crop: [100, 56, 490, 330],
  hot: {
    up: rect(165, 207, 24, 30, -25),
    down: rect(193, 288, 24, 30, -25),
    left: rect(138, 259, 30, 24, -25),
    right: rect(220, 234, 30, 24, -25),
    select: rect(305, 235, 46, 18, -57),
    start: rect(363, 215, 46, 18, -57),
    x: circle(487, 99, 24),
    a: circle(553, 127, 24),
    y: circle(449, 158, 24),
    b: circle(520, 190, 24),
    l: rect(106, 134, 110, 22, -30),
    r: rect(440, 28, 120, 22, -14),
  },
  spots: [
    { group: "dpad", anchor: "l", edge: 100, via: "left" },
    { group: "l", anchor: "tl", edge: 112 },
    { group: "r", anchor: "r", edge: 586 },
    { group: "x", anchor: "l", edge: 440 },
    { group: "y", anchor: "l", edge: 414 },
    { group: "a", anchor: "r", edge: 586 },
    { group: "b", anchor: "r", edge: 586 },
    { group: "select", anchor: "bl", edge: 396 },
    { group: "start", anchor: "br", edge: 396 },
  ],
};

const GB: ConsoleArt = {
  art: [520, 747],
  place: [221, 16, 278.5],
  crop: [211, 8, 298.5, 416],
  hot: {
    up: rect(166, 477, 36, 36),
    down: rect(166, 551, 36, 36),
    left: rect(130, 513, 36, 38),
    right: rect(203, 513, 36, 38),
    select: rect(240, 615, 60, 22, -35),
    start: rect(307, 615, 60, 22, -35),
    b: circle(383, 522, 29),
    a: circle(455, 484, 29),
  },
  spots: [
    { group: "dpad", anchor: "l", edge: 205, via: "left" },
    { group: "b", anchor: "tl", edge: 262 },
    { group: "a", anchor: "tr", edge: 240 },
    { group: "select", anchor: "bl", edge: 412 },
    { group: "start", anchor: "br", edge: 412 },
  ],
};

const GBA: ConsoleArt = {
  art: [640, 452],
  place: [100, 52, 490],
  crop: [90, 44, 510, 362],
  hot: {
    up: rect(125, 212, 24, 28),
    down: rect(127, 268, 24, 28),
    left: rect(96, 238, 28, 24, -4),
    right: rect(153, 234, 28, 24, -4),
    start: circle(171, 331, 13),
    select: circle(171, 371, 13),
    a: circle(593, 152, 23),
    b: circle(540, 179, 23),
    l: rect(88, 102, 110, 28, -20),
    r: rect(566, 37, 104, 22, 13),
  },
  spots: [
    { group: "dpad", anchor: "l", edge: 92, via: "left" },
    { group: "l", anchor: "tl", edge: 96 },
    { group: "r", anchor: "tr", edge: 48 },
    { group: "a", anchor: "r", edge: 590 },
    { group: "b", anchor: "tl", edge: 136 },
    { group: "start", anchor: "l", edge: 202 },
    { group: "select", anchor: "bl", edge: 410 },
  ],
};

export const CONSOLES: Readonly<Record<Platform, ConsoleArt>> = { nes: NES, snes: SNES, gb: GB, gba: GBA };

/* ---- geometry ---- */

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The picture's scale in the box: box units per picture pixel. */
export function scaleOf(art: ConsoleArt): number {
  return art.place[2] / art.art[0];
}

/** A point of the picture, in box units. */
export function toBox(art: ConsoleArt, [x, y]: Pt): Pt {
  const s = scaleOf(art);
  return [r1(art.place[0] + x * s), r1(art.place[1] + y * s)];
}

/** The point of a hotspot's edge that faces `dir` (picture pixels): where a leader leaves the button. */
export function edgeToward(hot: Hot, dir: "left" | "right" | "up" | "down"): Pt {
  if (hot.kind === "circle") {
    return dir === "left" ? [hot.x - hot.r, hot.y] : dir === "right" ? [hot.x + hot.r, hot.y] : dir === "up" ? [hot.x, hot.y - hot.r] : [hot.x, hot.y + hot.r];
  }
  // the middle of the side of the turned rectangle that faces `dir` most squarely
  const a = (hot.a * Math.PI) / 180;
  const along: Pt = [Math.cos(a), Math.sin(a)];
  const across: Pt = [-Math.sin(a), Math.cos(a)];
  const want: Pt = dir === "left" ? [-1, 0] : dir === "right" ? [1, 0] : dir === "up" ? [0, -1] : [0, 1];
  const sides: Array<[Pt, number]> = [
    [along, hot.w / 2],
    [[-along[0], -along[1]], hot.w / 2],
    [across, hot.h / 2],
    [[-across[0], -across[1]], hot.h / 2],
  ];
  const [normal, reach] = sides.reduce((best, side) => (side[0][0] * want[0] + side[0][1] * want[1] > best[0][0] * want[0] + best[0][1] * want[1] ? side : best));
  return [hot.x + normal[0] * reach, hot.y + normal[1] * reach];
}

/** A hotspot's bounding box in picture pixels: x, y, width, height. */
export function boundsOf(hots: readonly Hot[]): readonly [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const hot of hots) {
    const ext =
      hot.kind === "circle"
        ? [hot.r, hot.r]
        : (() => {
            const a = (hot.a * Math.PI) / 180;
            const [c, s] = [Math.abs(Math.cos(a)), Math.abs(Math.sin(a))];
            return [(hot.w * c + hot.h * s) / 2, (hot.w * s + hot.h * c) / 2];
          })();
    x0 = Math.min(x0, hot.x - ext[0]!);
    x1 = Math.max(x1, hot.x + ext[0]!);
    y0 = Math.min(y0, hot.y - ext[1]!);
    y1 = Math.max(y1, hot.y + ext[1]!);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The leader's two ends in box units: from the control's facing edge to the chip's facing edge. */
export function leaderOf(art: ConsoleArt, spot: Spot): { from: Pt; to: Pt } {
  const hot = art.hot[(spot.via ?? spot.group) as PadButton]!;
  const dir = spot.anchor === "l" ? "left" : spot.anchor === "r" ? "right" : spot.anchor[0] === "t" ? "up" : "down";
  const from = toBox(art, edgeToward(hot, dir));
  const to: Pt = spot.anchor === "l" || spot.anchor === "r" ? [spot.edge, from[1]] : [from[0], spot.edge];
  return { from, to };
}

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) element.setAttribute(name, String(value));
  for (const child of children) element.append(child);
  return element;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  for (const child of children) element.append(child);
  return element;
}

/** A hotspot as an SVG shape in picture pixels, grown by `pad` on every side. */
function shapeOf(hot: Hot, pad = 0): SVGElement {
  if (hot.kind === "circle") return node("circle", { cx: hot.x, cy: hot.y, r: hot.r + pad });
  const w = hot.w + pad * 2;
  const h = hot.h + pad * 2;
  return node("rect", {
    x: r1(hot.x - w / 2),
    y: r1(hot.y - h / 2),
    width: r1(w),
    height: r1(h),
    rx: r1(Math.min(w, h) / 2.6),
    transform: hot.a ? `rotate(${hot.a} ${hot.x} ${hot.y})` : undefined,
  });
}

/** The d-pad's outline: one circle around its four arms. */
function dpadHalo(arms: readonly Hot[], pad: number): SVGElement {
  const [x, y, w, h] = boundsOf(arms);
  return node("circle", { cx: r1(x + w / 2), cy: r1(y + h / 2), r: r1(Math.max(w, h) / 2 + pad) });
}

export function createControllerMap(options: ControllerMapOptions): ControllerMap {
  const { t } = options;
  let state: ControllerMapState = {
    platform: options.platform,
    mapping: options.mapping,
    listening: options.listening ?? [],
    glow: options.glow ?? new Set(),
  };
  /** The group under the pointer or holding the focus: lit on the picture, its chip and its row together. */
  let hot: string | null = null;

  const root = node("svg", { class: "loc-pad", viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" });
  const picture = html("span", "loc-pad-pic");
  picture.setAttribute("aria-hidden", "true");
  const artBox = html("div", "loc-padart");
  artBox.append(picture, root);
  // a narrow pane: the picture cropped to the controller, and the same buttons as a list of real rows
  const list = html("div", "loc-padlist");
  const wrapper = html("div", "loc-padmap");
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", t["onb.map"]);
  wrapper.append(artBox, list);

  const direction: Record<string, string> = { up: t["pad.up"], down: t["pad.down"], left: t["pad.left"], right: t["pad.right"] };
  const ARROWS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

  function groupOf(button: PadButton): string {
    return DPAD.includes(button) ? "dpad" : button;
  }

  function keyText(group: string): string {
    if (group === "dpad") {
      return dpadIsArrows(state.mapping) ? t["pad.arrows"] : DPAD.map((b) => keyLabel(state.mapping[b] ?? "")).join(" ");
    }
    return keyLabel(state.mapping[group] ?? "");
  }

  function whatText(group: string): string {
    if (group === "dpad") return t["pad.dpad"];
    if (group === "select") return "Select";
    if (group === "start") return "Start";
    if (group === "l" || group === "r") return group.toUpperCase();
    return fill(t["pad.button"], { button: group.toUpperCase() });
  }

  /** The name a chip carries next to its key: the picture letters none of its buttons, so every chip says which. */
  function chipWhat(group: string): string | null {
    if (group === "dpad") return null;
    if (group === "select" || group === "start") return whatText(group);
    return group.toUpperCase();
  }

  /** The d-pad's four keys as a keyboard's arrow cluster: up on top, left, down and right under it. */
  function cluster(className: string, live: PadButton | null): HTMLElement {
    const box = html("span", className);
    box.setAttribute("aria-hidden", "true");
    for (const dir of DPAD) {
      const cap = html("kbd", `${className}-key${live === dir ? " is-live" : ""}`, live === dir ? "?" : keyLabel(state.mapping[dir] ?? "") || ARROWS[dir]!);
      cap.dataset.dir = dir;
      box.append(cap);
    }
    return box;
  }

  /** The hotspots of one control group: the d-pad's four arms, or the one button. */
  function hotsOf(art: ConsoleArt, group: string): Array<[PadButton, Hot]> {
    const pads = group === "dpad" ? DPAD : [group as PadButton];
    return pads.flatMap((pad) => (art.hot[pad] ? [[pad, art.hot[pad]!] as [PadButton, Hot]] : []));
  }

  function draw() {
    const art = CONSOLES[state.platform];
    const live = state.listening?.[0] ?? null;
    const listeningGroup = live ? groupOf(live) : null;
    const s = scaleOf(art);
    const transform = `translate(${art.place[0]} ${art.place[1]}) scale(${r1(s * 10000) / 10000})`;

    // the hotspots, in the picture's own pixels under its transform
    const controls = node("g", { class: "loc-pad-controls", transform });
    const ringLayer = node("g", { class: "loc-pad-ringlayer", transform });
    for (const spot of art.spots) {
      const hots = hotsOf(art, spot.group);
      const g = node("g", { class: `loc-pad-ctl${listeningGroup === spot.group ? " is-listening" : ""}`, "data-group": spot.group });
      const halo = spot.group === "dpad" ? dpadHalo(hots.map(([, h]) => h), 8) : shapeOf(hots[0]![1], 6);
      halo.setAttribute("class", "loc-pad-halo");
      g.append(halo);
      for (const [pad, shape] of hots) {
        const lit = shapeOf(shape, 2);
        lit.setAttribute("class", `loc-pad-lit${live === pad ? " is-live" : ""}`);
        lit.setAttribute("data-pad", pad);
        g.append(lit);
      }
      controls.append(g);
    }
    if (live && art.hot[live]) {
      const still = shapeOf(art.hot[live]!, 5);
      still.setAttribute("class", "loc-pad-ring-still");
      const pulse = shapeOf(art.hot[live]!, 5);
      pulse.setAttribute("class", "loc-pad-ring");
      ringLayer.append(node("g", { class: "loc-pad-rings" }, still, pulse));
    }

    const leaders = node("g", { class: "loc-pad-leaders" });
    const chips: HTMLElement[] = [];
    const items: HTMLElement[] = [];
    for (const spot of art.spots) {
      const { group, anchor } = spot;
      const isLive = listeningGroup === group;
      const what = whatText(group);
      const key = keyText(group);
      const label = fill(t["pad.change"], { what, key });
      const open = () => options.onRemap(group === "dpad" ? [...DPAD] : [group as PadButton]);

      // the leader: one straight segment from the control's edge to the chip's facing edge
      const { from, to } = leaderOf(art, spot);
      leaders.append(
        node(
          "g",
          { class: `loc-pad-leader${isLive ? " is-listening" : ""}`, "data-group": group },
          node("path", { d: `M${from[0]} ${from[1]}L${to[0]} ${to[1]}` }),
          node("circle", { cx: from[0], cy: from[1], r: 2.6 }),
        ),
      );

      const chip = html("button", `loc-pad-callout${group === "dpad" ? " loc-pad-callout-dpad" : ""}${isLive ? " is-listening" : ""}`);
      chip.type = "button";
      chip.dataset.group = group;
      chip.dataset.anchor = anchor;
      chip.style.setProperty("--x", String(to[0]));
      chip.style.setProperty("--y", String(to[1]));
      chip.setAttribute("aria-label", label);
      chip.setAttribute("aria-pressed", isLive ? "true" : "false");
      const chipLabel = chipWhat(group);
      if (chipLabel) chip.append(html("span", "loc-pad-what", chipLabel));
      if (group === "dpad") {
        // the four keys are the picture; the words are there for the listening state (and for a test reading text)
        chip.append(html("span", "loc-pad-key", isLive ? t["pad.listening"] : key), cluster("loc-pad-cluster", isLive ? live : null));
      } else {
        chip.append(html("kbd", "loc-pad-key", isLive ? t["pad.listening"] : key));
      }
      chip.addEventListener("click", open);
      chips.push(chip);

      const item = html("button", `loc-padlist-item${group === "dpad" ? " loc-padlist-item-dpad" : ""}${isLive ? " is-listening" : ""}`);
      item.type = "button";
      item.dataset.group = group;
      item.setAttribute("aria-label", label);
      item.setAttribute("aria-pressed", isLive ? "true" : "false");
      const whatLine = live && isLive && DPAD.includes(live) ? `${what}: ${direction[live] ?? ""}` : what;
      const keyPart = html("span", "loc-padlist-key");
      if (isLive) keyPart.textContent = t["pad.listening"];
      else if (group === "dpad") keyPart.append(cluster("loc-padlist-cluster", null));
      else keyPart.textContent = key;
      item.append(glyph(art, group), html("span", "loc-padlist-what", whatLine), keyPart);
      item.addEventListener("click", open);
      items.push(item);
    }

    const focused = wrapper.querySelector<HTMLElement>(".loc-pad-callout:focus, .loc-padlist-item:focus")?.dataset.group;
    root.replaceChildren(controls, leaders, ringLayer);
    wrapper.dataset.p = state.platform;
    artBox.dataset.p = state.platform;
    // the picture's place in the box, and the crop the narrow layout uses, in box units
    const [px, py, pw] = art.place;
    const ph = (pw * art.art[1]) / art.art[0];
    for (const [name, value] of [
      ["--px", px],
      ["--py", py],
      ["--pw", pw],
      ["--ph", r1(ph)],
      ["--cx", art.crop[0]],
      ["--cy", art.crop[1]],
      ["--cw", art.crop[2]],
      ["--ch", art.crop[3]],
    ] as const) {
      artBox.style.setProperty(name, String(value));
    }
    artBox.replaceChildren(picture, root, ...chips);
    list.replaceChildren(...items);
    if (focused) focusGroup(focused);
    paintHot();
    paintGlow();
  }

  /** The small picture at the start of a list row: the console's own picture, cropped to that control. */
  function glyph(art: ConsoleArt, group: string): HTMLElement {
    const box = html("span", "loc-padlist-glyph");
    box.setAttribute("aria-hidden", "true");
    const hots = hotsOf(art, group).map(([, h]) => h);
    if (hots.length === 0) return box;
    const SIZE = 28;
    const [x, y, w, h] = boundsOf(hots);
    const side = Math.max(w, h) * 1.3;
    const k = SIZE / side;
    box.style.backgroundSize = `${r1(art.art[0] * k)}px ${r1(art.art[1] * k)}px`;
    box.style.backgroundPosition = `${r1(SIZE / 2 - (x + w / 2) * k)}px ${r1(SIZE / 2 - (y + h / 2) * k)}px`;
    return box;
  }

  function focusGroup(group: string) {
    // the chip or the list row, whichever is on screen (the other is display: none, which cannot be focused)
    for (const candidate of wrapper.querySelectorAll<HTMLElement>(`.loc-pad-callout[data-group="${group}"], .loc-padlist-item[data-group="${group}"]`)) {
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  }

  function paintHot() {
    for (const element of wrapper.querySelectorAll<HTMLElement | SVGElement>("[data-group]")) {
      element.classList.toggle("is-hot", hot !== null && element.dataset.group === hot);
    }
  }

  function setHot(group: string | null) {
    if (group === hot) return;
    hot = group;
    paintHot();
  }

  function paintGlow() {
    const glow = state.glow ?? new Set<PadButton>();
    for (const shape of root.querySelectorAll<SVGElement>("[data-pad]")) {
      shape.classList.toggle("is-glowing", glow.has(shape.dataset.pad as PadButton));
    }
  }

  const groupAt = (target: EventTarget | null) => (target instanceof Element ? (target.closest<HTMLElement | SVGElement>("[data-group]")?.dataset.group ?? null) : null);
  // a finger has no hover: a tap would leave its row lit until the next one
  wrapper.addEventListener("pointerover", (event) => {
    if ((event as PointerEvent).pointerType !== "touch") setHot(groupAt(event.target));
  });
  wrapper.addEventListener("pointerleave", () => setHot(groupAt(document.activeElement && wrapper.contains(document.activeElement) ? document.activeElement : null)));
  wrapper.addEventListener("focusin", (event) => setHot(groupAt(event.target)));
  wrapper.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget))) setHot(null);
  });
  // a click on the button itself, on the picture, does what its chip does
  root.addEventListener("click", (event) => {
    const group = event.target instanceof Element ? event.target.closest<SVGElement>(".loc-pad-ctl")?.dataset.group : undefined;
    if (group) options.onRemap(group === "dpad" ? [...DPAD] : [group as PadButton]);
  });

  draw();

  return {
    element: wrapper,
    focusGroup,
    update(next) {
      const redraw =
        (next.platform !== undefined && next.platform !== state.platform) ||
        (next.mapping !== undefined && next.mapping !== state.mapping) ||
        (next.listening !== undefined && next.listening.join() !== (state.listening ?? []).join());
      state = { ...state, ...next };
      if (redraw) draw();
      else if (next.glow !== undefined) paintGlow();
    },
  };
}
