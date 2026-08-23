const { contextBridge, ipcRenderer } = require("electron");

/**
 * Minimal, allowlisted bridge for the web client.
 * Do not expose ipcRenderer or Node APIs directly.
 */
contextBridge.exposeInMainWorld("pqpDesktop", {
  platform: process.platform,
  isElectron: true,
  /** True when the shell uses a custom in-app title / drag region (macOS hiddenInset). */
  hasCustomTitleBar: process.platform === "darwin",

  /**
   * This shell answers `setDisplayMediaRequestHandler` (see main.js).
   *
   * A VERSION SIGNAL, not a feature toggle — nothing reads it to decide what
   * to do, only to explain what went wrong. `getDisplayMedia` exists in every
   * Electron renderer, so the client's capability probe passes and the share
   * button is shown; without the handler in the main process the call then
   * rejects with `NotSupportedError`, which the client used to report as
   * "screen sharing isn't supported in the app". That is false, and it is the
   * exact wording a user hit on 23 Aug 2026 while running v0.1.0.
   *
   * Shells built before the handler landed simply do not define this key, so
   * `undefined` means "too old" and the client can say "update the app"
   * instead of "this is impossible". Do not remove it once the last old build
   * is gone: absence is the whole signal.
   */
  canShareScreen: true,

  /** Subscribe to Cmd/Ctrl+Shift+M mute toggle from the app menu. */
  onToggleMute(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => {
      callback();
    };
    ipcRenderer.on("pqp:toggle-mute", handler);
    return () => {
      ipcRenderer.removeListener("pqp:toggle-mute", handler);
    };
  },

  /**
   * Subscribe to deep-link navigations.
   * Payload is an in-app path under `/app` (not a raw `pqp://` URL).
   */
  onDeepLink(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, appPath) => {
      callback(appPath);
    };
    ipcRenderer.on("pqp:deep-link", handler);
    return () => {
      ipcRenderer.removeListener("pqp:deep-link", handler);
    };
  },

  getPendingDeepLink() {
    return ipcRenderer.invoke("pqp:get-pending-deep-link");
  },

  /**
   * Mirror the resolved theme into the main process, which cannot read the
   * renderer's localStorage but has to paint the window background before the
   * renderer loads on the next launch.
   */
  setTheme(theme) {
    if (theme !== "dark" && theme !== "light") {
      return;
    }
    ipcRenderer.send("pqp:set-theme", theme);
  },

  setLocale(locale) {
    if (locale !== "en" && locale !== "pt-BR") {
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke("pqp:set-locale", locale);
  },

  /** Dock / taskbar mention count. Zero clears it. */
  setBadgeCount(count) {
    if (!Number.isFinite(count)) {
      return;
    }
    ipcRenderer.send("pqp:set-badge", Math.max(0, Math.floor(count)));
  },

  /**
   * Notify from the main process rather than the renderer: only it can raise
   * the window from behind another application when the user clicks.
   */
  notify(payload) {
    if (!payload || typeof payload.title !== "string") {
      return;
    }
    ipcRenderer.send("pqp:notify", {
      title: payload.title,
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : "",
      path: typeof payload.path === "string" ? payload.path : "/app",
    });
  },

  /** Subscribe to notification clicks; the payload is an in-app `/app` path. */
  onNotificationClick(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, appPath) => {
      callback(appPath);
    };
    ipcRenderer.on("pqp:notification-click", handler);
    return () => {
      ipcRenderer.removeListener("pqp:notification-click", handler);
    };
  },
});
