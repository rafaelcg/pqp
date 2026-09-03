/**
 * The donation links behind `/apoie` (and `/support`).
 *
 * HOSTED-ONLY, same rule as Umami, Google Ads and the APK click beacon: the
 * default is off. A self-hosted build must not ship our GitHub Sponsors page or
 * our Pix key on its own domain, so unless the Pages workflow sets at least one
 * of these at build time, the footer link is absent and both routes redirect
 * to `/`. Nothing here is a secret; a Pix random key and a Sponsors URL are
 * public by design. What is hosted-only is whose they are.
 *
 * Donations only. There are no perks, tiers or refunds and the product does not
 * change for anyone who gives, which is why this file has no notion of "who
 * donated": there is nothing to unlock with the answer.
 */

export interface SupportLinks {
  /** GitHub Sponsors profile, `VITE_SPONSOR_URL`. */
  sponsorUrl: string | null;
  /** Pix random key, `VITE_PIX_KEY`. */
  pixKey: string | null;
  /**
   * The "Pix copia e cola" payload, `VITE_PIX_BRCODE`. Only ever present
   * alongside a key: the page shows the code under the key, and a code with
   * no key would be a Pix block the copy cannot describe.
   */
  pixBrCode: string | null;
}

export interface SupportLinksEnv {
  readonly VITE_SPONSOR_URL?: unknown;
  readonly VITE_PIX_KEY?: unknown;
  readonly VITE_PIX_BRCODE?: unknown;
}

function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * The links, or null when the whole feature is off. Off is the answer whenever
 * neither the Sponsors URL nor the Pix key survives trimming; a BR code on its
 * own does not turn the page on.
 */
export function supportLinksFrom(env: SupportLinksEnv): SupportLinks | null {
  const sponsorUrl = clean(env.VITE_SPONSOR_URL);
  const pixKey = clean(env.VITE_PIX_KEY);
  if (!sponsorUrl && !pixKey) return null;
  return {
    sponsorUrl,
    pixKey,
    pixBrCode: pixKey ? clean(env.VITE_PIX_BRCODE) : null,
  };
}

export function supportLinks(): SupportLinks | null {
  // Named reads rather than the whole `import.meta.env`: Vite's type for it
  // is an index signature, which shares no property with the all-optional
  // `SupportLinksEnv` and trips TypeScript's weak-type check.
  return supportLinksFrom({
    VITE_SPONSOR_URL: import.meta.env.VITE_SPONSOR_URL,
    VITE_PIX_KEY: import.meta.env.VITE_PIX_KEY,
    VITE_PIX_BRCODE: import.meta.env.VITE_PIX_BRCODE,
  });
}

export function isSupportPageEnabled(): boolean {
  return supportLinks() !== null;
}

/**
 * Which of the two paths to send a reader to. One page, two names: `/apoie` is
 * the one shared in Brazil, `/support` is the one an English speaker guesses.
 */
export function supportPagePath(locale: string): "/apoie" | "/support" {
  return locale.toLowerCase().startsWith("pt") ? "/apoie" : "/support";
}
