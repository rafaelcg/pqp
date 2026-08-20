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
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { loadWindowState, trackWindowState, DEFAULTS } = require("./lib/window-state");
const { loadTheme, saveTheme, BACKGROUNDS } = require("./lib/theme-state");
const { loadLocale, saveLocale } = require("./lib/locale-state");
const { setLanguage, t } = require("./lib/i18n");
const { startStaticServer } = require("./lib/static-server");
const { waitForUrl, isLocalDevUrl } = require("./lib/wait-for-url");
const { classifyNavigation } = require("./lib/nav-policy");
const { initAutoUpdate } = require("./lib/updater");

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

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ url: string, close: () => Promise<void> } | null} */
let staticServer = null;
/** @type {string | null} */
let pendingDeepLink = null;

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

function sendToRenderer(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, ...args);
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
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const ALLOWED_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
  "display-capture",
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

function configureSessionSecurity(appOrigin) {
  const ses = session.defaultSession;

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

  // Harden navigation: stay on the app origin; open others externally.
  let allowedOrigin = null;
  try {
    allowedOrigin = new URL(appOrigin).origin;
  } catch {
    allowedOrigin = null;
  }

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
    },
  });

  trackWindowState(mainWindow, app.getPath("userData"));

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(appUrl);
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
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
    return next;
  });

  ipcMain.on("pqp:set-badge", (_event, count) => {
    if (!Number.isFinite(count)) {
      return;
    }
    applyBadgeCount(Math.max(0, Math.floor(count)));
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
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    if (staticServer) {
      const server = staticServer;
      staticServer = null;
      server.close().catch(() => {});
    }
  });
}
