const {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  Notification,
  shell,
  ipcMain,
  session,
  systemPreferences,
  desktopCapturer,
  dialog,
  globalShortcut,
  Tray,
} = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadWindowState, trackWindowState, DEFAULTS } = require("./lib/window-state");
const { loadTheme, saveTheme, BACKGROUNDS } = require("./lib/theme-state");
const { loadLocale, saveLocale } = require("./lib/locale-state");
const { setLanguage, t } = require("./lib/i18n");
const { startStaticServer } = require("./lib/static-server");
const { waitForUrl, isLocalDevUrl } = require("./lib/wait-for-url");
const { classifyNavigation } = require("./lib/nav-policy");
const {
  PASSKEY_HINT_DELAY_MS,
  mayPromptForPasskey,
} = require("./lib/passkey-hint");
const { initAutoUpdate } = require("./lib/updater");
const { loginItemSupported } = require("./lib/login-item");
const { createDesktopAuthController } = require("./lib/desktop-auth-session");
const { senderMatchesAppOrigin } = require("./lib/ipc-origin");
const {
  THUMBNAIL_SIZE,
  MAC_SCREEN_SETTINGS_URL,
  normalizeSources,
  labelSources,
  pickAutomatically,
  screenPermission,
  captureResponse,
  windowsBuildAllowsOwnAudioExclude,
} = require("./lib/display-sources");
const { displayRequestAllowed } = require("./lib/display-origin.js");
const {
  isAcceptableAccelerator,
  createHoldTracker,
} = require("./lib/global-ptt");
const {
  nativeHookPlatformSupport,
  macAccessibilityPermission,
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_INPUT_MONITORING_SETTINGS_URL,
  createNativeHookSession,
} = require("./lib/native-ptt-hook");
const { DEFAULT_RELEASE_DELAY_MS, clampReleaseDelayMs } = require("./lib/release-delay");
const { trayIconKind, trayIconImage } = require("./lib/tray-icon");
const {
  buildTrayTemplate,
  trayTooltip,
  shouldHideToTray,
  normalizeVoiceState,
} = require("./lib/tray-menu");
const {
  DEFAULT_KEEP_IN_TRAY,
  loadTrayPrefs,
  saveTrayPrefs,
} = require("./lib/tray-state");

const PROTOCOL = "pqp";
const DEFAULT_DEV_URL = "http://localhost:5173/app";
/**
 * Where a packaged build points when nothing overrides it.
 *
 * This is deliberately the hosted app rather than the client bundled into
 * `resources/client`. The API enforces a CORS allowlist in production
 * (`CORS_ALLOWED_ORIGINS`, see `server/src/lib/http.ts`), and the bundled
 * client is served from `http://127.0.0.1:<ephemeral port>` — an origin that
 * is different on every launch and therefore cannot be in any allowlist. A
 * packaged build loading it would render, then fail every single API call.
 * Loading the hosted origin means the desktop app is CORS-identical to the web
 * app, and Clerk sees an origin it already trusts.
 *
 * The bundled-client path still exists for offline and self-host use, behind
 * `PQP_LOAD_STATIC=1`; those deployments have to allow the loopback origin (or
 * leave `CORS_ALLOWED_ORIGINS` unset) themselves.
 */
const DEFAULT_PROD_URL = "https://pqp.gg/app";
const APP_PATH = "/app";

/**
 * Windows 11 (NT build ≥ 22000) can exclude this app from loopback.
 * `os.release()` on Windows 11 is still `10.0.22631`. Other platforms have
 * no mixer tap; the page must not ask for one.
 */
function canExcludeOwnAudioOnThisOs() {
  return (
    process.platform !== "win32" ||
    windowsBuildAllowsOwnAudioExclude(os.release())
  );
}

function windowsLoopbackAllowed() {
  return process.platform === "win32" && canExcludeOwnAudioOnThisOs();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ url: string, close: () => Promise<void> } | null} */
let staticServer = null;
/** @type {string | null} */
let pendingDeepLink = null;
/** @type {string | null} */
let sessionAppOrigin = null;
const desktopAuth = createDesktopAuthController({
  openExternal: (url) => shell.openExternal(url),
  send: (channel, ...args) => sendToRenderer(channel, ...args),
  getAppOrigin: () => sessionAppOrigin,
  onDelivered: () => {
    try {
      app.focus({ steal: true });
    } catch {
      // Electron without steal still gets show/focus below.
    }
    focusMainWindow();
  },
});
/** @type {BrowserWindow | null} */
let pickerWindow = null;

/** @type {Electron.Tray | null} */
let tray = null;
/** What the renderer last said about the call, for the tray icon and menu. */
let voiceState = { inCall: false, muted: false, deafened: false };
/** `{ keepInTray: boolean }`, read from userData at startup. */
let trayPrefs = { keepInTray: DEFAULT_KEEP_IN_TRAY };
/** True from `before-quit` on, so the close handler stops hiding to the tray. */
let quitting = false;

/**
 * Global push-to-talk.
 *
 * `pttAccelerator` is what the renderer asked for and stays set while the app
 * window is focused; `pttRegistered` is what `globalShortcut` actually holds.
 * They differ on purpose: a registered accelerator is swallowed system-wide,
 * including by our own window, so while the window is focused the shell lets
 * go of the key and the renderer's own keydown / keyup pair does the work.
 * That pair is exact, and the global one has to infer its release from
 * auto-repeat (see lib/global-ptt.js), so the precise half wins wherever it
 * is available.
 */
/** @type {string | null} */
let pttAccelerator = null;
/** @type {string | null} */
let pttRegistered = null;
const pttHold = createHoldTracker((held) => {
  sendToRenderer("pqp:ptt-held", held);
});

/**
 * Native global push-to-talk (Tier 2): a real keyboard/mouse hook via
 * `uiohook-napi`, instead of inferring the release from `globalShortcut`
 * auto-repeat. See `lib/native-ptt-hook.js` for the full design, especially
 * the focus-swap note about uiohook-napi issue #54. This module is only
 * ever asked to listen while the window is NOT focused, same rule as
 * `pttAccelerator` above, and for the same reason.
 *
 * `pttNativeBinding` is what the renderer last asked for (a
 * `DesktopPttBinding`, see `client/src/lib/desktop.ts`), independent of
 * whether the hook is actually running right now. `uiohook` is the
 * lazily-`require`d module, or `null` when it failed to load (missing on
 * this platform's prebuild list, or genuinely not installed). Every use of
 * it is guarded, so a build that ships without it degrades to the
 * `globalShortcut` fallback rather than crashing the main process at import
 * time.
 */
/**
 * @type {{ device: "keyboard" | "mouse", code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, accelerator: string | null } | null}
 */
let pttNativeBinding = null;
let pttReleaseDelayMs = DEFAULT_RELEASE_DELAY_MS;
let uiohookModule; // undefined = not attempted yet; null = load failed.

function loadUiohook() {
  if (uiohookModule !== undefined) {
    return uiohookModule;
  }
  try {
    // Lazy on purpose: a platform this prebuild does not cover (or a build
    // that stripped node_modules) must not crash the whole app at import
    // time, only degrade this one feature. See `asarUnpack` in package.json
    // for why the binary can be required at all from inside the packaged
    // asar.
    uiohookModule = require("uiohook-napi").uIOhook;
  } catch (err) {
    console.warn("[pqp] uiohook-napi unavailable, push-to-talk falls back to globalShortcut:", err?.message ?? err);
    uiohookModule = null;
  }
  return uiohookModule;
}

