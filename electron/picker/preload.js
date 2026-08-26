const { contextBridge, ipcRenderer } = require("electron");

/**
 * Bridge for the share picker window ONLY.
 *
 * Deliberately a second, separate preload rather than an addition to
 * `../preload.js`. That one is attached to the window that loads the live web
 * client from pqp.gg, which is remote content on a release cycle of its own;
 * anything exposed there is reachable by whatever is deployed today. The
 * picker loads a `file://` page that ships inside the app bundle, so this
 * surface is only ever reachable by code from this same commit.
 *
 * Same rules as the main bridge: an allowlist of named calls, never
 * `ipcRenderer` itself.
 */
contextBridge.exposeInMainWorld("pqpPicker", {
  /**
   * Sources, strings and theme, fetched rather than pushed.
   *
   * Pull, because a push races the page: the main process has the list before
   * the window exists, and a `webContents.send` that lands before the script
   * runs is a picker that renders empty forever.
   */
  load() {
    return ipcRenderer.invoke("pqp:picker-load");
  },

  /**
   * "The page is alive." Main starts a timer when it opens this window and
   * cancels it here. Without that, a picker that fails to load leaves
   * `getDisplayMedia` pending forever, which the user experiences as a share
   * button that does nothing at all.
   */
  ready() {
    ipcRenderer.send("pqp:picker-ready");
  },

  choose(sourceId) {
    if (typeof sourceId !== "string" || !sourceId) {
      return;
    }
    ipcRenderer.send("pqp:picker-choose", sourceId);
  },

  cancel() {
    ipcRenderer.send("pqp:picker-cancel");
  },
});
