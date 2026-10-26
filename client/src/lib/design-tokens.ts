/**
 * The list of role tokens the token sheet draws, and the colour maths it needs
 * to score them.
 *
 * WHY THE MATHS IS COPIED RATHER THAN IMPORTED. `bench/lib/color.mjs` holds the
 * same two functions and is the source the contrast ratchet runs on, but it
 * lives outside `src/` and outside the client's tsconfig, so the bundle cannot
 * reach it. The copy is small, dependency-free and pinned by the same WCAG
 * definition; if one of them changes, change both.
 *
 * NOTHING HERE NAMES A COLOUR. Every value is read from the live document with
 * `getComputedStyle`, which is also the only way the page can score the theme
 * the viewer actually has on. A hard-coded sample value would be a second
 * palette to keep in sync, and the bench's leak gate would count it.
 */

export interface TokenGroup {
  /** Suffix of the `qaUi.group.*` message key. */
  id: string;
  tokens: readonly string[];
}

/**
 * Every role token in the `@theme static` block, minus the deprecated aliases
 * and the third-party connection marks. The order is the order of the block.
 */
export const COLOR_TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: "surfaces",
    tokens: [
      "--color-surface-0",
      "--color-surface-1",
      "--color-surface-2",
      "--color-surface-3",
      "--color-rail",
      "--color-surface-card",
      // The redesign's shell (docs/redesign/LOG.md): the frame the panes float
      // on, and the two panes.
      "--color-canvas",
      "--color-pane-side",
      "--color-pane-main",
    ],
  },
  { id: "borders", tokens: ["--color-border", "--color-border-strong"] },
  {
    id: "text",
    // Loudest first. `--color-text-muted` and `--color-text-subtle` still
    // resolve as aliases and are deliberately not drawn: the sheet is the
    // reference, and a deprecated name on it is a recommendation.
    tokens: ["--color-text", "--color-text-secondary", "--color-text-tertiary"],
  },
  {
    id: "accent",
    tokens: [
      "--color-accent",
      "--color-accent-hover",
      "--color-on-accent",
      "--color-accent-text",
    ],
  },
  {
    id: "status",
    tokens: [
      "--color-danger",
      "--color-on-danger",
      "--color-warning",
      "--color-success",
      "--color-success-text",
    ],
  },
  {
    id: "rows",
    tokens: ["--color-row-hover", "--color-row-selected", "--color-on-row-selected"],
  },
  {
    id: "mention",
    tokens: [
      "--color-mention-row",
      "--color-mention-bar",
      "--color-mention-chip",
      "--color-on-mention-chip",
    ],
  },
  {
    id: "tooltip",
    tokens: [
      "--color-tooltip",
      "--color-tooltip-border",
      "--color-on-tooltip",
      "--color-tooltip-detail",
    ],
  },
  { id: "code", tokens: ["--color-code-bg", "--color-code-text"] },
  { id: "media", tokens: ["--color-on-media", "--color-on-media-muted"] },
  {
    id: "state",
    tokens: [
      "--color-focus-ring",
      "--color-ring-offset",
      "--color-selection",
      "--color-indicator",
    ],
  },
];

/**
 * The soft fills and the foreground each one carries. Drawn as a chip rather
 * than as two swatches: an `--color-on-*-soft` scored against surface-0 is a
 * number with no meaning, because it never sits there. The pair's own ratio is
 * the one that matters, and it is the one the bench pins at 4.5.
 */
export interface SoftPair {
  /** React key for the chip. The sheet's only soft-fill string is fixed. */
  id: string;
  fill: string;
  on: string;
  /** The hovered fill, where the role has one. Same foreground, same floor. */
  hover?: string;
}

export const SOFT_PAIRS: readonly SoftPair[] = [
  { id: "accent", fill: "--color-accent-soft", on: "--color-on-accent-soft" },
  {
    id: "danger",
    fill: "--color-danger-soft",
    on: "--color-on-danger-soft",
    hover: "--color-danger-soft-hover",
  },
  { id: "warning", fill: "--color-warning-soft", on: "--color-on-warning-soft" },
  { id: "success", fill: "--color-success-soft", on: "--color-on-success-soft" },
];

/** The radius roles, lowest first. */
export const RADIUS_TOKENS = [
  "--radius-tick",
  "--radius-control",
  "--radius-card",
  "--radius-panel",
  "--radius-pill",
  "--radius-row",
  "--radius-pane",
  "--radius-button",
] as const;

/**
 * The shadow ladder, shallowest first. These are what `--elevation-N-shadow`
 * points at; levels 2 and 3 both draw `--shadow-2` today, so `--shadow-1` and
 * `--shadow-3` are rungs a theme can move rather than rungs in use.
 */
export const SHADOW_TOKENS = ["--shadow-1", "--shadow-2", "--shadow-3"] as const;

/**
 * The three elevation levels, lowest first. `utility` is the class a component
 * writes; the tokens are what that class expands to. The class names are
 * spelled in full because Tailwind scans this file for them and would not see
 * an `elevation-${n}` template.
 */
export const ELEVATION_LEVELS = [
  {
    utility: "elevation-1",
    tokens: [
      "--elevation-1-surface",
      "--elevation-1-border",
      "--elevation-1-shadow",
    ],
  },
  {
    utility: "elevation-2",
    tokens: [
      "--elevation-2-surface",
      "--elevation-2-border",
      "--elevation-2-shadow",
    ],
  },
  {
    utility: "elevation-3",
    tokens: [
      "--elevation-3-surface",
      "--elevation-3-border",
      "--elevation-3-shadow",
    ],
  },
] as const;

/** The motion durations, quickest first. */
export const DURATION_TOKENS = [
  "--duration-fast",
  "--duration-base",
  "--duration-slow",
] as const;

