"use strict";

/**
 * Decides whether a `getDisplayMedia` request may be answered by the shell.
 *
 * Chromium hands `setDisplayMediaRequestHandler` a `securityOrigin` string,
 * and that string is serialised WITH a trailing slash ("https://pqp.gg/"),
 * while `new URL(url).origin` never carries one ("https://pqp.gg"). The 0.1.6
 * handler compared the two with `!==`, so every share request from pqp itself
 * was refused as "untrusted" and the Share button did nothing in a call
 * (2026-09-13: "Dps da atualização não to conseguindo gravar tela").
 *
 * Normalise both sides through `URL` and compare origins. When Chromium gives
 * no `securityOrigin` at all (older builds, some packaged paths), fall back to
 * the requesting frame's URL, which is also Chromium's own read and not a
 * value the page can set.
 */
function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function displayRequestAllowed(request, allowedOrigin) {
  const allowed = normalizeOrigin(allowedOrigin);
  if (!allowed) return false;
  const fromSecurityOrigin = normalizeOrigin(request?.securityOrigin);
  if (fromSecurityOrigin) return fromSecurityOrigin === allowed;
  const fromFrame = normalizeOrigin(request?.frame?.url);
  if (fromFrame) return fromFrame === allowed;
  return false;
}

module.exports = { displayRequestAllowed, normalizeOrigin };
