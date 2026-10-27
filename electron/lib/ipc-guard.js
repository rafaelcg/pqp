const { senderMatchesAppOrigin } = require("./ipc-origin");

/**
 * The one place every `ipcMain` channel in this shell is registered through.
 *
 * WHY IT EXISTS. The main window's preload is injected on every navigation of
 * that window, including the sign-in and game-connection hosts the navigation
 * policy lets finish in-window (`lib/nav-policy.js`), so `window.pqpDesktop`
 * exists on pages that are not pqp. An `ipcMain` channel is global and does not
 * know who is calling. Until this file, 19 call sites remembered to ask and a
 * dozen did not, one of them the channel that installs the global key hook
 * (`pqp:ptt-bind-native`). "Remember to check" is not a control, so the check
 * moved to the registration: there is no way to register a channel here without
 * it, and `ipc-guard.test.mjs` fails on a direct `ipcMain.handle` or
 * `ipcMain.on` anywhere in `main.js`.
 *
 * WHICH ORIGINS. The app origin the shell loaded (`sessionAppOrigin`), the same
 * value the navigation pinning is built from. The navigation policy ALSO lets
 * auth hosts render in-window, because a sign-in hop has to finish there; that
 * second set is deliberately not accepted here, since those are exactly the
 * pages this guard exists to keep away from the bridge.
 *
 * FAIL CLOSED. No app origin, no frame (a frame that navigated away or was
 * destroyed has no `senderFrame`), or an unparseable URL is a rejection.
 *
 * One more class: the share picker is a `file://` page in its own window, so it
 * has no web origin to match. It is accepted by webContents identity (`sender`
 * below) and by nothing else.
 */

/** A rejection is logged once per channel and origin per window, never per call. */
const LOG_WINDOW_MS = 30_000;
const LOG_KEYS_MAX = 256;

/**
 * Only the origin of the offending frame goes in the line (`https://host`), never
 * its path or query, and nothing from the payload.
 *
 * @param {{ senderFrame?: { url?: string } | null }} event
 */
function frameOrigin(event) {
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl !== "string" || frameUrl.length === 0) {
    return "none";
  }
  try {
    const parsed = new URL(frameUrl);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "unparseable";
  }
}

/**
 * @param {{
 *   ipcMain?: {
 *     handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void,
 *     on: (channel: string, listener: (event: any, ...args: any[]) => void) => void,
 *   },
 *   getAppOrigin: () => string | null | undefined,
 *   warn?: (message: string) => void,
 *   now?: () => number,
 * }} options
 */
function createIpcGuard({ ipcMain, getAppOrigin, warn = console.warn, now = Date.now }) {
  /** @type {Map<string, number>} */
  const lastLogged = new Map();

  function report(channel, event) {
    const origin = frameOrigin(event);
    const key = `${channel}|${origin}`;
    const at = now();
    const previous = lastLogged.get(key);
    if (previous !== undefined && at - previous < LOG_WINDOW_MS) {
      return;
    }
    if (lastLogged.size >= LOG_KEYS_MAX) {
      lastLogged.clear();
    }
    lastLogged.set(key, at);
    warn(`[pqp] ipc rejected: channel=${channel} sender-origin=${origin}`);
  }

  /**
   * @param {any} event
   * @param {string} channel
   * @param {{ sender?: { isDestroyed?: () => boolean } | null }} [options]
   *   `sender`: accept exactly this webContents instead of an origin.
   * @returns {boolean}
   */
  function check(event, channel, options = {}) {
    let ok;
    if (options.sender !== undefined) {
      const target = options.sender;
      ok =
        target !== null &&
        !(typeof target.isDestroyed === "function" && target.isDestroyed()) &&
        event?.sender === target;
    } else {
      ok = senderMatchesAppOrigin(event, getAppOrigin());
    }
    if (!ok) {
      report(channel, event);
    }
    return ok;
  }

  /**
   * `ipcMain.handle`, answering `rejected` (a value, or a function of the event)
   * to a sender that fails the check. The handler does not run.
   *
   * @param {string} channel
   * @param {(event: any, ...args: any[]) => any} handler
   * @param {{ rejected?: unknown }} [options]
   */
  function handle(channel, handler, options = {}) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!check(event, channel)) {
        return typeof options.rejected === "function"
          ? options.rejected(event)
          : options.rejected;
      }
      return handler(event, ...args);
    });
  }

  /**
   * `ipcMain.on`. A rejected sender is dropped.
   *
   * @param {string} channel
   * @param {(event: any, ...args: any[]) => void} handler
   */
  function on(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      if (!check(event, channel)) {
        return;
      }
      handler(event, ...args);
    });
  }

  return { check, handle, on };
}

module.exports = { createIpcGuard, frameOrigin };
