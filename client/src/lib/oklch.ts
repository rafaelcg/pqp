/**
 * OKLCH to sRGB, because three.js cannot read the token layer.
 *
 * WHY THIS EXISTS. pqp's colours are defined once, in the OKLCH space, in
 * `index.css`, and `bench/theme-tokens.mjs` fails the build if a colour literal
 * appears anywhere else. That guard is right, and the crachá still needs real
 * numbers: `THREE.Color` does not parse `oklch` at all, and a WebGL material
 * cannot read a CSS custom property. The choice was to hardcode the brand
 * palette as hex next to a comment promising to keep it in step, or to do the
 * conversion. Hardcoding is how the promise gets broken the first time somebody
 * changes the accent.
 *
 * So the badge reads the tokens at runtime and converts them here. Change
 * `--color-accent` and the lanyard changes with it.
 *
 * THE MATHS is the standard OKLab pipeline: polar to rectangular, OKLab to LMS,
 * cube, LMS to linear sRGB, then the sRGB transfer function. The matrices are
 * Björn Ottosson's published values. Nothing here is tuned or approximate;
 * `oklch.test.ts` pins the output against colours measured out of a real
 * browser, which is the only check that would catch a transposed coefficient.
 */

export interface Rgb {
  /** 0 to 1, sRGB, ready for `THREE.Color.setRGB`. */
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/**
 * Read an OKLCH colour string, tolerating the forms a stylesheet actually
 * produces: percentages on L, an alpha after a slash, extra whitespace.
 *
 * Returns null rather than throwing, because the caller's fallback for "this
 * token is missing or in a syntax we do not know" is a sensible default colour,
 * not a crash on a marketing page.
 */
export function parseOklch(value: string): Oklch | null {
  const match = /oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)/i.exec(value);
  if (!match) {
    return null;
  }
  const num = (raw: string, percentOf: number) =>
    raw.endsWith("%") ? (parseFloat(raw) / 100) * percentOf : parseFloat(raw);
  const l = num(match[1]!, 1);
  const c = num(match[2]!, 0.4);
  const h = parseFloat(match[3]!);
  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) {
    return null;
  }
  return { l, c, h };
}

/** The sRGB transfer function, linear light in, display value out. */
function encode(channel: number): number {
  const v =
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

/**
 * OKLCH to sRGB.
 *
 * Out-of-gamut colours are clamped per channel rather than gamut-mapped. A
 * proper mapping would preserve hue by reducing chroma; clamping shifts it
 * slightly. For a badge that is the right trade, and every colour in pqp's
 * palette is inside sRGB anyway.
 */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const bb = c * Math.sin(rad);

  const lRoot = l + 0.3963377774 * a + 0.2158037573 * bb;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * bb;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * bb;

  const lms = lRoot * lRoot * lRoot;
  const mms = mRoot * mRoot * mRoot;
  const sms = sRoot * sRoot * sRoot;

  return {
    r: encode(4.0767416621 * lms - 3.3077115913 * mms + 0.2309699292 * sms),
    g: encode(-1.2684380046 * lms + 2.6097574011 * mms - 0.3413193965 * sms),
    b: encode(-0.0041960863 * lms - 0.7034186147 * mms + 1.707614701 * sms),
  };
}

/**
 * Whatever a stylesheet handed back, as sRGB numbers.
 *
 * Anything not in the OKLCH syntax returns the supplied fallback, so a
 * caller that reads a token which has been changed to some other syntax gets a
 * slightly wrong badge rather than a black one.
 */
export function cssColorToRgb(value: string, fallback: Oklch): Rgb {
  return oklchToRgb(parseOklch(value) ?? fallback);
}

/** Six-digit hex for native colour inputs, which cannot read stylesheet tokens. */
export function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
