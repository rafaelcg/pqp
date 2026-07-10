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
});
