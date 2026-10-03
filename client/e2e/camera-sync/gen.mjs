#!/usr/bin/env node
/**
 * The synthetic watch party: a film and a camera on ONE timeline, cut into
 * segments the way the two egresses cut them, so the real player can be
 * measured against something whose truth is known.
 *
 * WHAT IS IN EVERY FRAME. A 20-bit barcode across the top 24 px: the frame's
 * number on the shared content timeline (25 fps), least significant bit on the
 * left, one bit per twentieth of the width. Both pictures carry the same
 * numbering, so a film frame and a camera frame with the same number were
 * "captured" at the same instant, and the difference between the two numbers a
 * viewer has on screen is the drift that viewer SEES, independent of anything
 * hls.js or our own code reports. `harness.tsx` reads it back off a canvas.
 *
 * The film is `testsrc` at 640x360 with an audio click every second (a 1 kHz
 * blip, 50 ms), the camera is the same pattern negated at 480x270 with no audio,
 * which is the production camera's shape (`CAMERA_RUNG.audioKbps = 0`).
 *
 * THE CAMERA STARTS LATER, as the real camera egress does (it is started after
 * the film's, seconds apart, and runs its own segment timer): its first frame is
 * `--cam-phase-ms` into the content, so its segment boundaries fall at a
 * different phase from the film's, and its PROGRAM-DATE-TIME is the film's epoch
 * plus that phase. `hls-server.mjs` publishes both live.
 *
 * Usage: node gen.mjs --out <dir> [--seconds 420] [--segment 4] [--cam-phase-ms 2320]
 * Needs `ffmpeg` on PATH (lavfi `testsrc`, `geq`, `aevalsrc`, libx264, aac).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FPS = 25;
export const BARCODE_BITS = 20;
export const BARCODE_HEIGHT = 24;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** The barcode band, `width` wide, frame number = N + offset. */
function barcodeFilter(width, offsetFrames, seconds) {
  const block = width / BARCODE_BITS;
  return (
    `color=c=black:s=${width}x${BARCODE_HEIGHT}:r=${FPS}:d=${seconds},` +
    `geq=lum='255*mod(floor((N+${offsetFrames})/pow(2\\,floor(X/${block})))\\,2)':cb=128:cr=128`
  );
}

function encode({ out, name, width, height, seconds, segment, offsetFrames, negate, audio }) {
  const gop = Math.round(segment * FPS);
  // The pattern's own counter shows content seconds on both pictures: the
  // camera's source is started `offsetFrames` in, like its barcode.
  const skip = offsetFrames / FPS;
  const picture = `testsrc=s=${width}x${height}:r=${FPS}:d=${seconds + skip}${negate ? ",negate" : ""}`;
  const inputs = [
    ...(skip > 0 ? ["-ss", String(skip)] : []),
    "-f", "lavfi", "-i", picture,
    "-f", "lavfi", "-i", barcodeFilter(width, offsetFrames, seconds),
  ];
  if (audio) {
    inputs.push(
      "-f", "lavfi", "-i",
      `aevalsrc='if(lt(mod(t\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=${seconds}`,
    );
  }
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", "[0][1]overlay=0:0[v]",
    "-map", "[v]",
    ...(audio ? ["-map", "2:a", "-c:a", "aac", "-b:a", "64k"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0",
    "-f", "hls", "-hls_time", String(segment), "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(out, `${name}_%05d.ts`),
    path.join(out, `${name}.m3u8`),
  ];
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  // The VOD playlist ffmpeg wrote is only read for each segment's duration.
  const durations = [];
  for (const line of readFileSync(path.join(out, `${name}.m3u8`), "utf8").split("\n")) {
    const match = /^#EXTINF:([\d.]+)/.exec(line);
    if (match) {
      durations.push(Number(match[1]));
    }
  }
  return durations;
}

export function generate({ out, seconds = 420, segment = 4, camPhaseMs = 2320 }) {
  mkdirSync(out, { recursive: true });
  const offsetFrames = Math.round((camPhaseMs / 1000) * FPS);
  const film = encode({
    out, name: "film", width: 640, height: 360, seconds, segment,
    offsetFrames: 0, negate: false, audio: true,
  });
  const camera = encode({
    out, name: "cam", width: 480, height: 270, seconds, segment,
    offsetFrames, negate: true, audio: false,
  });
  const manifest = {
    fps: FPS,
    segment,
    camPhaseMs: (offsetFrames / FPS) * 1000,
    film,
    camera,
  };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = arg("out", null);
  if (!out) {
    console.error("usage: node gen.mjs --out <dir> [--seconds 420] [--segment 4] [--cam-phase-ms 2320]");
    process.exit(2);
  }
  const manifest = generate({
    out,
    seconds: Number(arg("seconds", 420)),
    segment: Number(arg("segment", 4)),
    camPhaseMs: Number(arg("cam-phase-ms", 2320)),
  });
  console.log(
    `film: ${manifest.film.length} segments, camera: ${manifest.camera.length} segments, camera phase ${manifest.camPhaseMs} ms`,
  );
}
