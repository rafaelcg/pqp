/**
 * Poll until a URL responds (Vite ready) or timeout.
 */
async function waitForUrl(url, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Any HTTP response means the server is up (including 404 on SPA).
      if (res.status > 0) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const detail = lastError?.message ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms${detail}`);
}

function isLocalDevUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      (parsed.protocol === "http:" || parsed.protocol === "https:")
    );
  } catch {
    return false;
  }
}

module.exports = {
  waitForUrl,
  isLocalDevUrl,
};
