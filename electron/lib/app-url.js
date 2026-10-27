/**
 * Which site the shell loads, and who gets to say.
 *
 * `PQP_APP_URL` / `VITE_APP_URL` exist so a developer can point the shell at a
 * Vite server or a staging deploy. They used to be honoured by a packaged build
 * too, so ANY launcher (a shortcut, a script, a login item some other program
 * wrote) could start the installed, signed app with the preload bridge and the
 * app's microphone, camera and input-monitoring grants showing somebody else's
 * site. A packaged build now ignores them, and loads production.
 *
 * Testing an installed build against staging is a real workflow
 * (`docs/DESKTOP.md`), so it is kept behind one explicit switch rather than
 * removed: `PQP_ALLOW_APP_URL_OVERRIDE=1`. That is a documented, greppable
 * opt-in, not a security boundary against somebody who can already set
 * environment variables for the process (nothing is). What it stops is the
 * accident and the launcher that does not know about it.
 *
 * `PQP_LOAD_STATIC=1` is a separate, older opt-in that serves the bundled
 * client over loopback; it never loads a third party's site and is unchanged.
 */

const ALLOW_OVERRIDE_ENV = "PQP_ALLOW_APP_URL_OVERRIDE";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function overrideSwitchOn(env) {
  const value = env[ALLOW_OVERRIDE_ENV];
  return value === "1" || value === "true";
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   isPackaged: boolean,
 *   prodUrl: string,
 *   devUrl: string,
 * }} input
 * @returns {{ url: string, source: "override" | "default", ignored: boolean }}
 *   `ignored`: an override was present and a packaged build refused it.
 */
function resolveAppUrlSource({ env, isPackaged, prodUrl, devUrl }) {
  const requested = env.PQP_APP_URL || env.VITE_APP_URL || "";
  const fallback = isPackaged ? prodUrl : devUrl;
  if (!requested) {
    return { url: fallback, source: "default", ignored: false };
  }
  if (isPackaged && !overrideSwitchOn(env)) {
    return { url: fallback, source: "default", ignored: true };
  }
  return { url: requested, source: "override", ignored: false };
}

module.exports = { ALLOW_OVERRIDE_ENV, resolveAppUrlSource };
