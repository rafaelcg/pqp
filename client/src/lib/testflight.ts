/**
 * Public TestFlight join URL for the iOS beta.
 *
 * Baked at build time (`VITE_TESTFLIGHT_URL`). Empty means the beta CTA stays
 * hidden — we would rather not show a dead button than invent a link. Set the
 * secret on Cloudflare Pages / GitHub Actions when App Store Connect gives you
 * a public link (`https://testflight.apple.com/join/…`).
 *
 * Runbook: `docs/TESTFLIGHT.md`.
 */
export function testflightUrl(): string | null {
  const raw = import.meta.env.VITE_TESTFLIGHT_URL;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
