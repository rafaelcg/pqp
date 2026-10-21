/**
 * Contrast, computed from the stylesheets themselves (the UX pass QA measured rendered colours and found a dozen
 * text and icon pairs under 4.5:1 in the light pqp theme). For each pair below the test reads the colour the CSS
 * declares for a selector, resolves its `var()` chain against the host's real tokens (`client/src/index.css`, dark and
 * light) and Locadora's own (`base.css`, with the light scheme's overrides), and asks for 4.5:1 (3:1 for an icon).
 *
 * Reading the declaration out of the CSS is the point: a table of colours written in the test would keep passing
 * while the stylesheet drifted. A pair whose selector or property is no longer in the CSS fails loudly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, here), "utf8");
const hostCss = readFileSync(new URL("../../../client/src/index.css", import.meta.url), "utf8");

/* ---- a small CSS reader ---- */

/** The `{ ... }` body that follows `opener`, braces balanced. */
function blockAfter(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`no "${opener}" in the stylesheet`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error(`unbalanced block after "${opener}"`);
}

function customProperties(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found[match[1]!] = match[2]!.trim().replace(/\s+/g, " ");
  return found;
}

/** The last value `prop` is given for `selector` anywhere in `css` (a selector list counts for each of its members). */
function declared(css: string, selector: string, prop: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let value: string | null = null;
  for (const rule of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1]!.split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const decl = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(rule[2]!);
    if (decl) value = decl[1]!.trim().replace(/\s+/g, " ");
  }
  if (value === null) throw new Error(`"${selector}" has no "${prop}" in the stylesheet`);
  return value;
}

/* ---- colour ---- */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const srgbEncode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const [r, g, bl] = lin.map((v) => clamp01(srgbEncode(clamp01(v)))) as [number, number, number];
  return { r, g, b: bl, a: alpha };
}

function rgbToOklab({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(srgbDecode) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Splits `a, b(c, d), e` at the commas that are not inside parentheses. */
function topLevel(args: string, separator = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "(") depth++;
    else if (args[i] === ")") depth--;
    else if (args[i] === separator && depth === 0) {
      out.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(args.slice(from).trim());
  return out;
}

function parseColor(expression: string, env: Record<string, string>, depth = 0): Rgba {
  if (depth > 20) throw new Error(`too deep: ${expression}`);
  const text = expression.trim();
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(text);
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (text.startsWith("#")) {
    const hex = text.length === 4 ? [...text.slice(1)].map((c) => c + c).join("") : text.slice(1);
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255, a: 1 };
  }
  if (!fn) throw new Error(`cannot read the colour "${expression}"`);
  const [, name, args] = fn as unknown as [string, string, string];
  if (name === "var") {
    const [custom, ...fallback] = topLevel(args);
    const value = env[custom!];
    if (value !== undefined) return parseColor(value, env, depth + 1);
    if (fallback.length === 0) throw new Error(`${custom} is not defined`);
    return parseColor(fallback.join(","), env, depth + 1);
  }
  if (name === "rgb" || name === "rgba") {
    const parts = topLevel(args);
    const [r, g, b] = parts.slice(0, 3).map((p) => Number(p) / 255) as [number, number, number];
    return { r, g, b, a: parts[3] === undefined ? 1 : Number(parts[3]) };
  }
  if (name === "oklch") {
    const [color, alpha] = args.split("/").map((s) => s.trim()) as [string, string | undefined];
    const [L, C, H] = color.split(/\s+/).map(Number) as [number, number, number];
    const hue = (H * Math.PI) / 180;
    return oklabToRgb(L, C * Math.cos(hue), C * Math.sin(hue), alpha === undefined ? 1 : Number(alpha));
  }
  if (name === "color-mix") {
    const [space, first, second] = topLevel(args) as [string, string, string];
    if (space !== "in oklab" && space !== "in srgb") throw new Error(`color-mix ${space} is not modelled`);
    const read = (part: string) => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/s.exec(part)!;
      return { color: parseColor(m[1]!, env, depth + 1), pct: m[2] === undefined ? null : Number(m[2]) };
    };
    const one = read(first);
    const two = read(second);
    const p1 = (one.pct ?? (two.pct === null ? 50 : 100 - two.pct)) / 100;
    if (space === "in srgb") {
      // premultiplied, as CSS mixes: a colour mixed with `transparent` keeps its hue and loses only alpha
      const a = one.color.a * p1 + two.color.a * (1 - p1);
      const mixed = (k: "r" | "g" | "b") => (a === 0 ? 0 : (one.color[k] * one.color.a * p1 + two.color[k] * two.color.a * (1 - p1)) / a);
      return { r: mixed("r"), g: mixed("g"), b: mixed("b"), a };
    }
    const x = rgbToOklab(one.color);
    const y = rgbToOklab(two.color);
    return oklabToRgb(x[0] * p1 + y[0] * (1 - p1), x[1] * p1 + y[1] * (1 - p1), x[2] * p1 + y[2] * (1 - p1), one.color.a * p1 + two.color.a * (1 - p1));
  }
  throw new Error(`cannot read the colour "${expression}"`);
}

