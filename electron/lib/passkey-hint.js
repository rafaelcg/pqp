/**
 * The desktop passkey dead end, and the only thing we can do about it.
 *
 * Google offers a passkey when the account has one, and the ceremony runs
 * through `navigator.credentials`. Electron ships no platform authenticator,
 * so on macOS that call never resolves: no Touch ID sheet appears, no error is
 * raised, and Google's page sits on "Verifying it's you..." forever. Nothing
 * in this app is broken and nothing in this app can fix it.
 *
 * What we cannot do:
 *  - Provide the authenticator ourselves. The native polyfills only serve
 *    first-party pages, where `rpId` matches the app's own associated-domains
 *    entitlement. This ceremony has `rpId = google.com`, and only Google and
 *    Apple can satisfy that.
 *  - Inject a script into Google's page to work around it. That is precisely
 *    the embedded-webview behaviour Google's policy forbids, and getting the
 *    OAuth client suspended would break sign-in on the web too, where it works
 *    perfectly.
 *
 * What we can do: Google's own page carries a **"Try another way"** link that
 * leads to password and other methods, all of which work in Electron. The
 * dead end is not that a passkey was offered, it is that nobody tells the user
 * the escape hatch is right there. So the shell says so, from outside the
 * page, by retitling the window and (after a wait) showing a hint.
 *
 * The real fix is to run the whole flow in the system browser and hand a
 * one-time ticket back over a 127.0.0.1 loopback listener. Current shells
 * do that (`startDesktopAuth`). This hint stays for older binaries that
 * still open Google inside a BrowserWindow.
 */

/**
 * How long a Google sign-in page may sit there before we volunteer the hint.
 *
 * Long enough that somebody typing a password, picking an account or reading a
 * consent screen is never interrupted; short enough that a person staring at a
 * spinner that will never finish gets told inside half a minute. It is a
 * one-shot per window: a hint that reappears is an argument.
 */
const PASSKEY_HINT_DELAY_MS = 22_000;

/** Hosts whose sign-in pages can start a WebAuthn ceremony we cannot finish. */
const PASSKEY_HOSTS = ["accounts.google.com", "accounts.youtube.com"];

/**
 * Whether a URL is a Google sign-in page that might ask for a passkey.
 *
 * Deliberately host-level rather than path-level. Google moves these paths
 * around (`/signin/v2/challenge`, `/v3/signin/challenge/pk`, and more), and a
 * path list that goes stale fails closed: the user gets the silent hang back
 * with no hint. The cost of being too broad is a hint on a page that did not
 * need one, after 22 seconds, which is cheap.
 *
 * Exact host match, never `endsWith`. `evilaccounts.google.com` is a domain
 * anybody can register, and while a wrong answer here only mistitles a window
 * rather than granting it trust, the same sloppiness in nav-policy.js would be
 * a phishing hole. Keep the habit.
 *
 * @param {string} url
 * @returns {boolean}
 */
function mayPromptForPasskey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return PASSKEY_HOSTS.includes(parsed.hostname.toLowerCase());
}

module.exports = {
  PASSKEY_HINT_DELAY_MS,
  PASSKEY_HOSTS,
  mayPromptForPasskey,
};
