const fs = require("node:fs");
const path = require("node:path");
const { nativeTheme } = require("electron");

/**
 * The window paints `backgroundColor` before the renderer has any CSS, so these
 * must track `--color-surface-0` per theme in client/src/index.css. A mismatch
 * shows up as a flash of the wrong colour on every launch.
 */
const BACKGROUNDS = {
  dark: "#090e12",
  light: "#f9f8f5",
};

function themePath(userDataPath) {
  return path.join(userDataPath, "theme.json");
}

/**
 * The renderer's localStorage is unreachable from the main process, so the
 * renderer mirrors its resolved theme into this file. The OS setting is only
 * the first-launch guess — it is wrong for anyone whose app theme differs from
 * their system theme.
 */
function loadTheme(userDataPath) {
  try {
    const saved = JSON.parse(fs.readFileSync(themePath(userDataPath), "utf8"));
    if (saved.theme === "dark" || saved.theme === "light") {
      return saved.theme;
    }
  } catch {
    // No file yet, or unreadable — fall through to the OS setting.
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function saveTheme(userDataPath, theme) {
  if (theme !== "dark" && theme !== "light") {
    return;
  }
  try {
    fs.writeFileSync(themePath(userDataPath), JSON.stringify({ theme }));
  } catch {
    // Ignore persistence failures (disk full, permissions, etc.)
  }
}

module.exports = {
  BACKGROUNDS,
  loadTheme,
  saveTheme,
};
