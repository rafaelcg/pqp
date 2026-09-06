/**
 * Tray icons, painted at launch rather than shipped as files.
 *
 * Three glyphs (mic, mic with a slash, headphones with a slash) at 16 px and
 * 32 px, encoded as PNG with nothing but `zlib`. A hand-drawn pixel grid is
 * what a 16 px menu-bar icon is anyway; vectors at that size need hinting the
 * repo has no pipeline for, and committing six binaries for three shapes is a
 * worse trade than forty lines of encoder.
 *
 * macOS wants a template image: black plus alpha, and the OS recolours it for
 * light and dark menu bars. Windows and Linux want a real colour, and there
 * the slash is red so a muted mic reads at a glance. `paintTrayIcon` returns
 * raw pixels; `trayIconImage` wraps them in an Electron `nativeImage` and is
 * the only thing in here that touches Electron, so the painting is testable.
 */
const zlib = require("node:zlib");

const SIZE = 16;

// `#` glyph, `/` slash, `.` transparent. Sixteen rows of sixteen.
const MIC = [
  "................",
  "......####......",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  "...#.######.#...",
  "...#.######.#...",
  "....#......#....",
  ".....######.....",
  ".......##.......",
  ".......##.......",
  ".....######.....",
  "................",
];

const MIC_MUTED = [
  "..............//",
  "......####..//..",
  ".....######/....",
  ".....#####/#....",
  ".....####/##....",
  ".....###/###....",
  ".....##/####....",
  ".....#/#####....",
  "...#./######.#..",
  "...#/######..#..",
  "..././.....#....",
  "../..######.....",
  "./.....##.......",
  "/......##.......",
  ".....######.....",
  "................",
];

const HEADPHONES_MUTED = [
  "..............//",
  ".....######.//..",
  "...##......//...",
  "..#.......//.#..",
  "..#......//..#..",
  ".#......//....#.",
  ".#.....//.....#.",
  ".#..../.......#.",
  ".###./......###.",
  ".###//......###.",
  ".##//.......###.",
  ".#//........###.",
  ".//.........##..",
  "//..............",
  "................",
  "................",
];

const GLYPHS = {
  idle: MIC,
  live: MIC,
  muted: MIC_MUTED,
  deafened: HEADPHONES_MUTED,
};

/**
 * Which glyph and palette a call state gets.
 * @param {{ inCall: boolean, muted: boolean, deafened: boolean }} state
 * @returns {"idle" | "live" | "muted" | "deafened"}
 */
function trayIconKind(state) {
  if (!state || !state.inCall) {
    return "idle";
  }
  if (state.deafened) {
    return "deafened";
  }
  if (state.muted) {
    return "muted";
  }
  return "live";
}

/**
 * @param {"idle" | "live" | "muted" | "deafened"} kind
 * @param {{ template: boolean, scale: number }} options
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function paintTrayIcon(kind, { template, scale }) {
  const glyph = GLYPHS[kind] ?? MIC;
  const size = SIZE * scale;
  const rgba = Buffer.alloc(size * size * 4);

  // Template: everything black, alpha carries the shape; the idle mic is
  // dimmed so "not in a call" is visibly quieter than "live". Colour: white
  // glyph, red slash, grey idle.
  const ink = template
    ? { r: 0, g: 0, b: 0, a: kind === "idle" ? 110 : 255 }
    : kind === "idle"
      ? { r: 160, g: 160, b: 160, a: 255 }
      : { r: 255, g: 255, b: 255, a: 255 };
  const slash = template
    ? { r: 0, g: 0, b: 0, a: 255 }
    : { r: 239, g: 68, b: 68, a: 255 };

  for (let y = 0; y < size; y += 1) {
    const row = glyph[Math.floor(y / scale)];
    for (let x = 0; x < size; x += 1) {
      const cell = row[Math.floor(x / scale)];
      if (cell === ".") {
        continue;
      }
      const colour = cell === "/" ? slash : ink;
      const offset = (y * size + x) * 4;
      rgba[offset] = colour.r;
      rgba[offset + 1] = colour.g;
      rgba[offset + 2] = colour.b;
      rgba[offset + 3] = colour.a;
    }
  }
  return { width: size, height: size, rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** RGBA pixels to a PNG file. Colour type 6, 8 bits, no interlace. */
function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The Electron half. One image with 1x and 2x representations, marked as a
 * template on macOS so the menu bar recolours it.
 *
 * @param {"idle" | "live" | "muted" | "deafened"} kind
 * @param {string} platform
 */
function trayIconImage(kind, platform) {
  const { nativeImage } = require("electron");
  const template = platform === "darwin";
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    const painted = paintTrayIcon(kind, { template, scale });
    image.addRepresentation({
      scaleFactor: scale,
      width: painted.width,
      height: painted.height,
      buffer: encodePng(painted),
    });
  }
  if (template) {
    image.setTemplateImage(true);
  }
  return image;
}

module.exports = {
  SIZE,
  trayIconKind,
  paintTrayIcon,
  encodePng,
  trayIconImage,
};
