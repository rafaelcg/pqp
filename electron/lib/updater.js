const { app, dialog } = require("electron");

/**
 * Shell auto-update, over electron-updater / GitHub Releases.
 *
 * Scope note: a packaged build loads the hosted web client, so the *product*
 * updates itself on reload (the service worker prompt in
 * `client/src/components/layout/update-prompt.tsx`). This path only ships
 * changes to the native shell — main process, menus, deep links, permissions.
 * That is a much slower cadence than the web app, and it is why the update is
 * allowed to sit until the next quit instead of interrupting anyone.
 *
 * UX matches the web client's convention rather than inventing a second one:
 * download in the background, then *ask*. This app holds a live WebSocket and
 * possibly an active call; restarting under either is worse than running
 * yesterday's shell for another day. "Later" is a real answer — the update is
 * already staged and installs on the next ordinary quit.
 *
 * macOS caveat: the updater is Squirrel.Mac, which verifies the code signature
 * of the downloaded build against the running one. An unsigned or ad-hoc
 * signed app fails that check *silently*. Signing and auto-update are one
 * piece of work, not two.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** @type {NodeJS.Timeout | null} */
let timer = null;
let promptOpen = false;

function log(...args) {
  console.log("[pqp/updater]", ...args);
}

/**
 * Wire the updater. Safe to call unconditionally: it no-ops in development and
 * whenever the feed is unusable.
 *
 * @param {() => import("electron").BrowserWindow | null} getWindow
 */
function initAutoUpdate(getWindow) {
  // Development runs from source with no `app-update.yml`, and every check
  // would log a failure on each `pnpm electron:dev`.
  if (!app.isPackaged) {
    log("skipped: not a packaged build");
    return;
  }
  if (process.env.PQP_DISABLE_AUTO_UPDATE === "1") {
    log("skipped: PQP_DISABLE_AUTO_UPDATE=1");
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    log("electron-updater unavailable:", err?.message ?? err);
    return;
  }

  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  // The whole point of "Later": the staged update is applied on a normal quit,
  // with no dialog and no second download.
  autoUpdater.autoInstallOnAppQuit = true;

  // No network, DNS failure, a release feed that 404s while a release is still
  // a draft — none of these are the user's problem and none of them get a
  // dialog. An update that did not happen is invisible; an error box about a
  // release feed is a support ticket.
  autoUpdater.on("error", (err) => {
    log("check failed:", err?.message ?? err);
  });

  autoUpdater.on("update-available", (info) => {
    log(`update available: ${info?.version}`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    log(`update downloaded: ${info?.version}`);
    if (promptOpen) {
      return;
    }
    promptOpen = true;

    const window = getWindow();
    const options = {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `pqp ${info?.version ?? ""} is ready to install.`.trim(),
      detail:
        "Restarting takes a few seconds. If you are in a call, choose Later — the update installs the next time you quit.",
    };

    try {
      const result = window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) {
        // isSilent = true, isForceRunAfter = true.
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (err) {
      log("prompt failed:", err?.message ?? err);
    } finally {
      promptOpen = false;
    }
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      // Also caught by the "error" listener; swallowed here so an offline
      // launch never surfaces an unhandled rejection.
      log("check rejected:", err?.message ?? err);
    });
  };

  // Not on the first tick of the app: launch is already doing enough.
  setTimeout(check, 10_000).unref?.();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();

  app.on("before-quit", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}

module.exports = { initAutoUpdate, CHECK_INTERVAL_MS };