// Required once, here, rather than inside `syncPushToTalkRegistration`: a
// native N-API module has nothing to attach until `.start()` is called, so
// requiring it at module load costs nothing extra and `loadUiohook` is
// memoized regardless, so there is no benefit to deferring the attempt further,
// only a second code path to keep in sync.
const pttNativeSession = createNativeHookSession({
  uiohook: loadUiohook(),
  getBinding: () => pttNativeBinding,
  onHeldChange: (held) => sendToRenderer("pqp:ptt-held-native", held),
  releaseDelayMs: pttReleaseDelayMs,
  onError: (err) => {
    console.warn("[pqp] native push-to-talk hook failed to start:", err?.message ?? err);
  },
});

/**
 * Global mute / deafen hotkeys.
 *
 * Same focus-swap idea as push-to-talk above, minus the hold-tracking: these
 * two are plain toggles, so each one is a single `globalShortcut.register`
 * that fires `sendVoiceCommand` once per press, no press/release inference
 * needed.
 *
 * `globalVoiceHotkeys` is what the renderer asked for; `globalVoiceRegistered`
 * is what `globalShortcut` actually holds right now. They differ while the
 * window is focused, on purpose: the in-window path (the app menu's fixed
 * Cmd/Ctrl+Shift+M/D, or the renderer's own key listener for a remapped
 * chord) owns the key while it can see it directly, and letting go of the
 * global registration is what stops a focused press from firing twice, see
 * `syncGlobalVoiceHotkeys`.
 *
 * Gated by the renderer to calls only: `pqp:global-voice-bind` is sent with
 * both accelerators while connected and with both `null` on leave, so a
 * Cmd/Ctrl+Shift+M chord is never swallowed system-wide for someone who is
 * not even in a voice channel.
 */
/** @type {{ toggleMute: string | null, toggleDeafen: string | null }} */
let globalVoiceHotkeys = { toggleMute: null, toggleDeafen: null };
/** @type {{ toggleMute: string | null, toggleDeafen: string | null }} */
let globalVoiceRegistered = { toggleMute: null, toggleDeafen: null };

/**
 * How long the picker window gets to load before the share is abandoned.
 *
 * Only the load is timed, never the decision: a timer running while somebody
 * reads their window titles would snatch the picker away mid-thought. This
 * exists because the alternative to giving up is worse. A picker page that
 * never loads (a missing file in a bad package, a renderer that crashed on
 * start) leaves `getDisplayMedia` pending forever, and a promise that never
 * settles is a share button that does nothing at all and says nothing about
 * it, which is the exact bug class this whole change is here to remove.
 */
const PICKER_LOAD_TIMEOUT_MS = 12_000;

function resolveClientDist() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "client");
  }
  return path.resolve(__dirname, "../client/dist");
}

/**
 * Serving the bundled client is opt-in, never the default.
 *
 * It used to be what a packaged build did automatically, which produced an
 * origin of `http://127.0.0.1:<random>` — see DEFAULT_PROD_URL for why that
 * cannot work against an API with a CORS allowlist.
 */
function wantsStaticLoad() {
  const flag = process.env.PQP_LOAD_STATIC;
  return flag === "1" || flag === "true";
}

/**
 * Desktop shell always opens the main app (`/app`), not the marketing landing page.
 * Explicit non-root paths on PQP_APP_URL / VITE_APP_URL are preserved.
 */
function ensureAppPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = APP_PATH;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function remoteOrDevUrl() {
  return ensureAppPath(
    process.env.PQP_APP_URL ||
      process.env.VITE_APP_URL ||
      (app.isPackaged ? DEFAULT_PROD_URL : DEFAULT_DEV_URL),
  );
}

/**
 * Map `pqp://…` deep links to in-app paths under `/app`.
 * Examples:
 *   pqp://                     → /app
 *   pqp://open                 → /app
 *   pqp://server/a/channel/b   → /app/server/a/channel/b
 *   pqp://app/invite/xyz       → /app/invite/xyz
 */
function deepLinkToAppPath(url) {
  if (!url || typeof url !== "string" || !url.startsWith(`${PROTOCOL}://`)) {
    return APP_PATH;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const rest = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const segments = [host, rest].filter(Boolean).join("/");
    if (!segments || segments === "open" || segments === "app") {
      return APP_PATH;
    }
    if (segments.startsWith("app/")) {
      return `/${segments}`;
    }
    return `${APP_PATH}/${segments}`;
  } catch {
    return APP_PATH;
  }
}

/**
 * Constrain a renderer-supplied route to an in-app path. `//host` is the case
 * that matters: it parses as protocol-relative, so without this a click could
 * navigate the shell off its own origin.
 */
function sanitizeAppPath(value) {
  if (typeof value !== "string" || !value.startsWith(`${APP_PATH}/`)) {
    return APP_PATH;
  }
  return value.includes("\\") || value.startsWith(`${APP_PATH}//`)
    ? APP_PATH
    : value;
}

async function resolveAppUrl() {
  if (wantsStaticLoad()) {
    const dist = resolveClientDist();
    const indexHtml = path.join(dist, "index.html");
    if (!fs.existsSync(indexHtml)) {
      throw new Error(
        `Static client not found at ${indexHtml}. Build the client first (pnpm --filter @pqp/client build) or set PQP_APP_URL / VITE_APP_URL.`,
      );
    }
    staticServer = await startStaticServer(dist);
    return ensureAppPath(staticServer.url);
  }

  const url = remoteOrDevUrl();
  if (!app.isPackaged && isLocalDevUrl(url)) {
    // Wait on origin — Vite may not have the SPA path ready as a distinct resource.
    const origin = new URL(url).origin;
    console.log(`[pqp] Waiting for Vite at ${origin} …`);
    await waitForUrl(origin);
  }
  return url;
}

/**
 * Tell somebody stuck on a Google passkey prompt where the escape hatch is.
 *
 * Electron has no platform authenticator, so the ceremony never completes and
 * Google's page waits forever with no error. We cannot finish it and we will
 * not inject anything into Google's page to try (see lib/passkey-hint.js), so
 * the shell speaks from outside the page: it retitles the window, and if the
 * page is still sitting there after a while it says plainly to use "Try
 * another way".
 *
 * Everything here is best-effort and guarded. A hint that throws would take a
 * working sign-in down with it, which is a far worse outcome than a passkey
 * prompt nobody explained.
 */
function attachPasskeyHint(win) {
  if (!win || win.isDestroyed()) {
    return;
  }
  let timer = null;
  let shown = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onUrl = (url) => {
    if (!mayPromptForPasskey(url)) {
      // Moved on (consent screen, redirect back to Clerk). Whatever it is now,
      // it is not the ceremony we cannot finish.
      clear();
      return;
    }
    try {
      win.setTitle(t("passkey.windowTitle"));
    } catch {
      // A window that will not take a title still gets the dialog below.
    }
    if (shown || timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (shown || win.isDestroyed()) {
        return;
      }
      // Re-check: 22 seconds is long enough to have left the page.
      let current = "";
      try {
        current = win.webContents.getURL();
      } catch {
        return;
      }
      if (!mayPromptForPasskey(current)) {
        return;
      }
      shown = true;
      try {
        dialog.showMessageBox(win, {
          type: "info",
          title: t("passkey.hintTitle"),
          message: t("passkey.hintTitle"),
          detail: t("passkey.hintBody"),
          buttons: [t("passkey.hintDismiss")],
          defaultId: 0,
          noLink: true,
        });
      } catch {
        // Nothing to fall back to; the window still carries the title.
      }
    }, PASSKEY_HINT_DELAY_MS);
  };

  // `did-navigate-in-page` matters: Google moves between challenge steps
  // without a full navigation, and the passkey step is often one of those.
  win.webContents.on("did-navigate", (_event, url) => onUrl(url));
  win.webContents.on("did-navigate-in-page", (_event, url) => onUrl(url));
  win.once("closed", clear);

  try {
    onUrl(win.webContents.getURL());
  } catch {
    // Not loaded yet; the navigation events will catch it.
  }
}

