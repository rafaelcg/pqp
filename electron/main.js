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
const {
  PASSKEY_HINT_DELAY_MS,
  mayPromptForPasskey,
} = require("./lib/passkey-hint");
const { initAutoUpdate } = require("./lib/updater");
const {
  THUMBNAIL_SIZE,
  MAC_SCREEN_SETTINGS_URL,
  normalizeSources,
  labelSources,
  pickAutomatically,
  screenPermission,
  captureResponse,
} = require("./lib/display-sources");

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
/** @type {BrowserWindow | null} */
let pickerWindow = null;

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
 * Resolves with a source id, or null for every way of saying no: the Cancel
 * button, Escape, closing the window, a page that never loads.
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
            strings: {
              title: t("share.title"),
              subtitle: t("share.subtitle"),
              groupScreens: t("share.groupScreens"),
              groupWindows: t("share.groupWindows"),
              noPreview: t("share.noPreview"),
              cancel: t("share.cancel"),
              confirm: t("share.confirm"),
              empty: t("share.empty"),
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

    const onChoose = (event, sourceId) => {
      if (!fromPicker(event) || typeof sourceId !== "string") {
        return;
      }
      finish(sourceId);
    };

    const onCancel = (event) => {
      if (!fromPicker(event)) {
        return;
      }
      finish(null);
    };

    function finish(sourceId) {
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
      resolve(sourceId);
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
 * `getSources` call, so the permission state is read twice: once to avoid a
 * pointless listing when we already know the answer is no, and once after,
 * because that listing is what produced whatever answer we now have. A macOS
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

  const chosenId = pickAutomatically(labeled) ?? (await showSourcePicker(labeled));
  if (!chosenId) {
    return null;
  }

  // Back to the object Electron handed us: the normalized copy is plain data
  // for IPC and is not what the callback accepts.
  const source = raw.find((candidate) => candidate.id === chosenId);
  if (!source) {
    return null;
  }
  return captureResponse(source, platform, audioRequested);
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

  // `getDisplayMedia` exists in the renderer but resolves NOTHING until the
  // shell answers the request: Chromium delegates "which screen?" to the
  // embedder. Without this handler every share attempt rejects and the client
  // reads it as "unsupported by this browser", which is a lie on desktop and
  // the one claim this product cannot afford to break.
  //
  // `useSystemPicker` stays on and stays first. On macOS 15+ the OS picker is
  // better than anything shipped here: it is the surface list the user already
  // knows, it can hand over a surface without a screen-recording grant, and it
  // keeps working when they switch windows mid-share. Electron does not call
  // this handler at all when it takes over. Everything below is the fallback,
  // which is where every Windows and Linux user and every macOS before 15
  // lands, and which until now silently shared `sources[0]` of `["screen"]`:
  // the primary display, no choice of monitor, and no way to share a single
  // window. That is the 23 Aug 2026 report.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
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
    { useSystemPicker: true },
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
