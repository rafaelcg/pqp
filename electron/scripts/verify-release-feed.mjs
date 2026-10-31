#!/usr/bin/env node
/**
 * Does a release's update feed point at the files the release actually holds?
 *
 *   node scripts/verify-release-feed.mjs <assets dir> <version>
 *
 * <assets dir> holds every asset of the release, downloaded from GitHub (the
 * published files, not a build folder). Exits non-zero, saying why, when:
 *
 * - `latest.yml`, `latest-mac.yml` or `latest-linux.yml` is missing. Without
 *   one, that platform's installs read "no update available" forever and
 *   nothing looks wrong (docs/DESKTOP.md §5).
 * - a feed names another version, or names no file.
 * - a file it names is not in the release, or its size or sha512 differs from
 *   the bytes there. electron-updater rejects that download silently.
 * - the files each platform's updater picks are not there: the x64 installer
 *   on Windows, both Mac zips (Squirrel.Mac picks by architecture), the
 *   AppImage on Linux. And the human downloads (both dmgs, the installer, the
 *   portable exe, the AppImage, the .deb).
 *
 * The feeds are parsed with electron-updater's own `parseUpdateInfo`, the
 * function an installed app runs on them, so "parses here" means "parses
 * there".
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const FEEDS = {
  "latest.yml": { platform: "Windows", wants: [/^pqp-.+-x64\.exe$/] },
  "latest-mac.yml": {
    platform: "macOS",
    wants: [/^pqp-.+-arm64\.zip$/, /^pqp-.+-x64\.zip$/],
  },
  "latest-linux.yml": { platform: "Linux", wants: [/\.AppImage$/] },
};

/** What a person downloads, per platform. */
export function humanDownloads(version) {
  return [
    `pqp-${version}-arm64.dmg`,
    `pqp-${version}-x64.dmg`,
    `pqp-${version}-x64.exe`,
    `pqp-${version}-x64-portable.exe`,
    `pqp-${version}-x86_64.AppImage`,
    `pqp-${version}-amd64.deb`,
  ];
}

/**
 * @param {{
 *   version: string,
 *   feeds: Record<string, string | undefined>,
 *   assets: Map<string, { size: number, sha512: string }>,
 *   parse: (raw: string, name: string) => { version: string, files: { url: string, size?: number, sha512?: string }[] },
 * }} input
 * @returns {string[]} problems, empty when the feed is sound
 */
export function checkFeed({ version, feeds, assets, parse }) {
  const problems = [];
  for (const [name, { platform, wants }] of Object.entries(FEEDS)) {
    const raw = feeds[name];
    if (raw === undefined) {
      problems.push(`${name} is missing: ${platform} installs would never see this release`);
      continue;
    }
    let info;
    try {
      info = parse(raw, name);
    } catch (err) {
      problems.push(`${name} does not parse: ${err?.message ?? err}`);
      continue;
    }
    if (info.version !== version) {
      problems.push(`${name} names version ${info.version}, not ${version}`);
    }
    const files = Array.isArray(info.files) ? info.files : [];
    if (files.length === 0) {
      problems.push(`${name} names no file`);
    }
    for (const file of files) {
      const asset = assets.get(file.url);
      if (!asset) {
        problems.push(`${name} names ${file.url}, which is not in the release`);
        continue;
      }
      if (typeof file.size === "number" && file.size !== asset.size) {
        problems.push(`${name}: ${file.url} is ${asset.size} bytes, the feed says ${file.size}`);
      }
      if (file.sha512 && file.sha512 !== asset.sha512) {
        problems.push(`${name}: ${file.url} does not match the feed's sha512`);
      }
    }
    for (const want of wants) {
      if (!files.some((f) => want.test(f.url))) {
        problems.push(`${name} names no file matching ${want}, which the ${platform} updater needs`);
      }
    }
  }
  for (const download of humanDownloads(version)) {
    if (!assets.has(download)) {
      problems.push(`the release has no ${download}`);
    }
  }
  return problems;
}

async function sha512(file) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    createReadStream(file).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
  });
  return hash.digest("base64");
}

async function main() {
  const [dirArg, version] = process.argv.slice(2);
  if (!dirArg || !version) {
    console.error("usage: verify-release-feed.mjs <assets dir> <version>");
    process.exit(2);
  }
  const dir = path.resolve(dirArg);
  const assets = new Map();
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isFile()) {
      assets.set(name, { size: statSync(file).size, sha512: await sha512(file) });
    }
  }
  const feeds = {};
  for (const name of Object.keys(FEEDS)) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      feeds[name] = readFileSync(file, "utf8");
    }
  }
  const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");
  const problems = checkFeed({
    version,
    feeds,
    assets,
    parse: (raw, name) => parseUpdateInfo(raw, name, new URL(`https://example.invalid/${name}`)),
  });
  for (const [name, raw] of Object.entries(feeds)) {
    console.log(`--- ${name}\n${raw.trim()}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      console.log(`::error::${problem}`);
    }
    process.exit(1);
  }
  console.log(`Update feeds for ${version} name the right version and match the release's files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