function sendToRenderer(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.webContents.send(channel, ...args);
  return true;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * One live notification per channel. Electron has no `tag` semantics of its
 * own, so a burst is collapsed by closing the previous one for that channel
 * before showing the replacement.
 *
 * @type {Map<string, Electron.Notification>}
 */
const liveNotifications = new Map();

function showNotification({ title, body, tag, path: appPath }) {
  if (!Notification.isSupported()) {
    return;
  }
  const key = tag || appPath;
  liveNotifications.get(key)?.close();

  // The OS owns the alert sound and Do Not Disturb; overriding either is how a
  // chat app ends up muted at the system level and never heard from again.
  const notification = new Notification({ title, body, silent: true });
  notification.on("click", () => {
    liveNotifications.delete(key);
    focusMainWindow();
    sendToRenderer("pqp:notification-click", appPath);
  });
  notification.on("close", () => {
    if (liveNotifications.get(key) === notification) {
      liveNotifications.delete(key);
    }
  });
  liveNotifications.set(key, notification);
  notification.show();

  // The OS banner alone can go unseen — Do Not Disturb, a "silent" banner
  // style, or the window simply buried under others. flashFrame bounces the
  // dock icon (macOS) or flashes the taskbar (Windows/most Linux WMs) until
  // the window is focused again, which is the same nudge a ringing call or a
  // waiting mention gets on every other platform.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

function applyBadgeCount(count) {
  // macOS and most Linux desktops draw a real number; Windows has no dock, so
  // a taskbar flash is the equivalent nudge. An overlay icon would be better
  // but needs an icon asset the repo does not ship yet.
  if (typeof app.setBadgeCount === "function") {
    app.setBadgeCount(count);
  }
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(count > 0 && !mainWindow.isFocused());
  }
}

function handleDeepLink(url) {
  if (!url || typeof url !== "string") {
    return;
  }
  if (!url.startsWith(`${PROTOCOL}://`)) {
    return;
  }
  // Prefer /app/… paths so the renderer never lands on marketing `/`.
  const appPath = deepLinkToAppPath(url);
  pendingDeepLink = appPath;
  sendToRenderer("pqp:deep-link", appPath);
}

function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function createAppMenu() {
  const isMac = process.platform === "darwin";

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: t("menu.speech"),
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: t("menu.toggleMute"),
          accelerator: "CommandOrControl+Shift+M",
          click: () => {
            sendToRenderer("pqp:toggle-mute");
          },
        },
        {
          label: t("menu.toggleDeafen"),
          accelerator: "CommandOrControl+Shift+D",
          click: () => {
            sendToRenderer("pqp:toggle-deafen");
          },
        },
      ],
    },
    {
      label: t("menu.window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: t("menu.toggleMuteHelp"),
          click: () => {
            sendToRenderer("pqp:toggle-mute");
          },
        },
        {
          label: t("menu.toggleDeafenHelp"),
          click: () => {
            sendToRenderer("pqp:toggle-deafen");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * `fullscreen` is in here for the same reason `display-capture` is, and it was
 * missing for the same reason: Chromium does not decide it, the embedder does.
 *
 * `element.requestFullscreen()` arrives here as a permission request. An
 * embedder that answers `false` does not reject the renderer's promise — it
 * leaves it **pending forever**. No `fullscreenerror`, no `fullscreenchange`,
 * no rejection, so every `catch` in the client is dead code and the button
 * does nothing at all. Reported verbatim as "the new full screen buttons work
 * great on web, but dont work on electron", and reproduced by handing this
 * exact set to a bare BrowserWindow.
 *
 * `automatic-fullscreen` is deliberately NOT here: that is fullscreen with no
 * user gesture, and every fullscreen in this app is a button press.
 */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
  "display-capture",
  "fullscreen",
]);

/**
 * macOS gates the microphone behind TCC, which is a *system* prompt separate
 * from the Chromium permission the renderer asked for. Granting the Chromium
 * one without the system one produces a stream of silence with no error
 * anywhere — the failure mode is "nobody can hear me", not a denied promise.
 *
 * `NSMicrophoneUsageDescription` in the Info.plist (electron-builder
 * `mac.extendInfo`) is what lets the prompt appear at all; without it macOS
 * denies silently. `com.apple.security.device.audio-input` in the entitlements
 * is what lets it appear under the hardened runtime.
 */
async function ensureMacMediaAccess(mediaTypes) {
  if (process.platform !== "darwin") {
    return;
  }
  const wanted = Array.isArray(mediaTypes) && mediaTypes.length > 0
    ? mediaTypes
    : ["audio"];
  for (const type of wanted) {
    if (type !== "audio" && type !== "video") {
      continue;
    }
    const kind = type === "audio" ? "microphone" : "camera";
    try {
      if (systemPreferences.getMediaAccessStatus(kind) === "not-determined") {
        await systemPreferences.askForMediaAccess(kind);
      }
    } catch (err) {
      console.warn(`[pqp] ${kind} access request failed:`, err?.message ?? err);
    }
  }
}

/** macOS screen-recording grant, or "ok" everywhere it does not exist. */
function macScreenAccessStatus() {
  if (process.platform !== "darwin") {
    return "granted";
  }
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    // A macOS that will not answer is not a macOS that has said no.
    return "unknown";
  }
}

/** Parent for a modal, or null when the app window is gone. */
function dialogParent() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

async function showModal(options) {
  const parent = dialogParent();
  try {
    return parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
  } catch {
    return { response: -1 };
  }
}

/**
 * Say that macOS is the one refusing, and offer the switch.
 *
 * Without this the app has no screens to show, shows none, and looks broken.
 * That is the failure shape already fixed twice this week: a control that does
 * nothing and explains nothing. The OS prompt macOS raises on the first
 * attempt is not a substitute, because the grant only takes effect after a
 * relaunch, so somebody who says yes to it still gets an empty picker until
 * they quit and reopen. The copy says that in as many words.
 */
