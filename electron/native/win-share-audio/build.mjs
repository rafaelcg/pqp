#!/usr/bin/env node
/**
 * Build the Windows share-audio add-on into `prebuilds/win32-<arch>/`, where
 * `electron/lib/win-share-audio.js` looks for it and electron-builder packs it.
 *
 *   node native/win-share-audio/build.mjs            # this machine's arch
 *   node native/win-share-audio/build.mjs x64 arm64  # both, as CI does
 *
 * Windows only, with the "Desktop development with C++" workload (CI's
 * windows-latest image has it, ARM64 tools included). N-API, so one build
 * against Node's own headers loads in every Electron that ships NAPI 8: no
 * `electron-rebuild`, nothing to redo when Electron moves.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned so a node-gyp release cannot change the binary under us between two
// CI runs of the same commit.
const NODE_GYP = "node-gyp@11.5.0";
const here = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "win32") {
  console.error("The share-audio add-on is Windows-only (WASAPI). Nothing to build here.");
  process.exit(1);
}

const archs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [process.arch];
for (const arch of archs) {
  if (arch !== "x64" && arch !== "arm64") {
    console.error(`Unsupported arch: ${arch}`);
    process.exit(1);
  }
  console.log(`[share-audio] building win32-${arch}`);
  execFileSync("npx", ["--yes", NODE_GYP, "rebuild", `--arch=${arch}`], {
    cwd: here,
    stdio: "inherit",
    shell: true,
  });
  const out = path.join(here, "prebuilds", `win32-${arch}`);
  mkdirSync(out, { recursive: true });
  copyFileSync(
    path.join(here, "build", "Release", "pqp_share_audio.node"),
    path.join(out, "pqp_share_audio.node"),
  );
  console.log(`[share-audio] wrote ${path.join(out, "pqp_share_audio.node")}`);
}
