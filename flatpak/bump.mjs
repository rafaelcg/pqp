#!/usr/bin/env node
/**
 * Point the Flatpak manifest at a desktop release and add it to the metainfo.
 *
 *   node flatpak/bump.mjs <version> <deb-sha256> <license-sha256> [YYYY-MM-DD]
 *
 * Rewrites, in place:
 * - flatpak/gg.pqp.pqp.yml: the .deb URL and sha256, the LICENSE URL (pinned
 *   to the same tag) and sha256;
 * - flatpak/gg.pqp.pqp.metainfo.xml: a <release> for the version on top,
 *   unless it is already listed.
 *
 * Text edits, not a YAML round trip, so the manifest's comments survive.
 * `.github/workflows/flatpak-manifest.yml` runs this when a release is
 * published. On Flathub itself the external data checker does the same to
 * flathub/gg.pqp.pqp from the manifest's `x-checker-data`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const REPO = "https://github.com/rafaelcg/pqp";

export function debUrl(version) {
  return `${REPO}/releases/download/v${version}/pqp-${version}-amd64.deb`;
}

export function licenseUrl(version) {
  return `https://raw.githubusercontent.com/rafaelcg/pqp/v${version}/LICENSE`;
}

function check(version, ...hashes) {
  if (!VERSION.test(version)) {
    throw new Error(`not a version: ${version}`);
  }
  for (const hash of hashes) {
    if (!SHA256.test(hash)) {
      throw new Error(`not a sha256: ${hash}`);
    }
  }
}

/** Replace the `sha256:` on the line right after `url: <matching>`. */
function pinSource(manifest, urlPattern, url, sha256) {
  const re = new RegExp(`(\\n(\\s*)url: )${urlPattern}(\\n\\2sha256: )[0-9a-f]{64}`);
  if (!re.test(manifest)) {
    throw new Error(`manifest has no source matching ${urlPattern}`);
  }
  return manifest.replace(re, (_m, head, _indent, mid) => `${head}${url}${mid}${sha256}`);
}

export function bumpManifest(manifest, { version, debSha256, licenseSha256 }) {
  check(version, debSha256, licenseSha256);
  let out = pinSource(
    manifest,
    "https://github\\.com/rafaelcg/pqp/releases/download/v[^/\\s]+/pqp-[^\\s]+-amd64\\.deb",
    debUrl(version),
    debSha256,
  );
  out = pinSource(
    out,
    "https://raw\\.githubusercontent\\.com/rafaelcg/pqp/[^/\\s]+/LICENSE",
    licenseUrl(version),
    licenseSha256,
  );
  return out;
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function addRelease(metainfo, { version, date, summary = null }) {
  if (!VERSION.test(version)) {
    throw new Error(`not a version: ${version}`);
  }
  if (!DATE.test(date)) {
    throw new Error(`not a date: ${date}`);
  }
  if (metainfo.includes(`<release version="${version}"`)) {
    return metainfo;
  }
  const marker = /(\n(\s*)<releases>\n)/;
  const match = metainfo.match(marker);
  if (!match) {
    throw new Error("metainfo has no <releases>");
  }
  const indent = `${match[2]}  `;
  const lines = [
    `${indent}<release version="${version}" date="${date}">`,
    `${indent}  <url type="details">${REPO}/releases/tag/v${version}</url>`,
  ];
  if (summary) {
    lines.push(
      `${indent}  <description>`,
      `${indent}    <p>${escapeXml(summary)}</p>`,
      `${indent}  </description>`,
    );
  }
  lines.push(`${indent}</release>`);
  return metainfo.replace(marker, `$1${lines.join("\n")}\n`);
}

function main(argv) {
  const [version, debSha256, licenseSha256, date = new Date().toISOString().slice(0, 10)] = argv;
  if (!version || !debSha256 || !licenseSha256) {
    console.error("usage: node flatpak/bump.mjs <version> <deb-sha256> <license-sha256> [YYYY-MM-DD]");
    process.exit(2);
  }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(dir, "gg.pqp.pqp.yml");
  const metainfoPath = path.join(dir, "gg.pqp.pqp.metainfo.xml");
  writeFileSync(
    manifestPath,
    bumpManifest(readFileSync(manifestPath, "utf8"), { version, debSha256, licenseSha256 }),
  );
  writeFileSync(metainfoPath, addRelease(readFileSync(metainfoPath, "utf8"), { version, date }));
  console.log(`flatpak: manifest and metainfo now point at ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`flatpak: ${err.message}`);
    process.exit(1);
  }
}