const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (k: "r" | "g" | "b") => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / (a || 1);
  return { r: mix("r"), g: mix("g"), b: mix("b"), a };
};

/** Layers from the top down, composited into one opaque colour (black under the last, should it not be opaque). */
function flatten(layers: readonly string[], tokens: Record<string, string>): Rgba {
  return layers.reduceRight<Rgba>((below, layer) => over(parseColor(layer, tokens), below), { r: 0, g: 0, b: 0, a: 1 });
}

const luminance = ({ r, g, b }: Rgba) => 0.2126 * srgbDecode(r) + 0.7152 * srgbDecode(g) + 0.0722 * srgbDecode(b);

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---- the two themes, as the host defines them, and Locadora's tokens on top ---- */

const base = read("./styles/base.css");
const hostDark = customProperties(blockAfter(hostCss, "@theme static"));
const hostLight = { ...hostDark, ...customProperties(blockAfter(hostCss, ':root[data-theme="light"] {')) };
const own = customProperties(blockAfter(base, ":root {"));
const lightScheme = customProperties(blockAfter(base, ':root[data-scheme="light"]'));

/** Host token `--color-x` as the `--loc-*` the app reads it through (`base.css` aliases them with fallbacks). */
function env(host: Record<string, string>, light: boolean): Record<string, string> {
  const resolved: Record<string, string> = { ...host, ...own };
  if (light) Object.assign(resolved, lightScheme);
  return resolved;
}

/** The light theme as an old or odd host might send it: the status colours left at their dark values. */
const hostLightStale = { ...hostLight, "--color-warning": hostDark["--color-warning"]!, "--color-success": hostDark["--color-success"]!, "--color-danger": hostDark["--color-danger"]! };

const ENVS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["dark", env(hostDark, false)],
  ["light", env(hostLight, true)],
  ["light, status colours as dark", env(hostLightStale, true)],
];

/* ---- the pairs ---- */

interface Pair {
  what: string;
  file: string;
  selector: string;
  prop?: string;
  /** What it sits on: a colour expression, resolved in the same theme. */
  on: string;
  /** The ratio to reach: 4.5 for text, 3 for an icon or large text. */
  min?: number;
  /**
   * What `on` lies over when it is not opaque, each a stack of layers from the top down, the last one opaque. Every
   * stack must pass. Default: black. The Balcão's room is a picture, so its stacks end in WHITE: the brightest pixel
   * the art could put there.
   */
  under?: readonly (readonly string[])[];
}

const WALL = "#0b0d12";
/** The room at its lightest (the scrim's open middle over a white pixel) and at its darkest. */
const ROOM: readonly (readonly string[])[] = [["var(--loc-scrim-low)", "#ffffff"], ["#000000"]];
/** Behind the top bar and at the foot of the room, where the scrim is closed. */
const ROOM_TOP: readonly (readonly string[])[] = [["var(--loc-scrim-top)", "#ffffff"], ["#000000"]];
/** The shelf's cabinet, over the room. */
const CABINET: readonly (readonly string[])[] = [["var(--loc-shelf-panel)", "var(--loc-scrim-low)", "#ffffff"], ["#000000"]];
const STAGE_PANEL = "#0e1016";
/**
 * The load overlay's room: shop-interior.webp at 70% of its light (`.loc-load-bg::before`, so its brightest pixel is
 * #b3b3b3), under the scrim's open middle (`.loc-load-bg::after`). A test below reads both numbers out of flow.css.
 */
