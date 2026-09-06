/**
 * Loopback listener for the desktop system-browser handoff.
 *
 * Lives here so start / deliver / timeout can be tested without booting
 * Electron. main.js only supplies openExternal, the renderer send, and focus.
 */

const http = require("node:http");
const {
  LISTENER_TTL_MS,
  createState,
  buildDesktopLoginUrl,
  buildDoneUrl,
  classifyCallbackRequest,
} = require("./desktop-auth");

function writeAuthResponse(res, status, extraHeaders, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * @param {{
 *   openExternal: (url: string) => Promise<unknown>,
 *   send: (channel: string, ...args: unknown[]) => void,
 *   getAppOrigin: () => string | null,
 *   onDelivered?: () => void,
 *   createServer?: typeof http.createServer,
 *   ttlMs?: number,
 * }} deps
 */
function createDesktopAuthController(deps) {
  const createServer = deps.createServer ?? http.createServer;
  const ttlMs = deps.ttlMs ?? LISTENER_TTL_MS;

  /** @type {{ server: import("http").Server, port: number, state: string, url: string, timer: ReturnType<typeof setTimeout> | null } | null} */
  let session = null;
  /** @type {Promise<{ ok: boolean, url: string }> | null} */
  let starting = null;
  /** @type {string | null} */
  let pendingTicket = null;

  function armTimer() {
    if (!session) {
      return;
    }
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      stop("expired");
    }, ttlMs);
  }

  function stop(reason) {
    if (!session) {
      return;
    }
    clearTimeout(session.timer);
    session.server.close();
    session = null;
    if (reason === "expired" || reason === "cancelled") {
      deps.send("pqp:desktop-auth-ended", reason);
    }
  }

  function status() {
    return {
      active: session !== null,
      url: session?.url ?? null,
    };
  }

  function takePendingTicket() {
    const value = pendingTicket;
    pendingTicket = null;
    return value;
  }

  function deliverTicket(ticket) {
    // Always stash. send() returning true only means a window exists; a
    // renderer mid-reload still misses the IPC. takePendingTicket is the ack.
    pendingTicket = ticket;
    deps.send("pqp:desktop-auth-ticket", ticket);
    deps.onDelivered?.();
  }

  async function open(url) {
    try {
      await deps.openExternal(url);
      return { ok: true, url };
    } catch {
      return { ok: false, url };
    }
  }

  function reuse(mode, appOrigin) {
    if (!session) {
      return Promise.resolve({ ok: false, url: "" });
    }
    const url =
      buildDesktopLoginUrl({
        appOrigin,
        mode,
        port: session.port,
        state: session.state,
      }) ?? session.url;
    session.url = url;
    armTimer();
    return open(url);
  }

  function start(mode) {
    const appOrigin = deps.getAppOrigin();
    if (!appOrigin) {
      return Promise.resolve({ ok: false, url: "" });
    }

    if (starting) {
      return starting.then(() => start(mode));
    }

    if (session) {
      return reuse(mode, appOrigin);
    }

    starting = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        starting = null;
        resolve(result);
      };

      const state = createState();
      const server = createServer((req, res) => {
        const current = session;
        const decision = classifyCallbackRequest({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          host: req.headers.host ?? "",
          expectedPort: current?.port,
          expectedState: current?.state,
        });
        if (decision.action === "ignore") {
          writeAuthResponse(res, 404, {}, "");
          return;
        }
        if (decision.action === "reject") {
          writeAuthResponse(res, 400, {}, "");
          return;
        }
        const done = buildDoneUrl(appOrigin) ?? appOrigin;
        writeAuthResponse(res, 302, { Location: done }, "<!doctype html><p>ok</p>");
        const ticket = decision.ticket;
        setImmediate(() => {
          stop();
          deliverTicket(ticket);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          address && typeof address === "object" ? address.port : 0;
        const url = buildDesktopLoginUrl({
          appOrigin,
          mode,
          port,
          state,
        });
        if (!url) {
          server.close();
          finish({ ok: false, url: "" });
          return;
        }
        session = { server, port, state, url, timer: null };
        armTimer();
        finish(open(url));
      });
      server.on("error", () => {
        finish({ ok: false, url: "" });
      });
    });
    return starting;
  }

  return {
    start,
    stop,
    status,
    takePendingTicket,
    deliverTicket,
  };
}

module.exports = {
  createDesktopAuthController,
};
