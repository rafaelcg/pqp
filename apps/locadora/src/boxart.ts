/**
 * Procedural box art for the shelf: one SVG string per (title, platform), pure and
 * deterministic, so the same tape draws the same box on every device and every visit.
 *
 * Eight palettes, five patterns (synth horizon, sunburst, stripes, halftone,
 * mountains), a platform band, a foot strip and a title set clean: a thin round
 * outline under the fill and a hard offset shadow, no noise filter. It
 * draws no console logos, no brand colours and no real cover: the band is a plain
 * word on a plain colour. See SPEC 4.1 and mock 1.
 */
import type { RomPlatform } from "./rom-header";

export type BoxPlatform = RomPlatform;

/** background, accent a, accent b, title ink. */
export type BoxPalette = readonly [string, string, string, string];

export const BOX_PALETTES: readonly BoxPalette[] = [
  ["#1b2a6b", "#ff5fc8", "#ffd166", "#f8f4e3"],
  ["#0f3d3e", "#5ff2ff", "#ff8a3d", "#fdf6e3"],
  ["#3b0f4f", "#ffc24a", "#5ff2ff", "#fff7ea"],
  ["#122b17", "#c8f55a", "#ff5f5f", "#f3f0e0"],
  ["#4a1010", "#ffb347", "#ffe66d", "#fff4e6"],
  ["#14213d", "#fca311", "#e5e5e5", "#ffffff"],
  ["#2d1e2f", "#f7b32b", "#f72c25", "#fbf5f3"],
  ["#0b3c5d", "#d9b310", "#ff6f59", "#f7f9fb"],
];

export const PATTERN_COUNT = 5;

/** The outline behind every title; each palette's ink keeps 4.5:1 against it. */
export const TITLE_STROKE = "#0a0a0a";
/** The platform word's colour on its band. */
export const BAND_INK = "#f4f1e8";

interface PlatformSpec {
  label: string;
  w: number;
  h: number;
  band: string;
}

export const BOX_PLATFORMS: Readonly<Record<BoxPlatform, PlatformSpec>> = {
  nes: { label: "NES", w: 140, h: 196, band: "#16181d" },
  snes: { label: "SNES", w: 150, h: 206, band: "#3a3f4b" },
  gb: { label: "GAME BOY", w: 118, h: 148, band: "#2d3a2a" },
  gbc: { label: "GB COLOR", w: 118, h: 148, band: "#3a2340" },
  gba: { label: "GBA", w: 124, h: 156, band: "#232a52" },
};

export interface BoxArtOptions {
  /** Rendered width in px; the height follows the platform's aspect. Default is the natural width. */
  width?: number;
  /** Accessible name. Default: "<title>, <platform>". */
  label?: string;
  /** A small line on a dark strip at the foot, for the caller's own copy. Default none. */
  caption?: string;
}

/** FNV-1a over UTF-16 code units. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** xorshift32 in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a ^ (a << 13)) >>> 0;
    a = (a ^ (a >>> 17)) >>> 0;
    a = (a ^ (a << 5)) >>> 0;
    return a / 4294967296;
  };
}

/** A short, stable number for SVG attributes. */
function n(x: number): string {
  return String(Math.round(x * 100) / 100);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Which palette and pattern a (title, platform) pair draws. Exposed so tests can see the spread. */
export function boxArtSpec(title: string, platform: BoxPlatform): { palette: number; pattern: number } {
  const r = rng(hashString(title + platform));
  const palette = Math.floor(r() * BOX_PALETTES.length);
  const pattern = Math.floor(r() * PATTERN_COUNT);
  return { palette, pattern };
}

/** Greedy word wrap on upper-cased text; a word longer than `limit` is cut into pieces. */
export function wrapTitle(title: string, limit = 11): string[] {
  const words: string[] = [];
  for (const w of title.toUpperCase().split(/\s+/).filter(Boolean)) {
    for (let i = 0; i < w.length; i += limit) words.push(w.slice(i, i + limit));
  }
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= limit) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines.length ? lines : [""];
}