async function explainScreenPermission() {
  const { response } = await showModal({
    type: "warning",
    title: t("share.permissionTitle"),
    message: t("share.permissionTitle"),
    detail: t("share.permissionBody"),
    buttons: [t("share.permissionOpen"), t("share.permissionDismiss")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    shell.openExternal(MAC_SCREEN_SETTINGS_URL).catch(() => {});
  }
}

/** Nothing to offer, and no permission story to tell about it. */
async function explainNoSources() {
  await showModal({
    type: "warning",
    title: t("share.failedTitle"),
    message: t("share.failedTitle"),
    detail: t("share.failedBody"),
    buttons: [t("share.failedDismiss")],
    defaultId: 0,
    noLink: true,
  });
}

/**
 * Put the surfaces in front of the user and wait for an answer.
 *
 * WHY THIS IS A SHELL WINDOW AND NOT REACT. The obvious place for a picker is
 * the client, which already has components, styling and i18n. It is the wrong
 * place. The packaged shell loads the *hosted* client (see DEFAULT_PROD_URL),
 * so the renderer inside any given install is whatever was deployed to Pages
 * today, not what shipped with the binary. A picker over there would mean this
 * handler sending an IPC message and waiting for a reply from code that may
 * predate the message entirely, and there is no reply to wait for: the promise
 * never settles, `getDisplayMedia` hangs, and the share button dies silently
 * in exactly the shells that most need the fix. A `file://` page inside the
 * bundle cannot skew away from the main process that talks to it.
 *
 * Resolves with `{ id, shareAudio }`, or null for every way of saying no: the
 * Cancel button, Escape, closing the window, a page that never loads.
 * `shareAudio` is only meaningful on Windows; the handler still ignores it
 * everywhere else.
 */
function showSourcePicker(labeled) {
  // One at a time. A second voice channel asking mid-decision would stack two
  // identical windows with no way to tell which call each belongs to.
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const parent = dialogParent();
    const dark = nativeTheme.shouldUseDarkColors;
    const win = new BrowserWindow({
      width: 760,
      height: 560,
      minWidth: 460,
      minHeight: 360,
      parent: parent ?? undefined,
      modal: parent !== null,
      show: false,
      title: t("share.title"),
      backgroundColor: dark ? "#1c1c1f" : "#ffffff",
      autoHideMenuBar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, "picker", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    pickerWindow = win;

    let settled = false;
    let loadTimer = setTimeout(() => {
      loadTimer = null;
      console.warn("[pqp] share picker never finished loading");
      finish(null);
    }, PICKER_LOAD_TIMEOUT_MS);

    // Every one of these channels is answered only for this window's own
    // webContents. The app window has a different preload and cannot reach
    // them, but an ipcMain channel is global and this is one line.
    const fromPicker = (event) => !win.isDestroyed() && event.sender === win.webContents;

    const onLoad = (event) =>
      fromPicker(event)
        ? {
            sources: labeled,
            dark,
            offersAudio: windowsLoopbackAllowed(),
            strings: {
              title: t("share.title"),
              subtitle: t("share.subtitle"),
              groupScreens: t("share.groupScreens"),
              groupWindows: t("share.groupWindows"),
              noPreview: t("share.noPreview"),
              cancel: t("share.cancel"),
              confirm: t("share.confirm"),
              empty: t("share.empty"),
              shareAudio: t("share.audio"),
              shareAudioHint: t("share.audioHint"),
            },
          }
        : null;

    const onReady = (event) => {
      if (!fromPicker(event) || loadTimer === null) {
        return;
      }
      clearTimeout(loadTimer);
      loadTimer = null;
    };

    const onChoose = (event, sourceId, shareAudio) => {
      if (!fromPicker(event) || typeof sourceId !== "string") {
        return;
      }
      finish({ id: sourceId, shareAudio: shareAudio === true });
    };

    const onCancel = (event) => {
      if (!fromPicker(event)) {
        return;
      }
      finish(null);
    };

    function finish(choice) {
      if (settled) {
        return;
      }
      settled = true;
      if (loadTimer !== null) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      ipcMain.removeHandler("pqp:picker-load");
      ipcMain.removeListener("pqp:picker-ready", onReady);
      ipcMain.removeListener("pqp:picker-choose", onChoose);
      ipcMain.removeListener("pqp:picker-cancel", onCancel);
      resolve(choice);
      if (!win.isDestroyed()) {
        win.close();
      }
    }

    // `handle` throws on a channel that already has one, and a throw here
    // escapes into the display-media handler and kills the share. The
    // one-at-a-time guard above should make this impossible; this makes the
    // impossible case a no-op instead of a broken button.
    ipcMain.removeHandler("pqp:picker-load");
    ipcMain.handle("pqp:picker-load", onLoad);
    ipcMain.on("pqp:picker-ready", onReady);
    ipcMain.on("pqp:picker-choose", onChoose);
    ipcMain.on("pqp:picker-cancel", onCancel);

    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
      }
    });

    // The titlebar close button, or the whole app quitting mid-decision.
    // Closing without choosing is a cancel, not a failure.
    win.on("closed", () => {
      if (pickerWindow === win) {
        pickerWindow = null;
      }
      finish(null);
    });

    win.webContents.on("did-fail-load", (_e, code, description) => {
      console.warn(`[pqp] share picker failed to load: ${code} ${description}`);
      finish(null);
    });
    win.webContents.on("render-process-gone", () => {
      finish(null);
    });

    // Nothing in this window may navigate anywhere, ever. It renders window
    // titles from other applications and a stray `target=_blank` would be the
    // only way out of a page that has no links in it.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());

    win.loadFile(path.join(__dirname, "picker", "index.html")).catch((err) => {
      console.warn("[pqp] share picker load failed:", err?.message ?? err);
      finish(null);
    });
  });
}

/**
 * The whole "which surface?" decision, from permission to callback payload.
 *
 * Order matters. macOS raises its own screen-recording prompt on the FIRST
 * `getSources` call, so the permission state is read twice: once to skip the
 * listing only when macOS says it can never be granted (`restricted`), and
 * once after, because that listing is what produced whatever answer we now
 * have. `denied` before the listing is NOT a final answer: Electron's screen
 * preflight cannot tell "refused" from "never asked" (see `screenPermission`),
 * and 0.1.5 to 0.1.7 treated it as one, so no Mac was ever prompted. A macOS
 * without the grant does not fail this call, which would be easy to handle. It
 * returns a plausible-looking list of nothing useful, and the only way to know
 * is to ask again.
 */
async function chooseDisplaySource(audioRequested) {
  const platform = process.platform;

  if (screenPermission(platform, macScreenAccessStatus()) === "blocked") {
    await explainScreenPermission();
    return null;
  }

  let raw = [];
  try {
    raw = await desktopCapturer.getSources({
      // The fix, in two words. `["screen"]` alone is why a window could never
      // be picked, and why a second monitor was unreachable behind
      // `sources[0]`.
      types: ["screen", "window"],
      // Previews, because "Untitled" three times over is not a choice. This
      // costs a screenshot of every surface, taken once as the picker opens.
      thumbnailSize: THUMBNAIL_SIZE,
      fetchWindowIcons: true,
    });
  } catch (err) {
    console.warn("[pqp] desktopCapturer.getSources failed:", err?.message ?? err);
  }

  if (screenPermission(platform, macScreenAccessStatus()) !== "ok") {
    // Covers "denied" and the still-undetermined state that means macOS is
    // asking right now: either way the list in hand is not the machine's real
    // surfaces, and showing it would be worse than saying why.
    await explainScreenPermission();
    return null;
  }

  const labeled = labelSources(normalizeSources(raw), t);
  if (labeled.length === 0) {
    await explainNoSources();
    return null;
  }

  const autoId = pickAutomatically(labeled);
  const choice = autoId
    ? { id: autoId, shareAudio: false }
    : await showSourcePicker(labeled);
  if (!choice) {
    return null;
  }

  // Back to the object Electron handed us: the normalized copy is plain data
  // for IPC and is not what the callback accepts.
  const source = raw.find((candidate) => candidate.id === choice.id);
  if (!source) {
    return null;
  }
  // The picker checkbox is the consent. `audioRequested` is only whether the
  // page asked for a track Chromium will accept; an auto-pick (one surface,
  // no dialog) never attaches loopback, because nobody ticked anything.
  return captureResponse(
    source,
    platform,
    audioRequested && choice.shareAudio === true,
    os.release(),
  );
}

