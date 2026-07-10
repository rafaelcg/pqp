const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  session,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { loadWindowState, trackWindowState, DEFAULTS } = require("./lib/window-state");
const { startStaticServer } = require("./lib/static-server");
const { waitForUrl, isLocalDevUrl } = require("./lib/wait-for-url");

const PROTOCOL = "pqp";
const DEFAULT_DEV_URL = "http://localhost:5173/app";
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

function wantsStaticLoad() {
  const flag = process.env.PQP_LOAD_STATIC;
  if (flag === "1" || flag === "true") {
    return true;
  }
  if (flag === "0" || flag === "false") {
    return false;
  }
  // Packaged builds prefer bundled client when present and no remote URL set.
  if (app.isPackaged && !process.env.PQP_APP_URL && !process.env.VITE_APP_URL) {
    const indexHtml = path.join(resolveClientDist(), "index.html");
    return fs.existsSync(indexHtml);
  }
  return false;
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
      DEFAULT_DEV_URL,
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
      label: "Edit",
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
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    {
      label: "View",
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
          label: "Toggle Mute",
          accelerator: "CommandOrControl+Shift+M",
          click: () => {
            sendToRenderer("pqp:toggle-mute");
          },
        },
      ],
    },
    {
      label: "Window",
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
          label: "Toggle Mute (Cmd/Ctrl+Shift+M)",
          click: () => {
            sendToRenderer("pqp:toggle-mute");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configureSessionSecurity(appOrigin) {
  const ses = session.defaultSession;

  // Voice / media permissions for Discord-like UX.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = new Set([
      "media",
      "mediaKeySystem",
      "notifications",
      "clipboard-sanitized-write",
      "clipboard-read",
      "display-capture",
    ]);
    callback(allowed.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) => {
    const allowed = new Set([
      "media",
      "mediaKeySystem",
      "notifications",
      "clipboard-sanitized-write",
      "clipboard-read",
      "display-capture",
    ]);
    return allowed.has(permission);
  });

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

  mainWindow = new BrowserWindow({
    width: state.width ?? DEFAULTS.width,
    height: state.height ?? DEFAULTS.height,
    x: state.x,
    y: state.y,
    minWidth: DEFAULTS.minWidth,
    minHeight: DEFAULTS.minHeight,
    title: "pqp",
    show: false,
    backgroundColor: "#1a1f2a",
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
    if (!allowedOrigin) {
      return;
    }
    try {
      const next = new URL(url);
      if (next.origin !== allowedOrigin) {
        event.preventDefault();
        if (next.protocol === "http:" || next.protocol === "https:") {
          shell.openExternal(url);
        }
      }
    } catch {
      event.preventDefault();
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

  app.whenReady().then(async () => {
    app.setName("pqp");
    registerProtocolClient();
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