/**
 * Advance widths, in em, of the heavy face the title is drawn in (Arial Black). A character count is not a width:
 * "XADREZ NES" at the old rule ran past both edges of the cover because an M or a W is twice an I. Anything not
 * listed is taken as wide, so a guess errs towards a smaller title and never one that spills.
 */
const GLYPH_EM: Readonly<Record<string, number>> = {
  A: 0.78, B: 0.78, C: 0.78, D: 0.78, E: 0.72, F: 0.67, G: 0.83, H: 0.83, I: 0.39, J: 0.67, K: 0.83, L: 0.67, M: 0.94,
  N: 0.83, O: 0.83, P: 0.72, Q: 0.83, R: 0.78, S: 0.72, T: 0.72, U: 0.83, V: 0.78, W: 1.0, X: 0.78, Y: 0.78, Z: 0.72,
  "0": 0.67, "1": 0.67, "2": 0.67, "3": 0.67, "4": 0.67, "5": 0.67, "6": 0.67, "7": 0.67, "8": 0.67, "9": 0.67,
  " ": 0.33, ".": 0.33, ",": 0.33, "!": 0.39, "?": 0.72, "-": 0.44, "'": 0.28, ":": 0.39,
};
const WIDE_EM = 0.95;
/** The wrap `wrapTitle` does by default, and the letter size below which another wrap is looked for. */
const DEFAULT_WRAP = 11;
const COMFORTABLE_FS = 13;
/** The title's `letter-spacing` is .5 user units whatever the size. */
const TITLE_TRACKING = 0.5;

/** How wide `line` is at font size `fs`, in the cover's units: the glyphs, the tracking and the outline on both ends. */
export function titleLineWidth(line: string, fs: number): number {
  let em = 0;
  for (const ch of line) em += GLYPH_EM[ch] ?? WIDE_EM;
  // the outline is fs/5 wide, half of it outside the letters on each side
  return em * fs + TITLE_TRACKING * line.length + fs / 5;
}

export interface TitleFit {
  lines: string[];
  fs: number;
}

/**
 * The biggest title that stays inside the cover: sized so its widest line fits `width` (less a margin for the wobble
 * and the tilt) and the whole block fits the room under the band. If the usual wrap leaves small letters, the other
 * wraps are tried and the one with the biggest letters wins.
 */
export function fitTitle(title: string, width: number, height: number): TitleFit {
  const room = width - 14;
  const sized = (limit: number): TitleFit => {
    const lines = wrapTitle(title, limit);
    // the width is linear in the size apart from the tracking, so solve for the size
    const perUnit = Math.max(...lines.map((l) => titleLineWidth(l, 1) - TITLE_TRACKING * l.length));
    const tracking = Math.max(...lines.map((l) => TITLE_TRACKING * l.length));
    const byWidth = (room - tracking) / perUnit;
    const byHeight = (height * 0.3) / (lines.length * 0.95);
    return { lines, fs: Math.max(8, Math.min(24, byWidth, byHeight)) };
  };
  // the usual wrap, when its letters come out a good size: a short title stays on one line
  let best = sized(DEFAULT_WRAP);
  if (best.fs >= COMFORTABLE_FS) return best;
  for (let limit = 4; limit <= 16; limit++) {
    const candidate = sized(limit);
    if (candidate.fs > best.fs + 0.01) best = candidate;
  }
  return best;
}