function configureSessionSecurity(appOrigin) {
  const ses = session.defaultSession;

  // Computed up front, not after `setDisplayMediaRequestHandler` below: that
  // handler's callback is a closure over this binding, and the origin check
  // it runs has to have a real value to compare against by the time a page
  // actually calls `getDisplayMedia`, which is well after this function
  // returns. Keeping the two together, in order, is what makes that obvious
  // on read rather than merely true at runtime.
  let allowedOrigin = null;
  try {
    allowedOrigin = new URL(appOrigin).origin;
  } catch {
    allowedOrigin = null;
  }

  // Voice / media permissions for Discord-like UX.
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    if (permission === "media") {
      await ensureMacMediaAccess(details?.mediaTypes);
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );

  // `getDisplayMedia` exists in the renderer but resolves NOTHING until the
  // shell answers the request: Chromium delegates "which screen?" to the
  // embedder. Without this handler every share attempt rejects and the client
  // reads it as "unsupported by this browser", which is a lie on desktop and
  // the one claim this product cannot afford to break.
  //
  // `useSystemPicker: false`, AND THAT IS THE POINT OF THIS REGISTRATION.
  // It used to be true, which reads as "prefer the nicer native list on macOS
  // 15+" and actually means "on macOS, none of the code below ever runs":
  // Electron does not call this handler at all when the OS picker takes over.
  // So on the one platform where a share is most likely to go wrong, the
  // screen-recording diagnosis, the settings-pane shortcut, the labelled
  // surface list, the auto-pick and the loopback mapping were all dead code,
  // and every test in `lib/display-sources.test.mjs` was testing a path macOS
  // never took. Pitfall 9 and 12, the same shape twice: the flag that changes
  // the code path was not the flag the tests exercised.
  //
  // It also cost real shares. With the OS picker in front, the renderer's
  // request reaches Chromium untouched, so nothing can strip an audio ask that
  // macOS has no device for (3 Sep 2026: "o picker fecha e a stream não
  // começa", the whole capture refused over a track nobody could have
  // delivered), and nothing can notice that the page asked for a surface this
  // embedder does not have. One handler, all three platforms, is the only
  // shape where the desktop app behaves the way its tests say it does.
  //
  // The trade: macOS now needs the Screen Recording grant, where the OS picker
  // could hand over a surface without one. That is what `screenPermission` and
  // `explainScreenPermission` are for, and they now actually run. Flipping
  // this back to `true` is the one-line rollback if that grant turns out to be
  // the bigger problem; `docs/DESKTOP.md` says so out loud.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      // The shell intentionally keeps some third-party pages in-window (game
      // OAuth: Steam, Battle.net, Twitch), and this handler answers ANY frame
      // that calls `getDisplayMedia`, not just ours. Without this check one of
      // those pages, or one compromised, could ask for the desktop and this
      // handler would hand it over exactly as if the request came from pqp.
      // `request.securityOrigin` is Chromium's own read of the requesting
      // frame, not a value the page can spoof. Chromium serialises it WITH a
      // trailing slash, so compare origins through `URL`, never by string
      // equality (0.1.6 refused every pqp share this way).
      if (!displayRequestAllowed(request, allowedOrigin)) {
        console.warn(
          "[pqp] refused a display-media request from an untrusted origin:",
          request?.securityOrigin ?? "(unknown)",
        );
        callback(null);
        return;
      }
      chooseDisplaySource(request?.audioRequested === true)
        .then((response) => {
          // `null` cancels. Chromium turns that into a NotAllowedError, which
          // the client already words as "blocked or cancelled" rather than as
          // a failure, so backing out of the picker reads as backing out.
          callback(response);
        })
        .catch((err) => {
          console.warn("[pqp] screen capture source failed:", err?.message ?? err);
          callback(null);
        });
    },
    { useSystemPicker: false },
  );

  // Harden navigation: stay on the app origin; open others externally.
  // (`allowedOrigin` is computed once, above, before it is first needed.)
  ses.webRequest.onHeadersReceived((details, callback) => {
    // Do not override remote CSP; only ensure nosniff on our local static origin.
    if (allowedOrigin && details.url.startsWith(allowedOrigin)) {
      const headers = { ...details.responseHeaders };
      if (!headers["X-Content-Type-Options"] && !headers["x-content-type-options"]) {
        headers["X-Content-Type-Options"] = ["nosniff"];
      }
      callback({ responseHeaders: headers });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  return allowedOrigin;
}

function createWindow(appUrl, allowedOrigin) {
  sessionAppOrigin = allowedOrigin;
  const state = loadWindowState(app.getPath("userData"));
  const isMac = process.platform === "darwin";

  // Read before the window exists: backgroundColor cannot be changed later
  // without the user seeing it change.
  const theme = loadTheme(app.getPath("userData"));
  nativeTheme.themeSource = theme;

  mainWindow = new BrowserWindow({
    width: state.width ?? DEFAULTS.width,
    height: state.height ?? DEFAULTS.height,
    x: state.x,
    y: state.y,
    minWidth: DEFAULTS.minWidth,
    minHeight: DEFAULTS.minHeight,
    title: "pqp",
    show: false,
    backgroundColor: BACKGROUNDS[theme],
    autoHideMenuBar: process.platform === "win32",
    // macOS: hiddenInset keeps traffic lights; React draws a slim drag region.
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      // The shell's own version, for the renderer's capability object. A
      // sandboxed preload may only `require("electron")`, so it cannot read
      // package.json and cannot call `app.getVersion()`; `additionalArguments`
      // is the documented way to hand it a build-time fact. Read back in
      // preload.js, which treats a missing one as "unknown" rather than
      // guessing.
      additionalArguments: [
        `--pqp-shell-version=${app.getVersion()}`,
        `--pqp-can-exclude-own-audio=${canExcludeOwnAudioOnThisOs() ? "1" : "0"}`,
      ],
    },
  });

  trackWindowState(mainWindow, app.getPath("userData"));

  // A minimized window otherwise throttles timers past the voice-resume TTL
  // (90s). Held media still needs those timers to rejoin after an API restart.
  mainWindow.webContents.setBackgroundThrottling(false);

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Popups we opened for sign-in, so `did-create-window` can wire the passkey
  // hint onto them and nothing else.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // An auth popup has to stay inside the app: the session it establishes is
    // useless in the system browser. Everything else is a link, and a link
    // belongs in the browser.
    if (classifyNavigation(url, allowedOrigin) === "allow") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: "deny" };
  });

  // The passkey dead end. See lib/passkey-hint.js for why this is all we can
  // do about it, and why we do not touch Google's page to do better.
  mainWindow.webContents.on("did-create-window", (child) => {
    attachPasskeyHint(child);
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const decision = classifyNavigation(url, allowedOrigin);
    if (decision === "allow") {
      return;
    }
    event.preventDefault();
    if (decision === "external") {
      shell.openExternal(url);
    }
  });

  // The global push-to-talk key, and the global mute/deafen toggles, are
  // held only while this window is elsewhere. See syncPushToTalkRegistration
  // and syncGlobalVoiceHotkeys for why focus is the switch.
  mainWindow.on("focus", () => {
    syncPushToTalkRegistration();
    syncNativePushToTalk();
    syncGlobalVoiceHotkeys();
    // Whatever asked for attention (a notification, the badge) is answered
    // now that the window is back in front.
    mainWindow?.flashFrame(false);
  });
  mainWindow.on("blur", () => {
    syncPushToTalkRegistration();
    syncNativePushToTalk();
    syncGlobalVoiceHotkeys();
  });

  /**
   * Closing during a call hides to the tray instead of ending the app.
   *
   * Quitting the shell mid-call drops you out of the call, which is not what
   * the close button means to somebody who is talking to five people and
   * wants the window off their screen. Only during a call, only while the tray
   * preference is on, and never on the way to a real quit — so Cmd+Q, the tray
   * Quit item and an update restart all still work.
   */
  mainWindow.on("close", (event) => {
    if (
      !shouldHideToTray({
        inCall: voiceState.inCall,
        keepInTray: trayPrefs.keepInTray,
        quitting,
      })
    ) {
      return;
    }
    if (!tray || tray.isDestroyed()) {
      // Nothing to minimize *to*. Closing is better than a window that cannot
      // be got back.
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // A window that is gone cannot be typing into, so the shell takes the key.
    syncPushToTalkRegistration();
    syncNativePushToTalk();
    syncGlobalVoiceHotkeys();
  });

  mainWindow.loadURL(appUrl);
}

