/**
 * The script the service worker imports beside its precache (`sw-build-*.js`,
 * emitted by `client/vite.config.ts`). Three jobs, all about which build a
 * person ends up on:
 *
 *  1. STAMP. It says which build this worker was made from and answers a
 *     `PQP_BUILD` message with it, so a page can tell a worker that is current
 *     from one that only looks idle (`lib/apply-update.ts`).
 *
 *  2. NAVIGATE NETWORK-FIRST. A navigation is answered by the network, and the
 *     precached shell is only the fallback (offline, or no answer in four
 *     seconds). Without this the worker answers every navigation from its
 *     precache, which is the OLD build's until a newer worker has installed and
 *     taken over, and there is always a window before that. Found on
 *     2026-09-30 with a person who hard-reloaded onto the new site and then
 *     changed the language: the language change is a full navigation, the
 *     worker still had the old precache, and the old site came back. A hard
 *     reload bypasses the worker for ONE load; the next navigation is the
 *     worker's again. `index.html` is tiny and the hashed assets it names are
 *     still precached, so what this costs is one small request per navigation.
 *
 *  3. SAY WHY AN INSTALL FAILED. One precache entry that is not 200 fails the
 *     whole install (Workbox's `bad-precaching-response`), and the page only
 *     ever sees the worker turn `redundant`. From 2026-09-30 to 2026-10-10
 *     every install failed that way and nothing said which file. The install
 *     listener here runs before Workbox's, wraps `event.waitUntil` for that
 *     one event, and when a promise passed to it rejects, posts the failing
 *     path, status and error name to every open page of the origin
 *     (`PQP_SW_INSTALL_FAILED`, read by `lib/register-sw.ts`, which makes N
 *     open tabs one report), then rethrows so
 *     the install fails exactly as before. The post is bounded by a timer, so
 *     reporting can never hold an install open. Only our own asset path is
 *     sent: no query string, no user data.
 *
 *  4. LOOK FOR THE NEXT BUILD FROM INSIDE. On a fetch from any page it
 *     controls, at most once per `WORKER_UPDATE_EVERY_MS`, the worker calls
 *     `self.registration.update()`. A page that never navigates (a pinned tab,
 *     the desktop app) otherwise only gets a new worker when its own code asks
 *     (`lib/version-watch.ts`), and a bundle from BEFORE that code (the
 *     2026-09-23 to 09-29 bundles stranded by the failed installs) never asks:
 *     the browser alone checks after 24 hours at best. Once THIS worker controls
 *     such a page, every request it makes is a chance to find the next deploy,
 *     and that page's own `virtual:pwa-register` reloads it when a worker it did
 *     not register takes control (vite-plugin-pwa's prompt mode, `controlling`
 *     with `isUpdate`). The time of the last check is kept in Cache Storage
 *     (`pqp-sw-meta`) because the worker itself is stopped after half a minute
 *     idle, and an in-memory clock would check on every restart.
 *
 * The navigation handler is a fetch listener in an imported script, so it is registered before
 * Workbox's own router and answers first. Paths on the denylist are left alone
 * (no `respondWith`), exactly as Workbox's navigation route leaves them.
 *
 * Plain ES5 text, generated here so a unit test can run it in a sandbox.
 */

export const NAVIGATION_TIMEOUT_MS = 4000;

/** Least time between two update checks the worker starts itself. */
export const WORKER_UPDATE_EVERY_MS = 10 * 60_000;

/** The cache that remembers when the worker last looked for a new `sw.js`. */
export const WORKER_META_CACHE = "pqp-sw-meta";

/** Longest the failing install waits for its report to reach the pages. */
export const INSTALL_REPORT_TIMEOUT_MS = 1000;

/** The message a failing install posts to the pages (`lib/register-sw.ts`). */
export const INSTALL_FAILED_MESSAGE = "PQP_SW_INSTALL_FAILED";

/** Paths that are files or endpoints, not app routes: the worker never answers them with the shell. */
export const NAVIGATE_DENYLIST: RegExp[] = [
  /^\/api\//,
  /^\/status\.json$/,
  /^\/ws/,
  /^\/r\//,
  /^\/\.well-known\//,
  /^\/llms(-full)?\.txt$/,
  /^\/index\.md$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  // Standalone diagnostic pages in client/public (share-*.html).
  /^\/share-diagnostic/,
  /^\/share-audio-tone/,
];

export interface SwBuildScriptOptions {
  denylist?: RegExp[];
  timeoutMs?: number;
  /** Least time between two worker-started update checks. */
  updateEveryMs?: number;
  /**
   * Include the network-first navigation handler (default). Off only for the
   * e2e fixture that stands in for a worker from BEFORE it existed
   * (`PQP_TEST_LEGACY_WORKER`, `e2e/stale-bundle/builds.ts`).
   */
  navigation?: boolean;
}

