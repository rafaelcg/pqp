#!/usr/bin/env node
/**
 * i18n completeness scans for CI.
 *
 * Placeholder parity, missing and stale keys, suffix families, leftover
 * English in the chat shell, and import bans. English is the source of truth.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const clientSrc = join(root, "client", "src");
const en = JSON.parse(
  readFileSync(join(clientSrc, "locales/en/translation.json"), "utf8"),
);
const pt = JSON.parse(
  readFileSync(join(clientSrc, "locales/pt-BR/translation.json"), "utf8"),
);
const electronEn = JSON.parse(
  readFileSync(join(root, "electron/locales/en.json"), "utf8"),
);
const electronPt = JSON.parse(
  readFileSync(join(root, "electron/locales/pt-BR.json"), "utf8"),
);

const errors = [];

function slots(value) {
  return (value.match(/\{\w+\}/g) ?? []).sort();
}

for (const key of Object.keys(en)) {
  if (!(key in pt)) {
    errors.push(`pt-BR is missing "${key}"`);
  }
}

for (const [key, translated] of Object.entries(pt)) {
  if (!(key in en)) {
    errors.push(`pt-BR has stale key "${key}"`);
    continue;
  }
  const a = slots(translated);
  const b = slots(en[key]);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    errors.push(`placeholder mismatch on "${key}"`);
  }
  if (/\{\{/.test(translated) || /\{\{/.test(en[key])) {
    errors.push(`double-brace leftover on "${key}"`);
  }
}

for (const [key, value] of Object.entries(en)) {
  if (/\{\{/.test(value)) {
    errors.push(`en "${key}" still uses {{placeholders}}`);
  }
}

const SUFFIX = /_(zero|one|two|few|many|other|desktop)$/;
const basesWithOne = new Set();
const basesWithOther = new Set();
const basesWithZero = new Set();
const desktopBases = new Set();

for (const key of Object.keys(en)) {
  const match = key.match(SUFFIX);
  if (!match) {
    continue;
  }
  const base = key.slice(0, -match[0].length);
  if (match[1] === "one") basesWithOne.add(base);
  if (match[1] === "other") basesWithOther.add(base);
  if (match[1] === "zero") basesWithZero.add(base);
  if (match[1] === "desktop") desktopBases.add(base);
}

for (const base of basesWithOne) {
  if (!basesWithOther.has(base) && !basesWithZero.has(base) && !(base in en)) {
    errors.push(`"${base}_one" needs "${base}_other" or a base key`);
  }
}

for (const base of desktopBases) {
  if (!(base in en)) {
    errors.push(`"${base}_desktop" has no base key "${base}"`);
  }
}

for (const key of Object.keys(electronEn)) {
  if (!(key in electronPt)) {
    errors.push(`electron pt-BR is missing "${key}"`);
  }
}

for (const [key, translated] of Object.entries(electronPt)) {
  if (!(key in electronEn)) {
    errors.push(`electron pt-BR has stale key "${key}"`);
  }
  if (JSON.stringify(slots(translated)) !== JSON.stringify(slots(electronEn[key] ?? ""))) {
    errors.push(`electron placeholder mismatch on "${key}"`);
  }
}

const SHELL_GLOBS = [
  "App.tsx",
  "components/layout/channel-list.tsx",
  "components/layout/server-rail.tsx",
  "components/layout/channel-meta-dialog.tsx",
  "components/chat/message-list.tsx",
  "components/chat/message-composer.tsx",
  "components/chat/pinned-messages-panel.tsx",
  "components/search/search-dialog.tsx",
  "components/layout/dm-list.tsx",
  "components/layout/reports-section.tsx",
  "components/chat/report-dialog.tsx",
  "components/layout/members-panel.tsx",
  "components/layout/channel-members-panel.tsx",
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "locales") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

const BANNED_SHELL_ENGLISH = [
  "Search messages",
  "Start the thread",
  "Invite people",
  "Jump to present",
  "No conversations yet.",
  "Pinned messages",
  "Leave this server?",
  "Creating…",
  "Could not add that GIF",
  "Loading pins…",
  "a departed account",
];

for (const rel of SHELL_GLOBS) {
  const file = join(clientSrc, rel);
  const text = readFileSync(file, "utf8");
  for (const phrase of BANNED_SHELL_ENGLISH) {
    if (text.includes(`"${phrase}"`) || text.includes(`>${phrase}<`)) {
      errors.push(`${rel} leftover English: "${phrase}"`);
    }
  }
}

const files = walk(clientSrc);
for (const file of files) {
  const rel = relative(clientSrc, file);
  const text = readFileSync(file, "utf8");
  if (/from ["']react-i18next["']/.test(text)) {
    errors.push(`${rel} imports react-i18next`);
  }
  if (
    /from ["']i18next["']/.test(text) &&
    !rel.startsWith("lib/i18n/")
  ) {
    errors.push(`${rel} imports i18next outside lib/i18n/`);
  }
}

const electronFiles = walk(join(root, "electron"));
for (const file of electronFiles) {
  const rel = relative(join(root, "electron"), file);
  const text = readFileSync(file, "utf8");
  if (/from ["']react-i18next["']/.test(text)) {
    errors.push(`electron/${rel} imports react-i18next`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("i18n scans ok");
