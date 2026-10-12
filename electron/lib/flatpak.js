const fs = require("node:fs");

/**
 * Is this shell running inside a Flatpak sandbox (the Flathub build,
 * `flatpak/gg.pqp.pqp.yml`)?
 *
 * Two signals, either is enough: Flatpak sets `FLATPAK_ID` for the app it
 * runs, and mounts `/.flatpak-info` at the root of every sandbox (the file
 * PipeWire and the portals read to decide a client is sandboxed). The file is
 * the one a child process cannot lose by clearing its environment.
 *
 * What changes inside one:
 * - the in-app updater never runs (`lib/updater.js`): Flathub ships updates,
 *   and the .deb updater it would pick cannot write to /app anyway;
 * - Linux share audio is not offered (`main.js`, `preload.js`). The sound
 *   server does let a sandboxed client build the bus, but the shell tells the
 *   call apart from other apps by process id, and inside the sandbox those are
 *   ids from pqp's own pid namespace (2, 3, ...), the same small numbers
 *   another Flatpak's streams report. That check is what keeps the call out of
 *   the share, so it is off until it is proven under Flatpak.
 *   See docs/DESKTOP.md "Flatpak / Flathub".
 *
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, platform?: NodeJS.Platform }} [deps]
 * @returns {boolean}
 */
function isFlatpak({ env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  if (platform !== "linux") {
    return false;
  }
  if (typeof env.FLATPAK_ID === "string" && env.FLATPAK_ID.length > 0) {
    return true;
  }
  try {
    return exists("/.flatpak-info") === true;
  } catch {
    return false;
  }
}

module.exports = { isFlatpak };
