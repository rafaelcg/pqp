#!/usr/bin/env node
/**
 * SignPath signs the Windows installer AFTER electron-builder already wrote
 * latest.yml, so latest.yml's sha512/size still describe the unsigned bytes.
 * electron-updater rejects a downloaded update whose hash does not match
 * this file, so an unpatched latest.yml after signing means Windows
 * auto-update silently stops working for that release (it fails the same
 * way as no network: logged, never dialogued, see docs/DESKTOP.md §5). This
 * script recomputes the hash and size for each signed file and rewrites
 * only those two fields, wherever that file's name already appears in
 * latest.yml (both the top-level `path` entry and its `files:` list entry).
 *
 * This does NOT fix the matching .blockmap, which still describes the
 * unsigned bytes. electron-updater's differential downloader falls back to
 * a full download when a blockmap does not check out, so the effect is a
 * bigger download for the first signed release, not a broken one. See
 * docs/DESKTOP.md §4 "What SignPath signs, and what it does not".
 *
 * Usage: node fix-update-feed-hash.js <latest.yml path> <signed files dir>
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const [, , yamlPath, signedDir] = process.argv;
if (!yamlPath || !signedDir) {
  console.error("usage: fix-update-feed-hash.js <latest.yml> <signed-dir>");
  process.exit(1);
}

if (!fs.existsSync(yamlPath)) {
  // Nothing to patch (e.g. a platform whose feed file uses a different
  // name). Not an error: not every signed artifact is tracked by an update
  // feed (the portable .exe, for one, is not an auto-update target).
  console.warn(`[fix-update-feed-hash] ${yamlPath} does not exist, nothing to patch.`);
  process.exit(0);
}

function hashAndSize(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    sha512: createHash("sha512").update(buf).digest("base64"),
    size: buf.length,
  };
}

const recomputed = new Map();
for (const name of fs.readdirSync(signedDir)) {
  if (!name.toLowerCase().endsWith(".exe")) continue;
  recomputed.set(name, hashAndSize(path.join(signedDir, name)));
}

if (recomputed.size === 0) {
  console.error(`[fix-update-feed-hash] no .exe files found in ${signedDir}`);
  process.exit(1);
}

const lines = fs.readFileSync(yamlPath, "utf8").split("\n");
let currentFile = null;
let patchedFields = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // A `files:` list entry ("  - url: name.exe") or the top-level
  // ("path: name.exe") both set which file the sha512/size lines that
  // follow describe, until the next url:/path: line changes it again.
  const listUrl = line.match(/^\s*-\s*url:\s*(.+?)\s*$/);
  const topPath = line.match(/^path:\s*(.+?)\s*$/);
  if (listUrl) currentFile = listUrl[1];
  else if (topPath) currentFile = topPath[1];

  if (currentFile && recomputed.has(currentFile)) {
    const { sha512, size } = recomputed.get(currentFile);
    const sha512Line = line.match(/^(\s*sha512:\s*).+$/);
    const sizeLine = line.match(/^(\s*size:\s*).+$/);
    if (sha512Line) {
      lines[i] = sha512Line[1] + sha512;
      patchedFields++;
    } else if (sizeLine) {
      lines[i] = sizeLine[1] + String(size);
      patchedFields++;
    }
  }
}

if (patchedFields === 0) {
  console.error(
    `[fix-update-feed-hash] found no sha512/size fields in ${yamlPath} for: ${[...recomputed.keys()].join(", ")}`,
  );
  process.exit(1);
}

fs.writeFileSync(yamlPath, lines.join("\n"));
for (const [name, { sha512, size }] of recomputed) {
  console.log(`[fix-update-feed-hash] ${name}: sha512=${sha512.slice(0, 16)}... size=${size}`);
}
console.log(`[fix-update-feed-hash] patched ${patchedFields} field(s) in ${yamlPath}`);