export function boxArtSvg(title: string, platform: BoxPlatform, opts: BoxArtOptions = {}): string {
  const P = BOX_PLATFORMS[platform];
  const r = rng(hashString(title + platform));
  const pal = BOX_PALETTES[Math.floor(r() * BOX_PALETTES.length)] as BoxPalette;
  const pattern = Math.floor(r() * PATTERN_COUNT);
  const [bg, a, b, ink] = pal;
  const W = P.w;
  const H = P.h;
  const id = `f${hashString(title + platform).toString(36)}`;
  const cx = W * (0.3 + r() * 0.4);
  const cy = H * (0.45 + r() * 0.12);
  let art = "";

  if (pattern === 0) {
    // synth horizon
    art += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(W * 0.28)}" fill="${b}"/>`;
    for (let i = 0; i < 6; i++) {
      art += `<rect x="0" y="${n(cy + i * 6 - 8)}" width="${W}" height="${n(2 + i * 0.6)}" fill="${bg}"/>`;
    }
    for (let i = 0; i < 9; i++) {
      art += `<line x1="${W / 2}" y1="${n(cy + 6)}" x2="${n(-W * 0.6 + i * W * 0.28)}" y2="${H}" stroke="${a}" stroke-width="1" opacity=".7"/>`;
    }
    for (let i = 0; i < 5; i++) {
      const y = n(cy + 10 + i * i * 3);
      art += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${a}" stroke-width="1" opacity=".7"/>`;
    }
  } else if (pattern === 1) {
    // sunburst
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      art += `<path d="M${n(cx)} ${n(cy)} L${n(cx + Math.cos(t) * W * 2)} ${n(cy + Math.sin(t) * W * 2)} L${n(cx + Math.cos(t + 0.2) * W * 2)} ${n(cy + Math.sin(t + 0.2) * W * 2)}Z" fill="${i % 2 ? a : b}" opacity=".85"/>`;
    }
    art += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(W * 0.16)}" fill="${ink}"/>`;
  } else if (pattern === 2) {
    // diagonal stripes
    for (let i = -6; i < 14; i++) {
      art += `<rect x="${i * 18}" y="-40" width="8" height="${H * 2}" fill="${i % 3 ? a : b}" transform="rotate(28 ${W / 2} ${H / 2})" opacity=".9"/>`;
    }
  } else if (pattern === 3) {
    // halftone dots
    for (let y = 30; y < H; y += 10) {
      for (let x = 5; x < W; x += 10) {
        const d = Math.hypot(x - cx, y - cy);
        const rr = Math.max(0.6, 4.2 - d / 22);
        art += `<circle cx="${x}" cy="${y}" r="${n(rr)}" fill="${y > cy ? a : b}"/>`;
      }
    }
  } else {
    // mountains
    let p = `M0 ${H}`;
    for (let x = 0; x <= W + 0.001; x += W / 6) p += ` L${n(x)} ${n(cy - r() * 40)}`;
    art += `<path d="${p} L${W} ${H}Z" fill="${a}"/>`;
    let q = `M0 ${H}`;
    for (let x = 0; x <= W + 0.001; x += W / 8) q += ` L${n(x)} ${n(cy + 10 - r() * 24)}`;
    art += `<path d="${q} L${W} ${H}Z" fill="${b}" opacity=".9"/>`;
    // the near hills are not one flat field: bands of the sky's colour run across them, closer together further down
    for (let i = 0; i < 7; i++) {
      const y = n(cy + 18 + i * (5 + i * 1.6));
      art += `<rect x="0" y="${y}" width="${W}" height="${n(1 + i * 0.35)}" fill="${bg}" opacity=".35"/>`;
    }
    art += `<circle cx="${n(W * 0.75)}" cy="${n(H * 0.32)}" r="14" fill="${ink}" opacity=".18"/>`;
    art += `<circle cx="${n(W * 0.75)}" cy="${n(H * 0.32)}" r="10" fill="${ink}"/>`;
  }

  const { lines, fs } = fitTitle(title, W, H);
  // a slight tilt, never more than 1.5 degrees either way: a printed logo, not a sticker slapped on
  const rot = (r() - 0.5) * 3;
  const ty = H * 0.7;
  const tspans = lines
    .map((l, i) => `<tspan x="${n(W / 2)}" dy="${i ? n(fs * 0.95) : 0}">${esc(l)}</tspan>`)
    .join("");
  const handheld = platform === "gb" || platform === "gbc" || platform === "gba";
  const bandH = handheld ? 20 : 24;
  const rx = handheld ? 10 : 6;
  const label = opts.label ?? `${title}, ${P.label}`;
  const outW = opts.width ?? W;
  const outH = (outW * H) / W;
  const caption = opts.caption
    ? `<rect x="0" y="${H - 14}" width="${W}" height="14" fill="#0a0a0a" opacity=".55"/><text x="8" y="${H - 4}" font-family="system-ui" font-size="8" fill="#e8e4d8" opacity=".8">${esc(opts.caption)}</text>`
    : "";
  const slot = handheld
    ? `<rect x="${W - 30}" y="5" width="22" height="10" rx="2" fill="none" stroke="${BAND_INK}" stroke-width="1.4" opacity=".8"/>`
    : `<rect x="${W - 34}" y="6" width="26" height="12" rx="2" fill="none" stroke="${BAND_INK}" stroke-width="1.4" opacity=".8"/><rect x="${W - 30}" y="9" width="18" height="2" fill="${BAND_INK}" opacity=".8"/>`;

  const titleY = n(ty - (lines.length - 1) * fs * 0.45);
  const titleAttrs = `x="${n(W / 2)}" y="${titleY}" text-anchor="middle" font-family="Arial Black,Impact,system-ui" font-weight="900" font-size="${n(fs)}" letter-spacing=".5"`;
  // a hard offset shadow under the title, the way a printed cover sets its logo off the picture
  const shadowD = n(Math.max(1.2, fs / 9));
  // a clean outline: thin, round at the joins, painted under the fill so the letters keep their full weight
  const strokeW = n(fs / 10);
  // the foot of the cover: a thin strip in the band's colour, so the picture is framed top and bottom like a box
  const foot = opts.caption ? "" : `<rect x="0" y="${H - 7}" width="${W}" height="7" fill="${P.band}"/><rect x="0" y="${H - 9}" width="${W}" height="2" fill="${a}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(outW)}" height="${n(outH)}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
<defs><clipPath id="c${id}"><rect x="0" y="0" width="${W}" height="${H}" rx="${rx}"/></clipPath><linearGradient id="s${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient></defs>
<g clip-path="url(#c${id})">
<rect width="${W}" height="${H}" fill="${bg}"/>
<g>${art}</g>
<rect width="${W}" height="${H}" fill="url(#s${id})"/>
<rect x="0" y="0" width="${W}" height="${bandH}" fill="${P.band}"/>
<rect x="0" y="${bandH}" width="${W}" height="2" fill="${a}"/>
<text x="8" y="${handheld ? 14 : 16}" font-family="Arial Black,system-ui" font-size="${handheld ? 9 : 10}" font-weight="900" fill="${BAND_INK}" letter-spacing="1">${P.label}</text>
${slot}
${foot}
<g transform="rotate(${n(rot)} ${n(W / 2)} ${n(ty)})"><text ${titleAttrs} transform="translate(${shadowD} ${shadowD})" fill="${TITLE_STROKE}" stroke="${TITLE_STROKE}" stroke-width="${strokeW}" stroke-linejoin="round" opacity=".8">${tspans}</text><text ${titleAttrs} fill="${ink}" stroke="${TITLE_STROKE}" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke">${tspans}</text></g>
${caption}
<rect x="0" y="0" width="5" height="${H}" fill="#000" opacity=".28"/><rect x="5" y="0" width="1" height="${H}" fill="#fff" opacity=".14"/>
<rect width="${W}" height="${H}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="2" rx="${rx}"/>
<path d="M0 ${n(H * 0.12)} L${W} 0 L${W} ${n(H * 0.08)} L0 ${n(H * 0.25)}Z" fill="#fff" opacity=".06"/>
</g></svg>`;
}
