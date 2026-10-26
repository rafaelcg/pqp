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

/** Split on the commas at the top level of a function's argument list. */
function splitTopLevel(input) {
  const parts = [];
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
function parseStop(input) {
  const match = /^([\s\S]*?)\s+([\d.]+)%$/.exec(input.trim());
  return match
    ? { colour: match[1], weight: Number(match[2]) / 100 }
    : { colour: input.trim(), weight: null };
}

/**
 * Parse `oklch(...)` or `color-mix(in oklab, A [p%], B [q%])`, nested or not,
 * into OKLCH components. The redesign derives a few roles (the mention row,
 * the canvas) from each look's own colours, and a derived role the bench
 * cannot read is a role nobody measures. Only `in oklab` is understood, the
 * one space the token layer mixes in; anything else is null.
 */
export function parseColour(input) {
  const text = input.trim();
  const mix = /^color-mix\(([\s\S]*)\)$/i.exec(text);
  if (!mix) {
    return parseOklch(text);
  }
  const [space, first, second] = splitTopLevel(mix[1]);
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
    wa = 1 - wb;
  } else if (wb === null) {
    wb = 1 - wa;
  }
  const total = wa + wb;
  const lab = (c) => ({
    l: c.l,
    a: c.c * Math.cos((c.h * Math.PI) / 180),
    b: c.c * Math.sin((c.h * Math.PI) / 180),
  });
  const la = lab(ca);
  const lb = lab(cb);
  // Premultiplied, per CSS Color 5, so a translucent stop pulls less.
  const alpha = (ca.alpha * wa + cb.alpha * wb) / total;
  const mixed = (key) =>
    (la[key] * ca.alpha * wa + lb[key] * cb.alpha * wb) / (alpha * total);
  const l = mixed("l");
  const x = mixed("a");
  const y = mixed("b");
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { l, c: Math.hypot(x, y), h, alpha };
}

/** Distance between two colours in OKLab. 0 is identical. */
export function deltaE(first, second) {
  const ca = parseColour(first);
  const cb = parseColour(second);
  if (!ca || !cb) {
    return null;
  }
  const lab = (c) => [
    c.l,
    c.c * Math.cos((c.h * Math.PI) / 180),
    c.c * Math.sin((c.h * Math.PI) / 180),
  ];
  const [l1, a1, b1] = lab(ca);
  const [l2, a2, b2] = lab(cb);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
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

/** WCAG 2.x contrast ratio between two colours (see `parseColour`), 1..21. */
export function contrastRatio(foreground, background) {
  const fg = parseColour(foreground);
  const bg = parseColour(background);
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
