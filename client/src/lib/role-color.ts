import { STAFF_ROLE_COLORS } from "@pqp/shared";
import { rgbToHex, type Rgb } from "@/lib/oklch";

export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function rgbBytes(r: number, g: number, b: number): string {
  return rgbToHex({ r: r / 255, g: g / 255, b: b / 255 });
}

export const ROLE_COLOR_PRESETS = [
  STAFF_ROLE_COLORS.owner,
  STAFF_ROLE_COLORS.admin,
  STAFF_ROLE_COLORS.manager,
  STAFF_ROLE_COLORS.moderator,
  STAFF_ROLE_COLORS.vip,
  rgbBytes(201, 134, 74),
  rgbBytes(139, 126, 212),
  rgbBytes(227, 155, 138),
  rgbBytes(111, 143, 160),
] as const;

/** Starting HSV when the cargo is unpainted, so the plane is usable. */
export const FALLBACK_HSV: Hsv = { h: 200, s: 0.45, v: 0.85 };

export type Hsv = {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
};

export function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function parseHexColor(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const next = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_COLOR.test(next) ? next : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hexToHsv(hex: string): Hsv | null {
  if (!HEX_COLOR.test(hex)) {
    return null;
  }
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }
  return {
    h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - chroma;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }
  return { r: r + m, g: g + m, b: b + m };
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
}

export function hueTrackGradient(): string {
  const stops = [0, 60, 120, 180, 240, 300, 360].map((h) =>
    hsvToHex({ h, s: 1, v: 1 }),
  );
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function hsvFromPointer(
  hsv: Hsv,
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): Hsv {
  if (box.width <= 0 || box.height <= 0) {
    return hsv;
  }
  return {
    h: hsv.h,
    s: clamp((clientX - box.left) / box.width, 0, 1),
    v: clamp(1 - (clientY - box.top) / box.height, 0, 1),
  };
}