/**
 * Bring the window back from wherever it went: minimized, hidden to the tray,
 * or closed entirely on macOS. `recreateWindow` is set once the app URL is
 * known; before that there is nothing to show.
 * @type {(() => void) | null}
 */
let recreateWindow = null;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    recreateWindow?.();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function sendVoiceCommand(command) {
  sendToRenderer("pqp:voice-command", command);
  // Mute and deafen are answered in place; leaving a call is the one where the
  // person almost certainly wants to look at the window afterwards.
  if (command === "leave") {
    showMainWindow();
  }
}

/**
 * Repaint the tray from `voiceState` and `trayPrefs`.
 *
 * Rebuilt whole rather than patched: an Electron menu item's label cannot be
 * changed after `buildFromTemplate`, and a nine-item menu is not worth the
 * bookkeeping to do it any other way.
 */
function refreshTray() {
  if (!tray || tray.isDestroyed()) {
    return;
  }
  try {
    tray.setImage(trayIconImage(trayIconKind(voiceState), process.platform));
    tray.setToolTip(trayTooltip(voiceState, t));
    tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayTemplate(voiceState, trayPrefs, t, {
          toggleMute: () => sendVoiceCommand("toggleMute"),
          toggleDeafen: () => sendVoiceCommand("toggleDeafen"),
          leave: () => sendVoiceCommand("leave"),
          show: () => showMainWindow(),
          setKeepInTray: (value) => {
            trayPrefs = { keepInTray: value === true };
            saveTrayPrefs(app.getPath("userData"), trayPrefs);
            refreshTray();
          },
          quit: () => {
            quitting = true;
            app.quit();
          },
        }),
      ),
    );
  } catch (err) {
    console.warn("[pqp] tray refresh failed:", err?.message ?? err);
  }
}

/**
 * Create the tray once, at startup.
 *
 * It stays there whether or not a call is up: a tray icon that appears and
 * disappears is a tray icon nobody can find, and this one is also the only way
 * back to a window that was closed to the tray. A machine with no tray at all
 * (some minimal Linux desktops) throws here, and the app carries on without
 * one — every action in the menu exists elsewhere.
 */
function createTray() {
  if (tray && !tray.isDestroyed()) {
    return;
  }
  try {
    tray = new Tray(trayIconImage("idle", process.platform));
  } catch (err) {
    console.warn("[pqp] tray unavailable:", err?.message ?? err);
    tray = null;
    return;
  }
  // Windows and Linux: a plain click is how people expect to get the window
  // back. macOS opens the menu on click by convention, so leave it alone.
  if (process.platform !== "darwin") {
    tray.on("click", () => showMainWindow());
  }
  tray.on("double-click", () => showMainWindow());
  refreshTray();
}

/**
 * Hold or release the global push-to-talk key.
 *
 * Registered only while the app window is NOT focused. A `globalShortcut` is
 * consumed system-wide, so keeping it while focused would steal the key from
 * the renderer, which has the real keydown / keyup pair and does not have to
 * infer the release from auto-repeat (see lib/global-ptt.js).
 */
function syncPushToTalkRegistration() {
  const focused = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  );
  const wanted = focused ? null : pttAccelerator;
  if (wanted === pttRegistered) {
    return pttRegistered !== null;
  }
  if (pttRegistered) {
    try {
      globalShortcut.unregister(pttRegistered);
    } catch {
      // Already gone (another app took it, the OS dropped it): nothing to do.
    }
    pttRegistered = null;
    // Never inherit a held key across a registration change.
    pttHold.release();
  }
  if (!wanted) {
    return false;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(wanted, () => pttHold.press());
  } catch (err) {
    console.warn("[pqp] push-to-talk register failed:", err?.message ?? err);
    ok = false;
  }
  if (ok) {
    pttRegistered = wanted;
  }
  return ok;
}

/**
 * Take (or drop) a push-to-talk accelerator on the renderer's behalf.
 *
 * Answers whether the key is usable, which is not the same as whether it is
 * registered right now: a request made while the window is focused registers
 * nothing (by design, above), so the answer is a probe — take the key, see if
 * the OS agrees, hand it straight back, then let the focus rule decide. A key
 * another application already owns comes back false and the client stays
 * in-window only.
 */
function setPushToTalkAccelerator(accelerator) {
  if (accelerator === null) {
    pttAccelerator = null;
    syncPushToTalkRegistration();
    return false;
  }
  if (!isAcceptableAccelerator(accelerator)) {
    return false;
  }
  pttAccelerator = accelerator;
  if (syncPushToTalkRegistration()) {
    return true;
  }
  let available = false;
  try {
    available = globalShortcut.register(accelerator, () => pttHold.press());
    if (available) {
      globalShortcut.unregister(accelerator);
    }
  } catch {
    available = false;
  }
  if (!available) {
    pttAccelerator = null;
  }
  return available;
}

/**
 * `globalShortcut` fallback for the NATIVE-PATH binding specifically. Kept
 * as its own registration slot (`pttNativeShortcutRegistered`,
 * `pttNativeShortcutHold`) rather than reusing `pttRegistered` / `pttHold`
 * above: those belong to the OLD bridge (`pqp:ptt-bind` /
 * `bindPushToTalk`), which stays wired exactly as it always was for a
 * client older than `bindPushToTalkNative`. See the comment on that method
 * in `client/src/lib/desktop.ts`. A new client always uses one bridge or
 * the other, never both, but keeping the state separate means that is true
 * by construction rather than by every caller remembering it.
 */
/** @type {string | null} */
let pttNativeShortcutRegistered = null;
const pttNativeShortcutHold = createHoldTracker((held) =>
  sendToRenderer("pqp:ptt-held-native", held),
);

function syncNativeShortcutFallback(wanted) {
  if (wanted === pttNativeShortcutRegistered) {
    return pttNativeShortcutRegistered !== null;
  }
  if (pttNativeShortcutRegistered) {
    try {
      globalShortcut.unregister(pttNativeShortcutRegistered);
    } catch {
      // Already gone.
    }
    pttNativeShortcutRegistered = null;
    pttNativeShortcutHold.release();
  }
  if (!wanted) {
    return false;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(wanted, () => pttNativeShortcutHold.press());
  } catch (err) {
    console.warn(
      "[pqp] push-to-talk shortcut fallback register failed:",
      err?.message ?? err,
    );
    ok = false;
  }
  if (ok) {
    pttNativeShortcutRegistered = wanted;
  }
  return ok;
}

/**
 * Hold or release the native-path push-to-talk binding, choosing between
 * the native hook and the `globalShortcut` fallback, same focus rule as
 * `syncPushToTalkRegistration`: registered only while the window is NOT
 * focused, for the identical reason (the renderer's own listeners are the
 * precise ones while focused, and a registered global hook/shortcut would
 * only compete with them).
 *
 * @returns {{ registered: boolean, via: "native" | "shortcut" | "none", reason?: "wayland" | "denied" | "unavailable" }}
 */