const LOAD_SCRIM = "rgba(8, 9, 13, 0.62)";
const LOAD_ROOM: readonly (readonly string[])[] = [["#b3b3b3"], ["#000000"]];
/** The "Continuar de onde parou?" card's glass. */
const LOAD_GLASS = "rgba(14, 16, 22, 0.88)";

const PAIRS: Pair[] = [
  { what: "Continuar's eyebrow", file: "shelf.css", selector: ".loc-eyebrow", on: "var(--loc-glass)", under: ROOM },
  { what: "the first visit's eyebrow ('Passo N de 2')", file: "onboarding.css", selector: ".loc-onb-eyebrow", on: "var(--loc-card)" },
  { what: "a quiet button on the controller stage ('Voltar ao padrão')", file: "onboarding.css", selector: ".loc-onb-stage .loc-onb-btn-quiet", on: STAGE_PANEL },
  { what: "a ghost button on the controller stage ('Cancelar')", file: "onboarding.css", selector: ".loc-onb-stage .loc-onb-btn-ghost", on: STAGE_PANEL },
  { what: "the note under the controller", file: "onboarding.css", selector: ".loc-onb-note", on: STAGE_PANEL },
  { what: "a finished step's number on the rail", file: "onboarding.css", selector: ".loc-onb-steps li.is-done .loc-onb-n", on: "#12141b" },
  { what: "the current step's number on the rail", file: "onboarding.css", selector: '.loc-onb-steps li[aria-current="step"] .loc-onb-n', on: "var(--loc-wall-accent)" },
  { what: "the rail's other step numbers", file: "onboarding.css", selector: ".loc-onb-steps li", on: "#12141b" },
  { what: "a listed controller button's label", file: "onboarding.css", selector: ".loc-padlist-what", on: "#1c2029" },
  { what: "a listed controller button's key", file: "onboarding.css", selector: ".loc-padlist-item", on: "#1c2029" },
  { what: "a listed button's keycap (on its lighter top)", file: "onboarding.css", selector: ".loc-padlist-key", on: "#343a47" },
  { what: "the d-pad's keys in the list", file: "onboarding.css", selector: ".loc-padlist-cluster-key", on: "#343a47" },
  { what: "a list row while it listens", file: "onboarding.css", selector: ".loc-padlist-item.is-listening .loc-padlist-key", on: "#2a1424" },
  { what: "a chip on the controller map", file: "onboarding.css", selector: ".loc-pad-callout", on: "#181b22" },
  { what: "a chip's label (Select, Start, L, R)", file: "onboarding.css", selector: ".loc-pad-what", on: "#181b22" },
  { what: "a chip's keycap (on its lighter top)", file: "onboarding.css", selector: ".loc-pad-key", on: "#343a47" },
  { what: "the d-pad chip's keycaps", file: "onboarding.css", selector: ".loc-pad-cluster-key", on: "#343a47" },
  { what: "a chip while it listens ('aperta uma tecla')", file: "onboarding.css", selector: ".loc-pad-callout.is-listening:not(.loc-pad-callout-dpad) .loc-pad-key", on: "#2a1424" },
  { what: "the d-pad direction being listened for", file: "onboarding.css", selector: ".loc-pad-cluster-key.is-live", on: "var(--loc-neon-pink)" },
  // the art pass (locadora/art-onboarding): text set over the pixel art, each on the colour sampled from the art under it
  { what: "the house name inside the rail's neon sign (neon-sign.webp, its dark interior)", file: "onboarding.css", selector: ".loc-onb-neon", on: "#211f2c" },
  { what: "'ABERTO' under the sign", file: "onboarding.css", selector: ".loc-onb-open", on: "#12141b" },
  { what: "a cartridge's title on its label (cart-blank.webp)", file: "onboarding.css", selector: ".loc-ins-title", on: "#e4d1af" },
  { what: "a cartridge's title on its label (cart-gb.webp)", file: "onboarding.css", selector: ".loc-ins-title", on: "#dbc4b7" },
  { what: "'Botar fita' on the console's stage, second screen", file: "onboarding.css", selector: ".loc-onb-pick .loc-onb-btn-primary", on: "var(--loc-wall-accent)" },
  // the console's stage: shop-interior.webp at 30% of its light (its brightest pixel, #4d4d4d, taken to #606060 for the
  // saturation), under the stage's scrim at its lightest end (0.45) and the pink glow at its strongest
  { what: "the title over the console", file: "onboarding.css", selector: ".loc-onb-pick-title", on: "rgba(255, 95, 200, 0.16)", under: [["rgba(11, 13, 18, 0.45)", "#606060"], ["#000000"]] },
  { what: "the sentence over the console", file: "onboarding.css", selector: ".loc-onb-pick-body", on: "rgba(255, 95, 200, 0.16)", under: [["rgba(11, 13, 18, 0.45)", "#606060"], ["#000000"]] },
  { what: "the listening line under the controller", file: "onboarding.css", selector: ".loc-onb-listen", on: STAGE_PANEL },
  { what: "a chip's name while it listens", file: "onboarding.css", selector: ".loc-pad-callout.is-listening .loc-pad-what", on: "#2a1424" },
  { what: "the 'Aprovado' stamp on Regras da casa", file: "shelf.css", selector: ".loc-rules-stamp", on: "var(--loc-glass)", under: ROOM },
  { what: "the rules' check icons", file: "shelf.css", selector: ".loc-rules-list svg", on: "var(--loc-glass)", under: ROOM, min: 3 },
  { what: "the Ficha's eyebrow", file: "shelf.css", selector: ".loc-ficha-eyebrow", on: "var(--loc-glass-raised)", under: CABINET },
  { what: "'Tirar da prateleira' on the Ficha", file: "shelf.css", selector: ".loc-ficha .loc-button-danger-text", on: "var(--loc-glass-raised)", under: CABINET },
  { what: "the danger button", file: "shelf.css", selector: ".loc-button-danger", on: "var(--loc-danger-solid)" },
  { what: "a primary button (and the N cap on it)", file: "base.css", selector: ".loc-button", on: "var(--loc-accent)" },
  { what: "a quiet button on a card (the name field's 'Pular')", file: "base.css", selector: ".loc-nameprompt .loc-button-quiet", on: "var(--loc-card)" },
  { what: "the drawer's check mark", file: "slots.css", selector: ".loc-slots-tick", on: "var(--loc-bg)" },
  { what: "the drawer's warning line", file: "slots.css", selector: ".loc-slot-warn", on: "var(--loc-card)" },
  { what: "the drawer's delete item", file: "slots.css", selector: ".loc-menu-delete", on: "var(--loc-raised)" },
  { what: "the drawer's sync chip", file: "slots.css", selector: ".loc-slots-chip", on: "var(--loc-card)" },
  { what: "the sync chip when the account does not answer", file: "slots.css", selector: ".loc-slots-chip[data-state=\"error\"]", on: "var(--loc-card)" },
  { what: "the line that says what goes to the account", file: "slots.css", selector: ".loc-slots-sync-note", on: "var(--loc-card)" },
  { what: "'Apagar tudo da conta?' asked", file: "slots.css", selector: ".loc-slots-confirm p", on: "color-mix(in oklab, var(--loc-danger) 7%, var(--loc-card))" },
  { what: "the drawer's Apagar on that question", file: "slots.css", selector: ".loc-slots-drawer .loc-mini-danger", on: "var(--loc-danger-solid)" },
  { what: "the conflict sheet's slot name", file: "flow.css", selector: ".loc-conflict-eyebrow", on: "var(--loc-card)" },
  { what: "where and when each side of a conflict was saved", file: "flow.css", selector: ".loc-conflict-card figcaption", on: "var(--loc-raised)" },
  { what: "'no empty slot' under the conflict's choices", file: "flow.css", selector: ".loc-conflict-note", on: "var(--loc-card)" },
  { what: "the drawer's text", file: "slots.css", selector: ".loc-slot-detail", on: "var(--loc-card)" },
  { what: "the HUD bar's 'Salvar'", file: "hud.css", selector: ".loc-hb-primary", on: "#2a3020" },
  { what: "the HUD bar's other buttons", file: "hud.css", selector: ".loc-hb", on: "#303136" },
  { what: "a toast's action", file: "hud.css", selector: ".loc-toast-action", on: "#303136" },
  { what: "the pause card's button", file: "hud.css", selector: ".loc-pause-resume", on: "var(--loc-wall-accent)" },
  { what: "the screen menu's text", file: "stage.css", selector: ".loc-menu", on: "#0e1016" },
  { what: "the screen menu's chosen item", file: "stage.css", selector: ".loc-menu-item[aria-checked=\"true\"]", on: "#1d2418" },
  { what: "the 'Mais' menu's text", file: "hud.css", selector: ".loc-more-menu", on: "#0e1016" },
  { what: "the wall's own text", file: "base.css", selector: "body", on: WALL },
  // the art pass (qa-fix-art): the problem card, the receipt, the empty shelf, the load error, the export dialog
  { what: "the problem card's headline", file: "base.css", selector: ".loc-problem-title", on: "color-mix(in oklab, var(--loc-danger) 9%, var(--loc-card))" },
  { what: "the problem card's hint", file: "base.css", selector: ".loc-problem-hint", on: "color-mix(in oklab, var(--loc-danger) 9%, var(--loc-card))" },
  { what: "the problem card's close icon", file: "base.css", selector: ".loc-problem-close", on: "color-mix(in oklab, var(--loc-danger) 9%, var(--loc-card))", min: 3 },
  { what: "the problem card's '!' badge", file: "base.css", selector: ".loc-problem-badge", on: "var(--loc-danger-solid)", min: 3 },
  { what: "the empty shelf's line about the consoles", file: "shelf.css", selector: ".loc-empty-sub", on: "var(--loc-shelf-panel)", under: ROOM },
  { what: "the empty shelf's headline", file: "shelf.css", selector: ".loc-empty-text .loc-empty-line", on: "var(--loc-shelf-panel)", under: ROOM },
  { what: "'falta a fita' on its strip of tape", file: "shelf.css", selector: '.loc-box[data-missing="true"] .loc-box-sticker', on: "#efe3bf" },
  { what: "the load error's text", file: "flow.css", selector: ".loc-load-error", on: "#22161a" },
  // the load overlay (polish-insert): the room out of focus under a scrim, measured at the room's brightest
  { what: "the load overlay's title", file: "flow.css", selector: ".loc-load", on: LOAD_SCRIM, under: LOAD_ROOM },
  { what: "'Lendo a fita', the step before the overlay, on the same room", file: "flow.css", selector: ".loc-loading .loc-load-status", on: LOAD_SCRIM, under: LOAD_ROOM },
  { what: "the console's name chip under the title", file: "flow.css", selector: ".loc-load-sub", on: "rgba(255, 255, 255, 0.06)", under: [[LOAD_SCRIM, ...LOAD_ROOM[0]!], ["#000000"]] },
  { what: "a step of the stepper ('Lendo a fita', done or still to come)", file: "flow.css", selector: ".loc-load-step", on: LOAD_SCRIM, under: LOAD_ROOM },
  { what: "the step in progress", file: "flow.css", selector: '.loc-load-step[data-state="active"]', on: LOAD_SCRIM, under: LOAD_ROOM },
  { what: "'Aperta Start pra começar'", file: "flow.css", selector: ".loc-load-press", on: LOAD_SCRIM, under: LOAD_ROOM },
  { what: "'Voltar' in the corner", file: "flow.css", selector: ".loc-load-back", on: "rgba(8, 9, 13, 0.6)", under: [[LOAD_SCRIM, ...LOAD_ROOM[0]!], ["#000000"]] },
  { what: "the big Start (and Continuar)", file: "flow.css", selector: ".loc-start", on: "var(--loc-wall-accent)" },
  { what: "a quiet button on the room ('Começar do zero')", file: "flow.css", selector: ".loc-start-quiet", on: "rgba(255, 255, 255, 0.04)", under: [[LOAD_GLASS, LOAD_SCRIM, ...LOAD_ROOM[0]!], [LOAD_SCRIM, ...LOAD_ROOM[0]!], ["#000000"]] },
  { what: "'Continuar de onde parou?' on its card", file: "flow.css", selector: ".loc-load-continue", on: LOAD_GLASS, under: [[LOAD_SCRIM, ...LOAD_ROOM[0]!], ["#000000"]] },
  { what: "the autosave's age on the card", file: "flow.css", selector: ".loc-load-continue .loc-muted", on: LOAD_GLASS, under: [[LOAD_SCRIM, ...LOAD_ROOM[0]!], ["#000000"]] },
  { what: "a watcher's lead line", file: "base.css", selector: ".loc-watch .loc-lead", on: "var(--loc-card)" },
  // the art pass (qa-art-shelf): the Balcão is a picture now, so every line on it is measured over its brightest pixel
  { what: "Continuar's title and text, on the glass", file: "shelf.css", selector: ".loc-continue", on: "var(--loc-glass)", under: ROOM },
  { what: "Continuar's console and autosave line", file: "shelf.css", selector: ".loc-continue .loc-muted", on: "var(--loc-glass)", under: ROOM },
  { what: "the 'Autosave · agora' tag on the TV", file: "shelf.css", selector: ".loc-continue-badge", on: "rgba(10, 12, 16, 0.86)", under: ROOM },
  { what: "the rules, on the glass", file: "shelf.css", selector: ".loc-rules-list li", on: "var(--loc-glass)", under: ROOM },
  { what: "the rules' heading", file: "shelf.css", selector: ".loc-rules-title", on: "var(--loc-glass)", under: ROOM },
  { what: "the sign's line, over the room", file: "shelf.css", selector: ".loc-sign-sub", on: "var(--loc-scrim-top)", under: [["#ffffff"], ["#000000"]] },
  { what: "the storage meter, over the room", file: "shelf.css", selector: ".loc-meter", on: "var(--loc-scrim-top)", under: [["#ffffff"], ["#000000"]] },
  { what: "what the account holds ('Na conta: 2 KB de 8 MB'), under the meter", file: "shelf.css", selector: ".loc-cloud", on: "var(--loc-scrim-top)", under: [["#ffffff"], ["#000000"]] },
  { what: "'Conta sem resposta · Tentar de novo', in amber, under the meter", file: "shelf.css", selector: '.loc-cloud[data-state="unreachable"]', on: "var(--loc-scrim-top)", under: [["#ffffff"], ["#000000"]] },
  { what: "the cloud icon next to it", file: "shelf.css", selector: ".loc-cloud svg", on: "var(--loc-scrim-top)", under: [["#ffffff"], ["#000000"]], min: 3 },
  // "Exportar pra arquivo": the lead, the two choices (ticked and not), the account note and the privacy line
  { what: "the export dialog's lead", file: "flow.css", selector: ".loc-export__lead", on: "var(--loc-card)" },
  { what: "a choice's name in the export dialog", file: "flow.css", selector: ".loc-export__choice", on: "var(--loc-bg)" },
  { what: "the ticked choice's name", file: "flow.css", selector: ".loc-export__choice", on: "color-mix(in oklab, var(--loc-accent) 8%, var(--loc-bg))" },
  { what: "what a choice is and how big (not ticked)", file: "flow.css", selector: ".loc-export__hint", on: "var(--loc-bg)" },
  { what: "what a choice is and how big (ticked)", file: "flow.css", selector: ".loc-export__hint", on: "color-mix(in oklab, var(--loc-accent) 8%, var(--loc-bg))" },
  { what: "the account note in the export dialog ('Teus saves já vão pra tua conta...')", file: "flow.css", selector: ".loc-export__cloud", on: "color-mix(in oklab, var(--loc-success) 9%, var(--loc-card))" },
  { what: "the 'file is the only way' note", file: "flow.css", selector: ".loc-export__cloud", on: "var(--loc-card)" },
  { what: "the export dialog's privacy line and the import lead", file: "flow.css", selector: ".loc-export__note", on: "var(--loc-card)" },
  { what: "a quiet button on the room ('Ver a recepção de novo')", file: "base.css", selector: ".loc-button-quiet", on: "var(--loc-scrim-top)", under: ROOM_TOP },
  { what: "the top bar's icons", file: "shelf.css", selector: ".loc-iconbtn", on: "var(--loc-scrim-top)", under: ROOM_TOP, min: 3 },
  // the icon's name under it on hover and focus ("Ver a recepção de novo", "Controles"...): the HUD's glass over the room
  { what: "an icon button's tooltip", file: "shelf.css", selector: ".loc-iconbtn[data-tip]::after", on: "var(--loc-hud)", under: ROOM_TOP },
  // the meter's short line ("18 MB de 512 MB") is the meter's own colour; the cartridge's console tab is white on its ribbon
  { what: "a console's name on its cartridge tab", file: "shelf.css", selector: ".loc-cart > .loc-cart-ribbon", on: "#4b3a86" },
  { what: "the cabinet's own text ('Tua prateleira')", file: "shelf.css", selector: ".loc-shelfview", on: "var(--loc-shelf-panel)", under: ROOM },
  { what: "a filter chip", file: "shelf.css", selector: ".loc-chip", on: "rgba(255, 255, 255, 0.04)", under: CABINET },
  { what: "a chip's count", file: "shelf.css", selector: ".loc-chip-n", on: "rgba(255, 255, 255, 0.04)", under: CABINET },
  { what: "the sort's label", file: "shelf.css", selector: ".loc-sort", on: "var(--loc-shelf-panel)", under: ROOM },
  { what: "the sort's select", file: "shelf.css", selector: ".loc-select", on: "rgba(255, 255, 255, 0.05)", under: CABINET },
  { what: "the keys line under the shelf", file: "shelf.css", selector: ".loc-hint-line", on: "var(--loc-shelf-panel)", under: ROOM },
  { what: "a notice on the shelf ('Tá quase cheio')", file: "shelf.css", selector: ".loc-notice", on: "rgba(255, 255, 255, 0.06)", under: CABINET },
  // the ghost cartridge is the blank sprite at 18% (its cream label is its lightest part) under the words
  { what: "'Botar outra fita' over its ghost cartridge", file: "shelf.css", selector: ".loc-ghost", on: "rgba(240, 225, 190, 0.18)", under: CABINET },
  { what: "the Ficha's text, on the glass", file: "shelf.css", selector: ".loc-ficha", on: "var(--loc-glass-raised)", under: CABINET },
];

