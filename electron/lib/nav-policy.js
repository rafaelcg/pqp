/**
 * Which origins the shell window is allowed to sit on.
 *
 * The window is pinned to the app origin so a link (or a compromised page)
 * cannot quietly replace the app with someone else's content while keeping the
 * native chrome that makes it look like pqp. Everything else opens in the
 * system browser.
 *
 * Sign-in is the exception that has to be carved out. Clerk hosts the
 * account portal and the frontend API on its own subdomains, and a social
 * provider redirects the top-level window to the identity provider and back.
 * Those hops are transient and end on the app origin again, so they are
 * allowed to happen in-window; blocking them would bounce the user into the
 * system browser mid-sign-in and the session would land in the wrong place.
 */

/**
 * Host suffixes that are part of an auth flow.
 *
 * Clerk's own hosts are derived from the app host at runtime
 * (`clerk.<host>` / `accounts.<host>` for a production instance) plus the
 * development instance domains below.
 *
 * The identity providers are listed by hand. If a provider is enabled in the
 * Clerk dashboard and is not in this list, desktop sign-in with it will bounce
 * to the system browser instead of completing in-app — add the host here.
 */
const AUTH_HOST_SUFFIXES = [
  // Clerk
  ".accounts.dev",
  ".clerk.accounts.dev",
  ".clerk.com",
  // Identity providers Clerk can redirect to
  "accounts.google.com",
  "github.com",
  "appleid.apple.com",
  "discord.com",
  "login.microsoftonline.com",
  "login.live.com",
  // Game account linking (Settings → Connections). Same reason as Clerk
  // social: the hop has to finish in-window or the session lands in the
  // system browser and the callback never returns to the shell.
  // Steam profile pages and the rest of Battle.net are not on this list;
  // isAuthUrl allows only the OpenID / login paths for those hosts.
  "login.steampowered.com",
  "oauth.battle.net",
  "account.battle.net",
  "id.twitch.tv",
  "passport.twitch.tv",
];

function hostMatches(host, suffix) {
  // A leading dot means "any subdomain of this", and nothing else.
  if (suffix.startsWith(".")) {
    return host.endsWith(suffix);
  }
  // Otherwise the host itself, or a subdomain of it.
  //
  // NEVER a bare `host.endsWith(suffix)` here. That matches `evilgithub.com`
  // against `github.com` and `evilaccounts.google.com` against
  // `accounts.google.com` — handing a domain anyone can register the right to
  // render inside the app's own window, wearing the native chrome that makes
  // it look like pqp. That is the exact attack the pinning at the top of this
  // file exists to prevent, so the allowlist must not reintroduce it.
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Path used for Steam / Battle.net prefix checks.
 *
 * `new URL` already collapses literal `.` / `..` segments. Percent-encoded
 * ones (`%2e%2e%2f`) survive in `pathname` and would still start with
 * `/openid/` after a naive `decodeURIComponent`, while Chromium then
 * navigates to a profile page. Decode, split, collapse `.` / `..`, then
 * match. Malformed percent-encoding is not an auth hop.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
function resolvedPathname(pathname) {
  let current = pathname;
  for (let i = 0; i < 8; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    const out = [];
    for (const raw of decoded.split("/")) {
      const segment = raw.toLowerCase();
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        out.pop();
        continue;
      }
      out.push(segment);
    }
    const next = `/${out.join("/")}`;
    if (next === current.toLowerCase()) {
      return next;
    }
    current = next;
  }
  return current.toLowerCase();
}

function isSteamOpenIdPath(pathname) {
  return (
    pathname === "/openid" ||
    pathname === "/openid/" ||
    pathname === "/openid/login" ||
    pathname === "/openid/login/"
  );
}

function isBattleNetLoginPath(pathname) {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/oauth/")
  );
}

/**
 * @param {string} url
 * @param {string | null} appOrigin
 * @returns {boolean}
 */
function isAuthUrl(url, appOrigin) {
  let host;
  let protocol;
  let pathname;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (protocol !== "https:") {
    return false;
  }

  if (appOrigin) {
    try {
      const appHost = new URL(appOrigin).hostname.toLowerCase();
      // Clerk production instances live on subdomains of the app's own domain.
      if (host === `clerk.${appHost}` || host === `accounts.${appHost}`) {
        return true;
      }
    } catch {
      // fall through to the static list
    }
  }

  if (AUTH_HOST_SUFFIXES.some((suffix) => hostMatches(host, suffix))) {
    return true;
  }

  // Steam OpenID only. A profile page must not render in-window.
  if (host === "steamcommunity.com" || host.endsWith(".steamcommunity.com")) {
    const path = resolvedPathname(pathname);
    return path !== null && isSteamOpenIdPath(path);
  }

  // Regional Battle.net login. oauth and account hosts are already on
  // AUTH_HOST_SUFFIXES and do not need a path gate.
  if (host === "battle.net" || host.endsWith(".battle.net")) {
    const path = resolvedPathname(pathname);
    return path !== null && isBattleNetLoginPath(path);
  }

  return false;
}

/**
 * Decide what to do with a navigation the renderer asked for.
 *
 * @param {string} url
 * @param {string | null} appOrigin
 * @returns {"allow" | "external" | "block"}
 */
function classifyNavigation(url, appOrigin) {
  if (!appOrigin) {
    // No origin to pin to (misconfigured); do not start policing navigation,
    // the window would have nowhere to go.
    return "allow";
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "block";
  }
  if (parsed.origin === appOrigin) {
    return "allow";
  }
  if (isAuthUrl(url, appOrigin)) {
    return "allow";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? "external"
    : "block";
}

module.exports = {
  AUTH_HOST_SUFFIXES,
  classifyNavigation,
  isAuthUrl,
};
