/**
 * Decisions about OS notifications, as pure functions.
 *
 * main.js owns the Electron objects; this file owns what they are told.
 */

/**
 * The id Windows files toasts, the taskbar group and the Start menu entry
 * under. electron-builder stamps `build.appId` into the installer's shortcut,
 * and a toast only carries the app's name and icon when the running process
 * names that same id. Read from package.json so there is one source; the
 * fallback exists only for a package.json that lost the field, and the test
 * pins it to the real value.
 */
const FALLBACK_APP_ID = "gg.pqp.app";

function appUserModelId(pkg) {
  const id = pkg && pkg.build && pkg.build.appId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : FALLBACK_APP_ID;
}

/** Windows only: every other platform has no such id to set. */
function shouldSetAppUserModelId(platform) {
  return platform === "win32";
}

/**
 * `silent` for an OS banner.
 *
 * The renderer says `silent: true` when the app plays its own cue (so the
 * banner must not double it) and `silent: false` when app sounds are off and
 * the OS should make its own noise. A renderer that predates the field sends
 * nothing, and gets what every build before this one did: a silent banner.
 */
function notificationSilent(payload) {
  return !(payload && payload.silent === false);
}

/** The options handed to `new Notification(...)`. */
function notificationOptions(payload) {
  return {
    title: payload.title,
    body: typeof payload.body === "string" ? payload.body : "",
    silent: notificationSilent(payload),
  };
}

module.exports = {
  FALLBACK_APP_ID,
  appUserModelId,
  shouldSetAppUserModelId,
  notificationSilent,
  notificationOptions,
};
