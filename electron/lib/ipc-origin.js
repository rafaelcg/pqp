/**
 * Origin check for ipcMain handlers the renderer bridge exposes.
 *
 * The main window's preload is injected for every in-window navigation,
 * including game-connection hosts (Google, GitHub, Steam OpenID, Battle.net).
 * Those pages can call `window.pqpDesktop`. Refuse when the sending frame
 * is not the app origin the shell actually loaded.
 *
 * @param {{ senderFrame?: { url?: string } | null }} event
 * @param {string | null | undefined} appOrigin
 * @returns {boolean}
 */
function senderMatchesAppOrigin(event, appOrigin) {
  if (typeof appOrigin !== "string" || appOrigin.length === 0) {
    return false;
  }
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl !== "string" || frameUrl.length === 0) {
    return false;
  }
  try {
    return new URL(frameUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

module.exports = { senderMatchesAppOrigin };
