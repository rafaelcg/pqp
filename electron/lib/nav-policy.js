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
 * @param {string} url
 * @param {string | null} appOrigin
 * @returns {boolean}
 */
function isAuthUrl(url, appOrigin) {
  let host;
  let protocol;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
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

  return AUTH_HOST_SUFFIXES.some((suffix) => hostMatches(host, suffix));
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
