const fs = require("node:fs");
const path = require("node:path");

/**
 * The one tray preference: does closing the window during a call hide the
 * app to the tray, or close it like it always did? Lives in `userData` next
 * to theme.json and locale.json, and is toggled from the tray menu itself,
 * because the tray is where somebody is when they notice the behaviour.
 */
const DEFAULT_KEEP_IN_TRAY = true;

function trayPath(userDataPath) {
  return path.join(userDataPath, "tray.json");
}

function loadTrayPrefs(userDataPath) {
  try {
    const saved = JSON.parse(fs.readFileSync(trayPath(userDataPath), "utf8"));
    if (typeof saved.keepInTray === "boolean") {
      return { keepInTray: saved.keepInTray };
    }
  } catch {
    // No file yet, or unreadable.
  }
  return { keepInTray: DEFAULT_KEEP_IN_TRAY };
}

function saveTrayPrefs(userDataPath, prefs) {
  try {
    fs.writeFileSync(
      trayPath(userDataPath),
      JSON.stringify({ keepInTray: prefs.keepInTray === true }),
    );
  } catch {
    // Disk full, permissions: the menu still reflects the in-memory value.
  }
}

module.exports = { DEFAULT_KEEP_IN_TRAY, loadTrayPrefs, saveTrayPrefs };
