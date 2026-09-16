/**
 * Whether this shell can promise "start automatically at login" at all.
 *
 * `app.setLoginItemSettings` / `app.getLoginItemSettings` are documented as
 * Windows and macOS only. Electron does not throw when they are called on
 * Linux, it just answers a settings object whose `openAtLogin` never becomes
 * true and never registers anything, so a toggle that looked like it worked
 * there would be a promise the app does not keep. A real Linux autostart
 * needs a `~/.config/autostart/*.desktop` file, which is its own piece of
 * work and not implemented here.
 *
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function loginItemSupported(platform) {
  return platform === "darwin" || platform === "win32";
}

module.exports = { loginItemSupported };
