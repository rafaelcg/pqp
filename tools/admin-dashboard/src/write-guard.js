/**
 * Which operator WRITES the Worker will forward.
 *
 * The Worker is behind HTTP Basic Auth, and a browser that has the credentials
 * cached sends them with a request from ANY page. A cross-site page cannot read
 * the answer, but a "simple" request (a POST with a text/plain body, no custom
 * header) needs no CORS preflight and would still be forwarded, with the
 * machine token added, as a write. This closes that, for every write at once:
 *
 *  - the body must declare `application/json`, which no simple request can: a
 *    cross-site page that sets it triggers a preflight, and this Worker answers
 *    no CORS headers, so the browser never sends the real request;
 *  - a request that names an `Origin` or a `Sec-Fetch-Site` must be from this
 *    very origin (`Sec-Fetch-Site: none` is the address bar, never a page).
 *
 * Plain JS with a `.d.ts` beside it, the way `tools/hls-edge` keeps what CI can
 * run under `node --test` (see `test/write-guard.test.js`).
 *
 * @param {{ get(name: string): string | null }} headers
 * @param {string} workerOrigin  the origin this Worker is served from
 * @returns {{ status: number, error: string } | null}  a refusal, or null
 */
export function writeRefusal(headers, workerOrigin) {
  const type = headers.get("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return { status: 415, error: "writes must be application/json" };
  }
  const origin = headers.get("Origin");
  if (origin !== null && origin !== workerOrigin) {
    return { status: 403, error: "cross-origin write refused" };
  }
  const site = headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "cross-site write refused" };
  }
  return null;
}
