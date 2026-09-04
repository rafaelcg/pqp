/**
 * Desktop system-browser sign-in: URL building and loopback request checks.
 *
 * The http server itself lives in main.js. This file is the part that can
 * be tested without opening a port: what URL we hand Chrome, and which
 * incoming requests are a real callback vs noise that must not kill the
 * listener (favicon, a wrong state, a Host that is not 127.0.0.1).
 */

const { randomBytes, timingSafeEqual } = require("node:crypto");

const LISTENER_TTL_MS = 10 * 60 * 1000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function createState() {
  return randomBytes(16).toString("hex");
}

function statesEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function isAllowedAppOrigin(url, appOrigin) {
  if (typeof url !== "string" || typeof appOrigin !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url);
    const origin = new URL(appOrigin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin.origin
    );
  } catch {
    return false;
  }
}

function normalizeMode(mode) {
  return mode === "sign-up" ? "sign-up" : "sign-in";
}

function buildLoopbackReturn(port) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return null;
  }
  return `http://127.0.0.1:${port}/callback`;
}

function buildDesktopLoginUrl({ appOrigin, mode, port, state }) {
  if (!isAllowedAppOrigin(appOrigin, appOrigin)) {
    return null;
  }
  const returnTo = buildLoopbackReturn(port);
  if (!returnTo || typeof state !== "string" || state.length === 0) {
    return null;
  }
  const url = new URL("/desktop-login", appOrigin);
  url.searchParams.set("mode", normalizeMode(mode));
  url.searchParams.set("return", returnTo);
  url.searchParams.set("state", state);
  return url.toString();
}

function buildDoneUrl(appOrigin) {
  if (!isAllowedAppOrigin(appOrigin, appOrigin)) {
    return null;
  }
  const url = new URL("/desktop-login", appOrigin);
  url.searchParams.set("done", "1");
  return url.toString();
}

/**
 * @returns {"ignore" | "reject" | "accept"}
 */
function classifyCallbackRequest({
  method,
  url,
  host,
  expectedPort,
  expectedState,
}) {
  let parsed;
  try {
    parsed = new URL(url, "http://127.0.0.1");
  } catch {
    return { action: "ignore" };
  }
  if (method !== "GET" || parsed.pathname !== "/callback") {
    return { action: "ignore" };
  }
  const expectedHost = `127.0.0.1:${expectedPort}`;
  if (host !== expectedHost) {
    return { action: "reject" };
  }
  const state = parsed.searchParams.get("state") ?? "";
  const ticket = parsed.searchParams.get("ticket") ?? "";
  if (!ticket || !statesEqual(state, expectedState)) {
    return { action: "reject" };
  }
  return { action: "accept", ticket };
}

module.exports = {
  LISTENER_TTL_MS,
  MIN_PORT,
  MAX_PORT,
  createState,
  statesEqual,
  isAllowedAppOrigin,
  normalizeMode,
  buildLoopbackReturn,
  buildDesktopLoginUrl,
  buildDoneUrl,
  classifyCallbackRequest,
};
