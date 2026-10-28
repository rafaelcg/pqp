import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkFeed, humanDownloads } from "./verify-release-feed.mjs";

const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const parse = (raw, name) => parseUpdateInfo(raw, name, new URL(`https://example.invalid/${name}`));

const V = "0.2.8";

// The three feeds exactly as v0.2.8 published them (2026-10-27), with the
// hashes shortened: the shape is what is under test, not those bytes.
const FEEDS = {
  "latest.yml": `version: ${V}
files:
  - url: pqp-${V}-x64.exe
    sha512: WIN
    size: 152623334
path: pqp-${V}-x64.exe
sha512: WIN
releaseDate: '2026-10-27T21:24:08.160Z'
`,
  "latest-mac.yml": `version: ${V}
files:
  - url: pqp-${V}-x64.zip
    sha512: MACX
    size: 164523786
  - url: pqp-${V}-arm64.zip
    sha512: MACA
    size: 157683239
path: pqp-${V}-x64.zip
sha512: MACX
releaseDate: '2026-10-27T21:31:15.131Z'
`,
  "latest-linux.yml": `version: ${V}
files:
  - url: pqp-${V}-x86_64.AppImage
    sha512: LINA
    size: 157919195
    blockMapSize: 165871
  - url: pqp-${V}-amd64.deb
    sha512: LIND
    size: 131010532
path: pqp-${V}-x86_64.AppImage
sha512: LINA
releaseDate: '2026-10-27T21:23:40.675Z'
`,
};

function assets() {
  const map = new Map([
    [`pqp-${V}-x64.exe`, { size: 152623334, sha512: "WIN" }],
    [`pqp-${V}-x64.zip`, { size: 164523786, sha512: "MACX" }],
    [`pqp-${V}-arm64.zip`, { size: 157683239, sha512: "MACA" }],
    [`pqp-${V}-x86_64.AppImage`, { size: 157919195, sha512: "LINA" }],
    [`pqp-${V}-amd64.deb`, { size: 131010532, sha512: "LIND" }],
  ]);
  for (const name of humanDownloads(V)) {
    if (!map.has(name)) map.set(name, { size: 1, sha512: "X" });
  }
  return map;
}

test("the feeds v0.2.8 published pass", () => {
  assert.deepEqual(checkFeed({ version: V, feeds: FEEDS, assets: assets(), parse }), []);
});

test("a missing feed file fails, naming the platform that would never update", () => {
  const feeds = { ...FEEDS };
  delete feeds["latest-mac.yml"];
  const problems = checkFeed({ version: V, feeds, assets: assets(), parse });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /latest-mac\.yml is missing: macOS/);
});

test("a feed for another version fails", () => {
  const feeds = { ...FEEDS, "latest.yml": FEEDS["latest.yml"].replace(`version: ${V}`, "version: 0.2.7") };
  assert.match(checkFeed({ version: V, feeds, assets: assets(), parse }).join("\n"), /names version 0\.2\.7/);
});

test("a re-signed file whose hash the feed was not told about fails", () => {
  const files = assets();
  files.set(`pqp-${V}-x64.exe`, { size: 152623334, sha512: "SIGNED" });
  assert.match(
    checkFeed({ version: V, feeds: FEEDS, assets: files, parse }).join("\n"),
    /pqp-0\.2\.8-x64\.exe does not match the feed's sha512/,
  );
});

test("a feed naming a file the release lacks fails, and so does a missing download", () => {
  const files = assets();
  files.delete(`pqp-${V}-arm64.zip`);
  files.delete(`pqp-${V}-x64.dmg`);
  const problems = checkFeed({ version: V, feeds: FEEDS, assets: files, parse }).join("\n");
  assert.match(problems, /names pqp-0\.2\.8-arm64\.zip, which is not in the release/);
  assert.match(problems, /the release has no pqp-0\.2\.8-x64\.dmg/);
});

test("a Mac feed with one architecture fails: Squirrel.Mac picks by name", () => {
  const feeds = {
    ...FEEDS,
    "latest-mac.yml": `version: ${V}
files:
  - url: pqp-${V}-x64.zip
    sha512: MACX
    size: 164523786
path: pqp-${V}-x64.zip
sha512: MACX
`,
  };
  assert.match(checkFeed({ version: V, feeds, assets: assets(), parse }).join("\n"), /arm64\\\.zip/);
});
