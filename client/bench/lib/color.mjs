/**
 * Colour maths for the theme benchmarks. Deliberately dependency-free so the
 * benchmark suite cannot drift with a library upgrade — a contrast number that
 * silently changes meaning is worse than no number.
 */

/** Parse `oklch(L C H)` / `oklch(L C H / A)` into components. L is 0..1. */
export function parseOklch(input) {
  const match = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(
    input.trim(),
  );
  if (!match) {
    return null;
  }
  const asNumber = (raw) =>
    raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return {
    l: asNumber(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
    alpha: match[4] === undefined ? 1 : asNumber(match[4]),
  };
}

/** OKLCH → linear sRGB, per the CSS Color 4 conversion. */
function oklchToLinearSrgb({ l, c, h }) {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  return {
    r: 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    g: -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    b: -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  };
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Relative luminance per WCAG 2.x, from linear-light RGB. */
function relativeLuminance({ r, g, b }) {
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
}

/**
 * Composite a possibly-translucent colour over a backdrop, in linear light.
 * Tokens like the mention background are alpha over a surface, and contrast on
 * the un-composited colour would be a fiction.
 */
function over(fg, bg, alpha) {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** WCAG 2.x contrast ratio between two OKLCH strings, 1..21. */
export function contrastRatio(foreground, background) {
  const fg = parseOklch(foreground);
  const bg = parseOklch(background);
  if (!fg || !bg) {
    return null;
  }

  const bgLinear = oklchToLinearSrgb(bg);
  let fgLinear = oklchToLinearSrgb(fg);
  if (fg.alpha < 1) {
    fgLinear = over(fgLinear, bgLinear, fg.alpha);
  }

  const lighter = Math.max(relativeLuminance(fgLinear), relativeLuminance(bgLinear));
  const darker = Math.min(relativeLuminance(fgLinear), relativeLuminance(bgLinear));
  return (lighter + 0.05) / (darker + 0.05);
}

export function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
