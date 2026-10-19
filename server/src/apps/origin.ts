/**
 * The apps origin: the separate, cookieless site that serves app bundles
 * (`APPS_ORIGIN`, for example `https://pqp-apps.pages.dev`, or
 * `http://localhost:5175` in development). Read per call, so a test or an
 * operator can change it without a module reload.
 *
 * UNSET MEANS APPS CANNOT RUN. The config route answers `origin: null`, every
 * app is `no-origin`, and the launcher says so. There is deliberately no
 * default: a deployment that never configured one must not guess a host that
 * would receive its people's page loads.
 *
 * Only an `http:` or `https:` origin with no path, query or credentials counts.
 * Anything else is treated as unset, and the trailing slash is dropped.
 */
export function appsOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APPS_ORIGIN?.trim();
  if (!raw) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return null;
  }
  return url.origin;
}

/** `<origin>/<id>/<version>/<path>`: the immutable address of one bundle file. */
export function appBundleUrl(
  origin: string | null,
  appId: string,
  version: string,
  path: string,
): string | null {
  if (!origin) {
    return null;
  }
  return `${origin}/${appId}/${version}/${path}`;
}