function syncNativePushToTalk() {
  const focused = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  );
  if (focused || !pttNativeBinding) {
    pttNativeSession.stop();
    syncNativeShortcutFallback(null);
    return { registered: false, via: "none" };
  }

  const support = nativeHookPlatformSupport(process.platform);
  const macPermission = macAccessibilityPermission(process.platform, systemPreferences);
  // Do not even attempt the hook when we already know Accessibility is
  // denied: it would either throw or (worse, unobserved) silently receive
  // nothing. See the permission-proxy caveat in `lib/native-ptt-hook.js`:
  // this is a necessary condition, not a sufficient one, so a start()
  // failure below can still happen even when this check passes (Input
  // Monitoring has no query API at all).
  const hookUsable = support.supported && Boolean(loadUiohook()) && macPermission !== "denied";

  if (hookUsable) {
    const result = pttNativeSession.start();
    if (result.ok) {
      syncNativeShortcutFallback(null);
      return { registered: true, via: "native" };
    }
  } else {
    pttNativeSession.stop();
  }

  // Fallback: globalShortcut. Keyboard only, there is no such thing as a
  // mouse-button globalShortcut, so a mouse binding gets nothing here.
  if (pttNativeBinding.device === "keyboard" && pttNativeBinding.accelerator) {
    if (syncNativeShortcutFallback(pttNativeBinding.accelerator)) {
      return { registered: true, via: "shortcut" };
    }
  } else {
    syncNativeShortcutFallback(null);
  }

  const reason = !support.supported ? "wayland" : macPermission === "denied" ? "denied" : "unavailable";
  return { registered: false, via: "none", reason };
}

/**
 * Take (or drop) the native-path push-to-talk binding on the renderer's
 * behalf. Mirrors `setPushToTalkAccelerator`'s shape but carries the whole
 * `DesktopPttBinding` (device, code, chord, and the accelerator the
 * renderer already computed for the fallback) rather than only an
 * accelerator string, because this path also has to handle a mouse button,
 * which has no accelerator at all.
 */
function setNativePushToTalkBinding(binding, releaseDelayMs) {
  if (binding !== null) {
    const looksValid =
      binding &&
      typeof binding === "object" &&
      (binding.device === "keyboard" || binding.device === "mouse") &&
      typeof binding.code === "string" &&
      binding.code.length > 0;
    if (!looksValid) {
      return { registered: false, via: "none" };
    }
    // A client-computed accelerator we would refuse to register anyway.
    // `globalShortcut.register` throws on garbage and would take the IPC
    // handler down with it. Treat it as absent rather than trusting it.
    if (
      binding.device === "keyboard" &&
      binding.accelerator !== null &&
      !isAcceptableAccelerator(binding.accelerator)
    ) {
      binding = { ...binding, accelerator: null };
    } else if (binding.device === "mouse") {
      binding = { ...binding, accelerator: null };
    }
  }
  pttNativeBinding = binding;
  if (typeof releaseDelayMs === "number") {
    pttReleaseDelayMs = clampReleaseDelayMs(releaseDelayMs);
    pttNativeSession.setReleaseDelayMs(pttReleaseDelayMs);
  }
  return syncNativePushToTalk();
}

const GLOBAL_VOICE_ACTIONS = ["toggleMute", "toggleDeafen"];

/**
 * Hold or release the global mute/deafen toggles.
 *
 * Registered only while the app window is NOT focused, for the same reason
 * as push-to-talk: a registered `globalShortcut` is swallowed system-wide, so
 * keeping it while focused would steal the chord from the app menu (default
 * chord) or the renderer's own key listener (a remap) and fire the toggle
 * twice for one press. Unlike push-to-talk there is no hold to infer: each
 * one is `globalShortcut.register(accel, () => sendVoiceCommand(action))`,
 * a single fire per press, same as any other toggle.
 */
function syncGlobalVoiceHotkeys() {
  const focused = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  );
  for (const action of GLOBAL_VOICE_ACTIONS) {
    const wanted = focused ? null : globalVoiceHotkeys[action];
    const current = globalVoiceRegistered[action];
    if (wanted === current) {
      continue;
    }
    if (current) {
      try {
        globalShortcut.unregister(current);
      } catch {
        // Already gone (another app took it, the OS dropped it): nothing to do.
      }
      globalVoiceRegistered[action] = null;
    }
    if (!wanted) {
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(wanted, () => sendVoiceCommand(action));
    } catch (err) {
      console.warn(`[pqp] global ${action} register failed:`, err?.message ?? err);
      ok = false;
    }
    if (ok) {
      globalVoiceRegistered[action] = wanted;
    }
  }
}

/**
 * Take (or drop) the global mute/deafen accelerators on the renderer's
 * behalf. Mirrors `setPushToTalkAccelerator`: probes each requested
 * accelerator so the answer is accurate even while the window is focused and
 * `syncGlobalVoiceHotkeys` is deliberately holding neither of them.
 *
 * @param {{ toggleMute: string | null, toggleDeafen: string | null }} accelerators
 * @returns {{ toggleMute: boolean, toggleDeafen: boolean }}
 */
function setGlobalVoiceHotkeys(accelerators) {
  for (const action of GLOBAL_VOICE_ACTIONS) {
    const accelerator = accelerators?.[action] ?? null;
    globalVoiceHotkeys[action] =
      accelerator !== null && isAcceptableAccelerator(accelerator)
        ? accelerator
        : null;
  }
  syncGlobalVoiceHotkeys();

  const result = { toggleMute: false, toggleDeafen: false };
  for (const action of GLOBAL_VOICE_ACTIONS) {
    const wanted = globalVoiceHotkeys[action];
    if (!wanted) {
      continue;
    }
    if (globalVoiceRegistered[action] === wanted) {
      result[action] = true;
      continue;
    }
    // The window is focused, so `syncGlobalVoiceHotkeys` just let this key
    // go on purpose. Probe it: take it, see if the OS agrees, hand it right
    // back, and let the focus rule register it for real on the next blur.
    let available = false;
    try {
      available = globalShortcut.register(wanted, () => sendVoiceCommand(action));
      if (available) {
        globalShortcut.unregister(wanted);
      }
    } catch {
      available = false;
    }
    if (!available) {
      globalVoiceHotkeys[action] = null;
    }
    result[action] = available;
  }
  return result;
}

function collectDeepLinkFromArgv(argv) {
  const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (link) {
    handleDeepLink(link);
  }
}

