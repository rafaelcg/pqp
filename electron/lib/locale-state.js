const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED = new Set(["en", "pt-BR"]);

function localePath(userDataPath) {
  return path.join(userDataPath, "locale.json");
}

function normalize(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === "pt-br" || lower === "pt" || lower.startsWith("pt-")) {
    return "pt-BR";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  return null;
}

function loadLocale(userDataPath, osLocale) {
  try {
    const saved = JSON.parse(fs.readFileSync(localePath(userDataPath), "utf8"));
    const fromFile = normalize(saved.locale);
    if (fromFile && SUPPORTED.has(fromFile)) {
      return fromFile;
    }
  } catch {
    // No file yet, or unreadable — fall through to the OS setting.
  }
  return normalize(osLocale) ?? "en";
}

function saveLocale(userDataPath, locale) {
  const next = normalize(locale);
  if (!next) {
    return;
  }
  try {
    fs.writeFileSync(localePath(userDataPath), JSON.stringify({ locale: next }));
  } catch {
    // Ignore persistence failures (disk full, permissions, etc.)
  }
}

module.exports = {
  loadLocale,
  saveLocale,
  normalize,
};
