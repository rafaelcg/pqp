const { app, dialog } = require("electron");
const { t } = require("./i18n");
const { isFlatpak } = require("./flatpak");
const { RETRY_WHILE_BUSY_MS, decideUpdatePrompt } = require("./update-prompt-policy");
const { DISABLED, IDLE, nextUpdateState, serializeUpdateState } = require("./update-state");

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
 * The page drives it. The rail's update button (`client/src/lib/desktop-update.ts`)
 * reads the state from `update-state.js` and does the two steps the person
 * asks for, like T3 Code's update pill: one click downloads, a second click
 * restarts and installs. Nothing downloads, opens or restarts by itself. A
 * downloaded update still installs on the next ordinary quit, so "not now" is
 * a real answer.
 *
 * A page that never asks (a hosted bundle from before the button) gets the old
 * behaviour: download in the background, then the native box, once per
 * version and never over a call. `pageDrives` is how the two are told apart.
 *
 * macOS caveat: the updater is Squirrel.Mac, which verifies the code signature
 * of the downloaded build against the running one. An unsigned or ad-hoc
 * signed app fails that check *silently*. Signing and auto-update are one
 * piece of work, not two.
 */

/** Hourly: the button is always on screen, and "up to date" should mean it. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

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
 * @param {() => boolean} [isBusy] whether the person is in a call right now; the
 *   box never goes over one (`update-prompt-policy.js`)
 * @param {{ onState?: (state: object) => void }} [hooks] `onState` hears every
 *   change, for main to forward to the page
 * @returns {{ getState: () => object, check: () => void, download: () => void, install: () => boolean, attach: () => void }}
 */
function initAutoUpdate(getWindow, isBusy = () => false, hooks = {}) {
  /** @type {import("./update-state").UpdateState} */
  let state = DISABLED;
  const emit = () => {
    try {
      hooks.onState?.(serializeUpdateState(state));
    } catch (err) {
      log("state listener failed:", err?.message ?? err);
    }
  };
  /** @param {import("./update-state").UpdateEvent} event */
  const dispatch = (event) => {
    const next = nextUpdateState(state, event);
    if (next !== state) {
      state = next;
      emit();
    }
  };
  /** The page has asked about updates at least once: it draws the button. */
  let pageDrives = false;
  const controller = {
    getState: () => serializeUpdateState(state),
    attach: () => {
      pageDrives = true;
    },
    check: () => {},
    download: () => {},
    install: () => false,
  };

  // Development runs from source with no `app-update.yml`, and every check
  // would log a failure on each `pnpm electron:dev`.
  if (!app.isPackaged) {
    log("skipped: not a packaged build");
    return controller;
  }
  // Flathub ships the updates for the Flatpak build, and electron-updater
  // there would pick its .deb updater, which needs pkexec and a writable /opt
  // the sandbox does not have: a download every six hours and a "restart to
  // update" that does nothing.
  if (isFlatpak()) {
    log("skipped: running as a Flatpak, Flathub updates this build");
    return controller;
  }
  if (process.env.PQP_DISABLE_AUTO_UPDATE === "1") {
    log("skipped: PQP_DISABLE_AUTO_UPDATE=1");
    return controller;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    log("electron-updater unavailable:", err?.message ?? err);
    return controller;
  }
  state = IDLE;

  autoUpdater.logger = null;
  // The person's click downloads (`download` below). A page that does not draw
  // the button gets the download started for it on `update-available`.
  autoUpdater.autoDownload = false;
  // The whole point of "Later": the staged update is applied on a normal quit,
  // with no dialog and no second download.
  autoUpdater.autoInstallOnAppQuit = true;

  // No network, DNS failure, a release feed that 404s while a release is still
  // a draft — none of these are the user's problem and none of them get a
  // dialog. An update that did not happen is invisible; an error box about a
  // release feed is a support ticket.
  autoUpdater.on("error", (err) => {
    log("updater error:", err?.message ?? err);
    dispatch({ type: "error" });
  });

  autoUpdater.on("checking-for-update", () => {
    dispatch({ type: "check" });
  });

  autoUpdater.on("update-not-available", () => {
    dispatch({ type: "not-available", at: Date.now() });
  });

  autoUpdater.on("update-available", (info) => {
    log(`update available: ${info?.version}`);
    dispatch({ type: "available", version: String(info?.version ?? "") });
    if (!pageDrives) {
      download();
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    dispatch({ type: "progress", percent: progress?.percent });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(`update downloaded: ${info?.version}`);
    dispatch({ type: "downloaded", version: String(info?.version ?? "") });
    if (!pageDrives) {
      void offer(info);
    }
  });

  let downloading = false;
  function download() {
    if (downloading || (state.status !== "available" && state.status !== "error")) {
      return;
    }
    if (state.status === "error" && !state.version) {
      // Nothing was found to download: the retry is a check.
      check();
      return;
    }
    downloading = true;
    dispatch({ type: "download" });
    autoUpdater
      .downloadUpdate()
      .catch((err) => {
        // Also reported on "error"; swallowed so it is never unhandled.
        log("download rejected:", err?.message ?? err);
      })
      .finally(() => {
        downloading = false;
      });
  }

  function install() {
    if (state.status !== "downloaded") {
      return false;
    }
    log(`installing ${state.version} on the person's request`);
    // isSilent = true, isForceRunAfter = true.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  /** The one version the person said "Later" to in this run of the app. */
  let declinedVersion = null;
  let retryTimer = null;

  /**
   * Whether to show the box now (`update-prompt-policy.js`): not twice for the
   * same version, not over another box, and not over a call, where it waits
   * and asks again instead of being dropped.
   */
  async function offer(info) {
    const version = info?.version ?? "";
    const decision = decideUpdatePrompt({
      version,
      declinedVersion,
      promptOpen,
      inCall: isBusy(),
    });
    if (decision === "wait") {
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void offer(info);
        }, RETRY_WHILE_BUSY_MS);
        retryTimer.unref?.();
      }
      return;
    }
    if (decision === "skip") {
      return;
    }
    promptOpen = true;

    const window = getWindow();
    const options = {
      type: "info",
      buttons: [t("updater.restart"), t("updater.later")],
      defaultId: 0,
      cancelId: 1,
      title: t("updater.title"),
      message: t("updater.message", { version }).trim(),
      detail: t("updater.detail"),
    };

    try {
      const result = window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) {
        // isSilent = true, isForceRunAfter = true.
        autoUpdater.quitAndInstall(true, true);
      } else {
        // "Later" is an answer: the hourly check reports this same staged
        // update again, and asking again each time is how a box came back all
        // day. It installs on the next ordinary quit with no box.
        declinedVersion = version;
      }
    } catch (err) {
      log("prompt failed:", err?.message ?? err);
    } finally {
      promptOpen = false;
    }
  }

  function check() {
    if (state.status === "checking" || state.status === "downloading") {
      return;
    }
    autoUpdater.checkForUpdates().catch((err) => {
      // Also caught by the "error" listener; swallowed here so an offline
      // launch never surfaces an unhandled rejection.
      log("check rejected:", err?.message ?? err);
    });
  }

  controller.check = check;
  controller.download = download;
  controller.install = install;

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

  return controller;
}

module.exports = { initAutoUpdate, CHECK_INTERVAL_MS };
