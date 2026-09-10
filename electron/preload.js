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

  /**
   * This shell's share picker asks "share this computer's audio?" itself.
   *
   * Same kind of version signal as `canShareScreen`. The hosted client runs
   * inside older binaries: without this key the page must not request audio
   * unless the person already opted in, because those pickers treat
   * `audioRequested` as the whole switch and would loop back every share.
   */
  sharePickerOffersAudio: true,

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

  /** Subscribe to Cmd/Ctrl+Shift+D deafen toggle from the app menu. */
  onToggleDeafen(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => {
      callback();
    };
    ipcRenderer.on("pqp:toggle-deafen", handler);
    return () => {
      ipcRenderer.removeListener("pqp:toggle-deafen", handler);
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
   * Desktop auth IPC. Main refuses these unless `event.senderFrame`
   * is the app origin (`lib/ipc-origin.js`). Game-connection hosts
   * reuse this preload while they navigate in-window.
   */
  startDesktopAuth(mode) {
    return ipcRenderer.invoke(
      "pqp:start-desktop-auth",
      mode === "sign-up" ? "sign-up" : "sign-in",
    );
  },

  cancelDesktopAuth() {
    return ipcRenderer.invoke("pqp:cancel-desktop-auth");
  },

  getDesktopAuthStatus() {
    return ipcRenderer.invoke("pqp:desktop-auth-status");
  },

  getPendingDesktopAuthTicket() {
    return ipcRenderer.invoke("pqp:get-pending-desktop-auth-ticket");
  },

  onDesktopAuthTicket(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, ticket) => {
      callback(ticket);
    };
    ipcRenderer.on("pqp:desktop-auth-ticket", handler);
    return () => {
      ipcRenderer.removeListener("pqp:desktop-auth-ticket", handler);
    };
  },

  onDesktopAuthEnded(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, reason) => {
      callback(reason === "expired" ? "expired" : "cancelled");
    };
    ipcRenderer.on("pqp:desktop-auth-ended", handler);
    return () => {
      ipcRenderer.removeListener("pqp:desktop-auth-ended", handler);
    };
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

  /**
   * Global push-to-talk. The renderer hands over an Electron accelerator (or
   * null to let go) and the main process registers it with `globalShortcut`
   * whenever this window is not focused. Resolves with whether the OS took
   * the registration. Main validates the string; this only types it.
   */
  bindPushToTalk(accelerator) {
    if (accelerator !== null && typeof accelerator !== "string") {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke("pqp:ptt-bind", accelerator);
  },

  /** Presses and releases of the global push-to-talk key. */
  onPushToTalk(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, held) => {
      callback(held === true);
    };
    ipcRenderer.on("pqp:ptt-held", handler);
    return () => {
      ipcRenderer.removeListener("pqp:ptt-held", handler);
    };
  },

  /** Call state for the tray icon and menu. */
  setVoiceState(state) {
    if (!state || typeof state !== "object") {
      return;
    }
    ipcRenderer.send("pqp:voice-state", {
      inCall: state.inCall === true,
      muted: state.muted === true,
      deafened: state.deafened === true,
    });
  },

  /** Mute, deafen and leave from the tray menu. */
  onVoiceCommand(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, command) => {
      if (
        command === "toggleMute" ||
        command === "toggleDeafen" ||
        command === "leave"
      ) {
        callback(command);
      }
    };
    ipcRenderer.on("pqp:voice-command", handler);
    return () => {
      ipcRenderer.removeListener("pqp:voice-command", handler);
    };
  },
});
