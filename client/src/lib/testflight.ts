/**
 * Public TestFlight join URL for the iOS beta.
 *
 * A TestFlight join link is meant to be public, so the current one lives in the
 * code as the default rather than behind a build secret: the CTA should work on
 * every copy of the site (pqp.gg, the pages.dev twin, a preview) without anyone
 * remembering to set an env var. `VITE_TESTFLIGHT_URL` still overrides it at
 * build time, which is how you rotate to a fresh link or blank it (set it to a
 * single space) without a code change.
 *
 * Runbook: `docs/TESTFLIGHT.md`.
 */
const PUBLIC_TESTFLIGHT_URL = "https://testflight.apple.com/join/envnP5vV";

export function testflightUrl(): string | null {
  const raw = import.meta.env.VITE_TESTFLIGHT_URL;
  const override = typeof raw === "string" ? raw.trim() : "";
  return override || PUBLIC_TESTFLIGHT_URL;
}
