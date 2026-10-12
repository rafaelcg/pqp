const { execFile } = require("node:child_process");
const { trayLikelyAvailable } = require("./tray-menu");

/**
 * Is there a tray on this Linux desktop to hide the window into?
 *
 * Electron draws its Linux tray icon as a StatusNotifierItem, over D-Bus, and
 * the icon is only ever seen when something owns
 * `org.kde.StatusNotifierWatcher` on the session bus: Plasma, GNOME with the
 * AppIndicator extension (Ubuntu ships it, CachyOS and others add it), a
 * waybar or other panel with a tray module. That is the same name Chromium
 * asks for before it registers the icon, so asking it too gives the shell the
 * real answer instead of a guess from the desktop's name.
 *
 * The guess (`trayLikelyAvailable`) was what 0.2.5 shipped: "GNOME and not
 * Ubuntu" counted as no tray, so a GNOME with the extension on closed the app
 * instead of hiding it, and a sway or Hyprland session with no tray at all
 * counted as having one, and hid the window to nowhere. The guess is kept
 * only for a machine where the bus cannot be asked (no `gdbus`, no
 * `dbus-send`).
 *
 * Inside the Flatpak the manifest grants `--talk-name` on the watcher, which
 * also lets the sandbox see whether it has an owner.
 */

const WATCHER = "org.kde.StatusNotifierWatcher";
const PROBE_TIMEOUT_MS = 1500;

/** One question, two tools that can ask it. `gdbus` comes with GLib. */
const PROBES = [
  [
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      WATCHER,
    ],
  ],
  [
    "dbus-send",
    [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner",
      `string:${WATCHER}`,
    ],
  ],
];

/**
 * `gdbus` prints `(true,)`, `dbus-send` prints a reply header and
 * `boolean true`. Anything else is not an answer.
 *
 * @param {string} stdout
 * @returns {boolean | null}
 */
function parseNameHasOwner(stdout) {
  const text = String(stdout ?? "").trim();
  if (/^\(true,?\)$/.test(text) || /\bboolean true\b/.test(text)) {
    return true;
  }
  if (/^\(false,?\)$/.test(text) || /\bboolean false\b/.test(text)) {
    return false;
  }
  return null;
}

/**
 * The environment the probe runs in. The AppImage launcher prepends its own
 * `usr/lib` to `LD_LIBRARY_PATH`, which the host's `gdbus` has no business
 * loading from; everywhere else the variable is left as the user set it.
 */
function probeEnv(env) {
  if (!env.APPIMAGE && !env.APPDIR) {
    return env;
  }
  const rest = { ...env };
  delete rest.LD_LIBRARY_PATH;
  return rest;
}

function runTool(tool, args, env) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { env, timeout: PROBE_TIMEOUT_MS }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

/**
 * Ask the session bus whether a tray host is there.
 *
 * @param {{ run?: (tool: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<boolean | null>} null when no tool could ask
 */
async function probeStatusNotifierWatcher({ run = runTool, env = process.env } = {}) {
  for (const [tool, args] of PROBES) {
    try {
      const answer = parseNameHasOwner(await run(tool, args, probeEnv(env)));
      if (answer !== null) {
        return answer;
      }
    } catch {
      // Missing tool, no session bus, a timeout: try the next one.
    }
  }
  return null;
}

/**
 * The bus's answer when there is one, the desktop-name guess when not.
 *
 * @param {boolean | null} watcher
 * @param {NodeJS.ProcessEnv} [env]
 */
function linuxTrayHostAvailable(watcher, env = process.env) {
  if (watcher === true || watcher === false) {
    return watcher;
  }
  return trayLikelyAvailable("linux", env);
}

/**
 * The tray needs creating again: it was made before a tray host was known to
 * be there (Chromium then falls back to an icon nobody draws) and the bus now
 * says one is, for instance when pqp starts with the session, before the
 * panel. "Before a host was known" includes not knowing: a probe that had not
 * answered yet, or could not ask, when the tray was made. Making it again
 * once is cheap; hiding the window into an icon nobody draws is not.
 *
 * @param {boolean | null} atCreation the probe's answer when the tray was made
 * @param {boolean | null} now
 */
function trayNeedsRecreate(atCreation, now) {
  return atCreation !== true && now === true;
}

module.exports = {
  WATCHER,
  PROBES,
  parseNameHasOwner,
  probeEnv,
  probeStatusNotifierWatcher,
  linuxTrayHostAvailable,
  trayNeedsRecreate,
};