/** The two easing curves. */
export const EASE_TOKENS = ["--ease-standard", "--ease-emphasized"] as const;

/** The type ramp, largest first. Each role has a size and a line height. */
export const TYPE_ROLES = [
  "display",
  "title",
  "body",
  "label",
  "caption",
] as const;

/** The face each type role is drawn in, where a role names one. */
export const TYPE_FONT_TOKENS = ["--type-title-font"] as const;

/** The control heights, shortest first, then a list row. */
export const CONTROL_TOKENS = [
  "--control-sm",
  "--control-md",
  "--control-lg",
  "--control-row",
] as const;

/** The two layout distances the shell names: between panes, inside a pane. */
export const SPACE_TOKENS = ["--space-gutter", "--space-pane"] as const;

/** The icon sizes, smallest first. */
export const ICON_SIZE_TOKENS = ["--icon-sm", "--icon-md", "--icon-lg"] as const;

/** The stroke a line icon is drawn with. */
export const ICON_STROKE_TOKEN = "--icon-stroke";

/** Read one custom property off the document root, as the browser resolved it. */
export function readToken(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

const OKLCH = new RegExp(
  "^" +
    ["oklch", "\\(", "\\s*([\\d.]+%?)", "\\s+([\\d.]+)", "\\s+([\\d.]+)"].join(
      "",
    ) +
    "(?:\\s*/\\s*([\\d.]+%?))?\\s*\\)$",
  "i",
);

/** Split on the commas at the top level of a function's argument list. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

/** One `color-mix` stop: a colour and an optional trailing percentage. */
function parseStop(input: string): { colour: string; weight: number | null } {
  const match = /^([\s\S]*?)\s+([\d.]+)%$/.exec(input.trim());
  return match
    ? { colour: match[1]!, weight: Number(match[2]) / 100 }
    : { colour: input.trim(), weight: null };
}

/**
 * Parse an OKLCH value or `color-mix(in oklab, A [p%], B [q%])`, nested or not.
 * The redesign derives a few roles (the mention row, the canvas, a hovered
 * row) by mixing, and the browser hands a custom property back as written,
 * with only its `var()`s filled in. Only `in oklab` is understood, the one
 * space the token layer mixes in.
 */
export function parseColour(input: string): Oklch | null {
  const text = input.trim();
  const mix = /^color-mix\(([\s\S]*)\)$/i.exec(text);
  if (!mix) {
    return parseOklch(text);
  }
  const [space, first, second] = splitTopLevel(mix[1]!);
  if (!/^in\s+oklab$/i.test(space ?? "") || !first || !second) {
    return null;
  }
  const a = parseStop(first);
  const b = parseStop(second);
  const ca = parseColour(a.colour);
  const cb = parseColour(b.colour);
  if (!ca || !cb) {
    return null;
  }
  let wa = a.weight;
  let wb = b.weight;
  if (wa === null && wb === null) {
    wa = 0.5;
    wb = 0.5;
  } else if (wa === null) {
    wa = 1 - wb!;
  } else if (wb === null) {
    wb = 1 - wa;
  }
  const total = wa + wb!;
  const lab = (c: Oklch) => ({
    l: c.l,
    a: c.c * Math.cos((c.h * Math.PI) / 180),
    b: c.c * Math.sin((c.h * Math.PI) / 180),
  });
  const la = lab(ca);
  const lb = lab(cb);
  // Premultiplied, per CSS Color 5, so a translucent stop pulls less.
  const alpha = (ca.alpha * wa + cb.alpha * wb!) / total;
  const mixed = (key: "l" | "a" | "b") =>
    (la[key] * ca.alpha * wa! + lb[key] * cb.alpha * wb!) / (alpha * total);
  const x = mixed("a");
  const y = mixed("b");
  return {
    l: mixed("l"),
    c: Math.hypot(x, y),
    h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
    alpha,
  };
}

/** Parse an OKLCH string into components. L is 0..1. */
export function parseOklch(input: string): Oklch | null {
  const match = OKLCH.exec(input.trim());
  if (!match) {
    return null;
  }
  const asNumber = (raw: string) =>
    raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return {
    l: asNumber(match[1]!),
    c: Number(match[2]),
    h: Number(match[3]),
    alpha: match[4] === undefined ? 1 : asNumber(match[4]),
  };
}

interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/** OKLCH to linear-light sRGB, per the CSS Color 4 conversion. */
function toLinearLight({ l, c, h }: Oklch): LinearRgb {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const lc = lPrime ** 3;
  const mc = mPrime ** 3;
  const sc = sPrime ** 3;

  return {
    r: 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    g: -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    b: -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Relative luminance per WCAG 2.x, from linear-light RGB. */
function luminance({ r, g, b }: LinearRgb): number {
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
}

/**
 * Composite a translucent foreground over its backdrop, in linear light. The
 * focus ring and the selection wash are alpha over a surface, and a ratio on
 * the un-composited colour would be a fiction.
 */
function over(fg: LinearRgb, bg: LinearRgb, alpha: number): LinearRgb {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** WCAG 2.x contrast ratio between two colour strings, 1 to 21. */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const fg = parseColour(foreground);
  const bg = parseColour(background);
  if (!fg || !bg) {
    return null;
  }
  const bgLinear = toLinearLight(bg);
  let fgLinear = toLinearLight(fg);
  if (fg.alpha < 1) {
    fgLinear = over(fgLinear, bgLinear, fg.alpha);
  }
  const lighter = Math.max(luminance(fgLinear), luminance(bgLinear));
  const darker = Math.min(luminance(fgLinear), luminance(bgLinear));
  return (lighter + 0.05) / (darker + 0.05);
}

export function roundRatio(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}