/*
 * The cartridges' labels are the art's, tinted per console: these are the label colours as drawn, sampled from a
 * render at 2x (the median of the label, darkened by an eighth so a worn corner counts), not anything the CSS says.
 */
const LABELS: Readonly<Record<string, string>> = {
  nes: "#c4c1ba",
  snes: "#c9b79f",
  gb: "#c8c4c2",
  gbc: "#95b8b5",
  gba: "#9ca8c4",
};

describe("the cartridges' printing", () => {
  const sheet = read("./styles/shelf.css");
  const tokens = ENVS[0]![1];
  const perPlatform = (platform: string, name: string) => {
    try {
      return declared(sheet, `.loc-cart[data-platform="${platform}"]`, name);
    } catch {
      return declared(sheet, ".loc-cart", name);
    }
  };
  for (const [platform, label] of Object.entries(LABELS)) {
    it(`${platform}: the title's ink reaches 4.5:1 on its label`, () => {
      const ink = parseColor(perPlatform(platform, "--cart-ink"), tokens);
      expect(contrastRatio(ink, parseColor(label, tokens))).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const platform of ["nes", "snes"]) {
    it(`${platform}: the console's name reaches 4.5:1 on its ribbon`, () => {
      const ink = parseColor(declared(sheet, ".loc-cart > .loc-cart-ribbon", "color"), tokens);
      expect(contrastRatio(ink, parseColor(perPlatform(platform, "--cart-ribbon"), tokens))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the room's scrim", () => {
  const sheet = read("./styles/shelf.css");
  const alpha = (expression: string) => parseColor(expression, ENVS[0]![1]).a;

  it("is never lighter than --loc-scrim-low, the colour every line on the room is measured over", () => {
    const low = alpha("var(--loc-scrim-low)");
    const backdrop = /\.loc-backdrop::after\s*\{([^}]*)\}/.exec(sheet.replace(/\/\*[\s\S]*?\*\//g, ""))![1]!;
    const stops = [...backdrop.matchAll(/var\(--loc-scrim-[a-z]+\)/g)].map((m) => m[0]);
    expect(stops.length).toBeGreaterThan(2);
    for (const stop of stops) expect(alpha(stop), stop).toBeGreaterThanOrEqual(low);
    // and the top bar's band is the closed one
    expect(backdrop).toMatch(/var\(--loc-scrim-top\) 0,\s*var\(--loc-scrim-top\) 150px/);
  });
});

describe("contrast of the text and icon pairs the light theme broke", () => {
  for (const [theme, tokens] of ENVS) {
    describe(theme, () => {
      for (const pair of PAIRS) {
        it(`${pair.what} reaches ${pair.min ?? 4.5}:1`, () => {
          const css = read(`./styles/${pair.file}`);
          const fgExpression = declared(css, pair.selector, pair.prop ?? "color");
          const fg = parseColor(fgExpression, tokens);
          for (const stack of pair.under ?? [["#000000"]]) {
            const bg = flatten([pair.on, ...stack], tokens);
            expect(contrastRatio(fg, bg), `${pair.what}: ${fgExpression} on ${pair.on} over ${stack.join(" over ")}`).toBeGreaterThanOrEqual(pair.min ?? 4.5);
          }
        });
      }
    });
  }

  it("reads the host's real light theme (the numbers above are not about a made-up one)", () => {
    expect(hostLight["--color-surface-1"]).toBe("oklch(0.955 0.006 95)");
    expect(hostDark["--color-surface-1"]).toBe("oklch(0.2 0.014 250)");
    expect(lightScheme["--loc-warning-text"]).toBeDefined();
  });

  it("sets no letter over the controller pictures: the art carries none, the chips name the buttons", () => {
    expect(read("./styles/onboarding.css")).not.toContain(".loc-pad-letter");
    expect(read("./ui/controller-map.ts")).not.toContain("loc-pad-letter");
  });

  it("gives the cartridge label a dark ink, well clear of the cream of both sprites", () => {
    const tokens = ENVS[0]![1];
    const ink = parseColor(declared(read("./styles/onboarding.css"), ".loc-ins-title", "color"), tokens);
    for (const cream of ["#e4d1af", "#dbc4b7"]) expect(contrastRatio(ink, parseColor(cream, tokens))).toBeGreaterThan(7);
  });

  it("measures the load overlay over the room flow.css really draws: the art's light, the scrim, the card's glass", () => {
    const flow = read("./styles/flow.css");
    const filter = declared(flow, ".loc-load-bg::before", "filter");
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(filter)![1]);
    // the brightest pixel the pairs assume is a white at this brightness: a brighter room needs new numbers
    expect(Math.round(brightness * 255).toString(16)).toBe("b3");
    expect(declared(flow, ".loc-load-bg::after", "background")).toMatch(/rgba\(8, 9, 13, 0\.62\)$/);
    expect(declared(flow, ".loc-load-continue", "background")).toBe(LOAD_GLASS);
  });

  it("knows a bad pair when it sees one (white-ish on a pale card)", () => {
    const tokens = ENVS[1]![1];
    expect(contrastRatio(parseColor("#f0ede4", tokens), parseColor("var(--loc-card)", tokens))).toBeLessThan(1.3);
  });
});
