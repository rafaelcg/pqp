#!/usr/bin/env node
/**
 * Build the desktop icon binaries from the two SVG sources in `build/`.
 *
 *     node electron/scripts/generate-icons.js
 *
 * Run by hand when the mark changes, not in CI — this needs `sips` and
 * `iconutil`, which only exist on macOS, and the outputs are committed. Same
 * convention as scripts/generate-icons.py, which draws the web icon set from
 * the same mark.
 *
 * Outputs (all referenced from electron/package.json "build"):
 *   build/icon.icns  macOS   from icon-mac.svg (inset for the Big Sur grid)
 *   build/icon.ico   Windows from icon.svg     (full bleed)
 *   build/icon.png   Linux   from icon.svg     (512x512)
 *
 * The .ico is assembled here rather than shelled out to ImageMagick, which is
 * not installed on a stock macOS and is not worth a dependency for a 6-entry
 * container: every entry is just a PNG with a 16-byte header in front of it,
 * which Windows has read since Vista.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const buildDir = path.resolve(__dirname, "..", "build");

/** macOS iconset members. iconutil rejects the directory if any are missing. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
/** Windows shell asks for these; 256 is the one electron-builder requires. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function requireMacOS() {
  if (os.platform() !== "darwin") {
    throw new Error(
      "generate-icons needs macOS (sips + iconutil). The generated icons are committed, so this only has to run on the machine that changes the mark.",
    );
  }
}

/** Rasterise an SVG to a square PNG of exactly `size` pixels. */
function rasterise(svgPath, size, outPath) {
  execFileSync(
    "sips",
    [
      "-s",
      "format",
      "png",
      "-z",
      String(size),
      String(size),
      svgPath,
      "--out",
      outPath,
    ],
    { stdio: "pipe" },
  );
  return outPath;
}

function buildIcns(svgPath, outPath, workDir) {
  const iconset = path.join(workDir, "icon.iconset");
  fs.mkdirSync(iconset, { recursive: true });

  for (const size of ICNS_SIZES) {
    const png = rasterise(svgPath, size, path.join(workDir, `icns-${size}.png`));
    // Every size is both an @1x entry and the @2x of the size below it.
    if (size <= 512) {
      fs.copyFileSync(png, path.join(iconset, `icon_${size}x${size}.png`));
    }
    if (size >= 32) {
      const half = size / 2;
      fs.copyFileSync(png, path.join(iconset, `icon_${half}x${half}@2x.png`));
    }
  }

  execFileSync("iconutil", ["-c", "icns", iconset, "-o", outPath], {
    stdio: "pipe",
  });
}

function buildIco(svgPath, outPath, workDir) {
  const entries = ICO_SIZES.map((size) => ({
    size,
    png: fs.readFileSync(
      rasterise(svgPath, size, path.join(workDir, `ico-${size}.png`)),
    ),
  }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 is stored as 0: the field is a single byte and 256 does not fit.
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size (0 = truecolour)
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  fs.writeFileSync(
    outPath,
    Buffer.concat([header, directory, ...entries.map((e) => e.png)]),
  );
}

function main() {
  requireMacOS();

  const macSvg = path.join(buildDir, "icon-mac.svg");
  const squareSvg = path.join(buildDir, "icon.svg");
  for (const svg of [macSvg, squareSvg]) {
    if (!fs.existsSync(svg)) {
      throw new Error(`Missing icon source: ${svg}`);
    }
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pqp-icons-"));
  try {
    buildIcns(macSvg, path.join(buildDir, "icon.icns"), workDir);
    buildIco(squareSvg, path.join(buildDir, "icon.ico"), workDir);
    rasterise(squareSvg, 512, path.join(buildDir, "icon.png"));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  for (const name of ["icon.icns", "icon.ico", "icon.png"]) {
    const { size } = fs.statSync(path.join(buildDir, name));
    console.log(`wrote build/${name} (${size} bytes)`);
  }
}

main();
