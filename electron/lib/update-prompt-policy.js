/**
 * When the shell may put its native "restart to update" box in front of somebody.
 *
 * The pure half of `updater.js`. electron-updater reports `update-downloaded`
 * again on every later check while the same update is still staged (the check
 * runs every six hours), so a box that is shown on every report is a box that
 * comes back every six hours for a person who already said "Later", and it is
 * modal to the window, so it can come up over a call or a screen share. It was
 * the second source of "update" nagging on the desktop app next to the web
 * client's (`docs/PWA.md`, "Nobody stays on an old bundle").
 *
 * So the box is shown:
 *  - once per version per run of the app: "Later" is an answer, and the update
 *    is already staged and installs on the next ordinary quit
 *    (`autoInstallOnAppQuit`), with no box;
 *  - never while a box is already open;
 *  - never while the person is in a call (the renderer says so, `voiceState`
 *    in `main.js`): it waits and asks again, it is not dropped.
 *
 * @param {{ version: string, declinedVersion: string | null, promptOpen: boolean, inCall: boolean }} input
 * @returns {"show" | "wait" | "skip"}
 */
function decideUpdatePrompt(input) {
  if (input.promptOpen) {
    return "skip";
  }
  if (input.declinedVersion !== null && input.declinedVersion === input.version) {
    return "skip";
  }
  if (input.inCall) {
    return "wait";
  }
  return "show";
}

/** How long a deferred box waits before it looks again. */
const RETRY_WHILE_BUSY_MS = 2 * 60 * 1000;

module.exports = { decideUpdatePrompt, RETRY_WHILE_BUSY_MS };