export function swBuildScript(
  buildId: string,
  options: SwBuildScriptOptions = {},
): string {
  const denylist = options.denylist ?? NAVIGATE_DENYLIST;
  const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const updateEveryMs = options.updateEveryMs ?? WORKER_UPDATE_EVERY_MS;
  const deny = denylist.map((re) => `new RegExp(${JSON.stringify(re.source)})`);
  const stamp = [
    `self.__PQP_BUILD__ = ${JSON.stringify(buildId)};`,
    `self.addEventListener("message", function (event) {`,
    `  if (event.data && event.data.type === "PQP_BUILD" && event.ports && event.ports[0]) {`,
    `    event.ports[0].postMessage({ build: self.__PQP_BUILD__ });`,
    `  }`,
    `});`,
  ];
  if (options.navigation === false) {
    return [...stamp, ``].join("\n");
  }
  const installReport = [
    `(function () {`,
    `  function describe(error) {`,
    `    var details = (error && error.details) || {};`,
    `    var path = "";`,
    `    if (typeof details.url === "string") {`,
    `      try { path = new URL(details.url, self.location.href).pathname; } catch (e) { path = ""; }`,
    `    }`,
    `    return {`,
    `      type: ${JSON.stringify(INSTALL_FAILED_MESSAGE)},`,
    `      build: self.__PQP_BUILD__,`,
    `      reason: String((error && error.name) || "error").slice(0, 80),`,
    `      path: path.slice(0, 200),`,
    `      status: typeof details.status === "number" ? details.status : 0`,
    `    };`,
    `  }`,
    `  function tell(message) {`,
    `    var posted = self.clients.matchAll({ type: "window", includeUncontrolled: true })`,
    `      .then(function (clients) {`,
    `        for (var i = 0; i < clients.length; i++) { clients[i].postMessage(message); }`,
    `      })`,
    `      .catch(function () {});`,
    `    var timeout = new Promise(function (resolve) { setTimeout(resolve, ${INSTALL_REPORT_TIMEOUT_MS}); });`,
    `    return Promise.race([posted, timeout]);`,
    `  }`,
    `  self.addEventListener("install", function (event) {`,
    `    var reported = false;`,
    `    var waitUntil = event.waitUntil;`,
    `    event.waitUntil = function (promise) {`,
    `      return waitUntil.call(event, Promise.resolve(promise).catch(function (error) {`,
    `        if (reported) { throw error; }`,
    `        reported = true;`,
    `        return tell(describe(error)).then(function () { throw error; });`,
    `      }));`,
    `    };`,
    `  });`,
    `})();`,
  ];
  return [
    ...stamp,
    ...installReport,
    `(function () {`,
    `  var DENY = [${deny.join(", ")}];`,
    `  var TIMEOUT_MS = ${Number(timeoutMs)};`,
    `  function denied(pathname) {`,
    `    for (var i = 0; i < DENY.length; i++) { if (DENY[i].test(pathname)) { return true; } }`,
    `    return false;`,
    `  }`,
    `  function shell() {`,
    `    return caches.match("/index.html", { ignoreSearch: true });`,
    `  }`,
    `  function answer(request) {`,
    `    var timer;`,
    `    var timeout = new Promise(function (resolve) {`,
    `      timer = setTimeout(function () { resolve(null); }, TIMEOUT_MS);`,
    `    });`,
    `    var network = fetch(request).catch(function () { return null; });`,
    `    return Promise.race([network, timeout]).then(function (response) {`,
    `      clearTimeout(timer);`,
    `      // A real answer from the server, a redirect included (a navigation`,
    `      // fetch reports one as an opaque redirect).`,
    `      if (response && (response.ok || response.type === "opaqueredirect")) { return response; }`,
    `      return shell().then(function (cached) {`,
    `        if (cached) { return cached; }`,
    `        // No shell to fall back to: whatever the network says, late or not.`,
    `        return response || network.then(function (late) { return late || Response.error(); });`,
    `      });`,
    `    });`,
    `  }`,
    `  self.addEventListener("fetch", function (event) {`,
    `    var request = event.request;`,
    `    if (request.mode !== "navigate" || request.method !== "GET") { return; }`,
    `    var url = new URL(request.url);`,
    `    if (url.origin !== self.location.origin || denied(url.pathname)) { return; }`,
    `    event.respondWith(answer(request));`,
    `  });`,
    `})();`,
    `(function () {`,
    `  var EVERY_MS = ${Number(updateEveryMs)};`,
    `  var KEY = "/__pqp_last_update_check";`,
    `  var last = null;`,
    `  var busy = false;`,
    `  function lastCheck() {`,
    `    if (last !== null) { return last; }`,
    `    return caches.open(${JSON.stringify(WORKER_META_CACHE)})`,
    `      .then(function (cache) { return cache.match(KEY); })`,
    `      .then(function (hit) { return hit ? hit.text() : "0"; })`,
    `      .then(function (text) { last = Number(text) || 0; return last; })`,
    `      .catch(function () { last = 0; return 0; });`,
    `  }`,
    `  function remember(at) {`,
    `    last = at;`,
    `    return Promise.resolve()`,
    `      .then(function () { return caches.open(${JSON.stringify(WORKER_META_CACHE)}); })`,
    `      .then(function (cache) { return cache.put(KEY, new Response(String(at))); })`,
    `      .catch(function () {});`,
    `  }`,
    `  self.addEventListener("fetch", function (event) {`,
    `    if (busy || (last !== null && Date.now() - last < EVERY_MS)) { return; }`,
    `    busy = true;`,
    `    // Inside a promise from the first step: nothing here may throw into the fetch.`,
    `    var check = Promise.resolve().then(lastCheck).then(function (at) {`,
    `      var now = Date.now();`,
    `      if (now - at < EVERY_MS) { return; }`,
    `      return remember(now).then(function () {`,
    `        if (self.registration && self.registration.update) {`,
    `          return self.registration.update();`,
    `        }`,
    `      });`,
    `    }).catch(function () {}).then(function () { busy = false; });`,
    `    // Keep the worker alive until the check is done: it may be stopped as soon`,
    `    // as the fetch itself is answered.`,
    `    try { if (event && event.waitUntil) { event.waitUntil(check); } } catch (e) {}`,
    `  });`,
    `})();`,
    ``,
  ].join("\n");
}