// Single instance — required for deep links on Windows/Linux.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    collectDeepLinkFromArgv(argv);
    // `showMainWindow` rather than focus: the first instance may be hidden in
    // the tray, and launching the app again is a request to see it.
    showMainWindow();
  });

  // macOS deep links
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  ipcMain.handle("pqp:get-pending-deep-link", () => {
    const value = pendingDeepLink;
    pendingDeepLink = null;
    return value;
  });

  ipcMain.handle("pqp:start-desktop-auth", (event, mode) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return { ok: false, url: "" };
    }
    return desktopAuth.start(mode === "sign-up" ? "sign-up" : "sign-in");
  });

  ipcMain.handle("pqp:cancel-desktop-auth", (event) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return;
    }
    desktopAuth.stop("cancelled");
  });

  ipcMain.handle("pqp:desktop-auth-status", (event) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return { active: false, url: null };
    }
    return desktopAuth.status();
  });

  ipcMain.handle("pqp:get-pending-desktop-auth-ticket", (event) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return null;
    }
    return desktopAuth.takePendingTicket();
  });

  ipcMain.on("pqp:set-theme", (_event, theme) => {
    if (theme !== "dark" && theme !== "light") {
      return;
    }
    nativeTheme.themeSource = theme;
    saveTheme(app.getPath("userData"), theme);
  });

  ipcMain.handle("pqp:set-locale", (_event, locale) => {
    saveLocale(app.getPath("userData"), locale);
    const next = loadLocale(app.getPath("userData"), app.getLocale());
    setLanguage(next);
    createAppMenu();
    // The tray menu is built from the same catalogue and would otherwise keep
    // the old language until the next state change.
    refreshTray();
    return next;
  });

  /**
   * Launch at login. Supported on macOS and Windows only (see
   * lib/login-item.js); Linux answers false to both and changes nothing,
   * rather than a toggle that looks like it worked and does not.
   */
  // Same sender-origin check as the desktop-auth handlers above: this
  // toggles an OS-level login item, a host-level persistence setting that
  // an untrusted page navigated into a window retaining this preload (or a
  // renderer XSS) must not be able to flip, unlike, say, pqp:set-theme
  // (Farol review, PR 675).
  ipcMain.handle("pqp:get-start-at-login", (event) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return false;
    }
    if (!loginItemSupported(process.platform)) {
      return false;
    }
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch (err) {
      console.warn("[pqp] read start-at-login failed:", err?.message ?? err);
      return false;
    }
  });

  ipcMain.handle("pqp:set-start-at-login", (event, value) => {
    if (!senderMatchesAppOrigin(event, sessionAppOrigin)) {
      return false;
    }
    if (!loginItemSupported(process.platform)) {
      return false;
    }
    const desired = value === true;
    try {
      app.setLoginItemSettings({ openAtLogin: desired });
    } catch (err) {
      console.warn("[pqp] set start-at-login failed:", err?.message ?? err);
      return false;
    }
    // The write already succeeded at this point. Read back only to catch a
    // genuine mismatch (the OS silently refusing) rather than letting a
    // transient readback failure report a successful write as disabled
    // (Farol review, PR 675) -- the renderer would overwrite its toggle to
    // "off" while the app still launches at login.
    try {
      return app.getLoginItemSettings().openAtLogin === true;
    } catch (err) {
      console.warn("[pqp] read-back after set start-at-login failed:", err?.message ?? err);
      return desired;
    }
  });

  ipcMain.on("pqp:set-badge", (_event, count) => {
    if (!Number.isFinite(count)) {
      return;
    }
    applyBadgeCount(Math.max(0, Math.floor(count)));
  });

  ipcMain.handle("pqp:ptt-bind", (_event, accelerator) => {
    if (accelerator !== null && typeof accelerator !== "string") {
      return false;
    }
    return setPushToTalkAccelerator(accelerator);
  });

  ipcMain.handle("pqp:ptt-bind-native", (_event, binding, releaseDelayMs) => {
    if (binding !== null && typeof binding !== "object") {
      return { registered: false, via: "none" };
    }
    return setNativePushToTalkBinding(binding, releaseDelayMs);
  });

  ipcMain.handle("pqp:ptt-permission-status", () => {
    return macAccessibilityPermission(process.platform, systemPreferences);
  });

  // Read-only, binds nothing: lets the settings UI explain the native hook
  // (or say why it cannot run, Wayland chiefly) before anyone has joined a
  // call to actually try it. `syncNativePushToTalk` re-derives the same
  // thing every time it runs; this is the same probe, just callable without
  // a binding already in place.
  ipcMain.handle("pqp:ptt-native-capability", () => {
    return nativeHookPlatformSupport(process.platform);
  });

  ipcMain.on("pqp:ptt-open-permission-settings", () => {
    if (process.platform !== "darwin") {
      return;
    }
    // Both panes: Accessibility is the half we can even ask about, Input
    // Monitoring is the other half of what a global key/mouse hook needs and
    // Electron exposes no query for it at all. Opening both a second time
    // just re-navigates an already-open System Settings window, it does not
    // spawn a second one.
    shell.openExternal(MAC_ACCESSIBILITY_SETTINGS_URL).catch(() => {});
    shell.openExternal(MAC_INPUT_MONITORING_SETTINGS_URL).catch(() => {});
  });

  ipcMain.handle("pqp:global-voice-bind", (_event, accelerators) => {
    const toggleMute =
      accelerators && typeof accelerators === "object"
        ? (accelerators.toggleMute ?? null)
        : null;
    const toggleDeafen =
      accelerators && typeof accelerators === "object"
        ? (accelerators.toggleDeafen ?? null)
        : null;
    if (
      (toggleMute !== null && typeof toggleMute !== "string") ||
      (toggleDeafen !== null && typeof toggleDeafen !== "string")
    ) {
      return { toggleMute: false, toggleDeafen: false };
    }
    return setGlobalVoiceHotkeys({ toggleMute, toggleDeafen });
  });

  ipcMain.on("pqp:voice-state", (_event, payload) => {
    const next = normalizeVoiceState(payload);
    if (
      next.inCall === voiceState.inCall &&
      next.muted === voiceState.muted &&
      next.deafened === voiceState.deafened
    ) {
      return;
    }
    voiceState = next;
    refreshTray();
  });

  ipcMain.on("pqp:notify", (_event, payload) => {
    if (!payload || typeof payload.title !== "string") {
      return;
    }
    showNotification({
      title: payload.title,
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : "",
      path: sanitizeAppPath(payload.path),
    });
  });

  app.whenReady().then(async () => {
    app.setName("pqp");
    registerProtocolClient();
    const locale = loadLocale(app.getPath("userData"), app.getLocale());
    setLanguage(locale);
    createAppMenu();
    trayPrefs = loadTrayPrefs(app.getPath("userData"));
    createTray();
    collectDeepLinkFromArgv(process.argv);

    let appUrl;
    try {
      appUrl = await resolveAppUrl();
    } catch (err) {
      console.error("[pqp]", err.message || err);
      app.quit();
      return;
    }

    console.log(`[pqp] Loading ${appUrl}`);
    const allowedOrigin = configureSessionSecurity(appUrl);
    recreateWindow = () => createWindow(appUrl, allowedOrigin);
    createWindow(appUrl, allowedOrigin);
    initAutoUpdate(() => mainWindow);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(appUrl, allowedOrigin);
      } else if (mainWindow) {
        mainWindow.show();
      }
    });
  });

  app.on("window-all-closed", () => {
    // The tray keeps the app alive on every platform now: closing the window
    // during a call hides it, and hiding is not a reason to quit and hang up.
    // Without a tray (or without a call) the old rule stands.
    if (process.platform === "darwin") {
      return;
    }
    if (tray && !tray.isDestroyed() && voiceState.inCall && !quitting) {
      return;
    }
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    desktopAuth.stop();
    if (staticServer) {
      const server = staticServer;
      staticServer = null;
      server.close().catch(() => {});
    }
  });

  // Belt and braces: Electron unregisters on exit anyway, but a stuck global
  // hotkey is the failure people would have to reboot to clear.
  app.on("will-quit", () => {
    pttAccelerator = null;
    pttRegistered = null;
    pttHold.dispose();
    pttNativeBinding = null;
    pttNativeSession.dispose();
    pttNativeShortcutRegistered = null;
    pttNativeShortcutHold.dispose();
    globalVoiceHotkeys = { toggleMute: null, toggleDeafen: null };
    globalVoiceRegistered = { toggleMute: null, toggleDeafen: null };
    globalShortcut.unregisterAll();
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
    }
    tray = null;
  });
}
