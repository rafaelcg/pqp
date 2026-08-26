/**
 * The Google Ads tag, injected into `index.html` only when this build was told
 * which advertiser account it belongs to.
 *
 * WHY THIS IS NOT JUST A `<script>` IN index.html. Same argument as the Umami
 * plugin next to it in `vite.config.ts`, only sharper. pqp is AGPL and meant to
 * be self-hosted, and `index.html` ships to every self-hoster. A hardcoded
 * Google tag would put *their* visitors into *our* advertising account, set
 * Google cookies on *their* domain, and make their cookie notice wrong without
 * them ever touching a config file. So the tag exists only when
 * `VITE_GOOGLE_ADS_ID` is set, which is only on the pqp.gg build.
 *
 * Neither value is a secret. A conversion id and label are readable in the page
 * source of every site that runs Google Ads conversion tracking, which is why
 * they travel as plain build vars rather than as secrets pretending otherwise.
 *
 * WHY THIS LIVES UNDER `src/` DESPITE BEING BUILD-TIME CODE. So it can be
 * tested. `vitest.config.ts` only collects `src/**` and the gating above is the
 * one property that must never regress silently. See `google-ads-tag.test.ts`.
 * Nothing in the app imports it, so nothing here reaches the bundle; the same
 * arrangement `pages/legal/source-rev.ts` uses for the same reason.
 */

import type { HtmlTagDescriptor, Plugin } from "vite";

export interface GoogleAdsEnv {
  VITE_GOOGLE_ADS_ID?: string;
  /**
   * The per-conversion-action label Google issues alongside the id. Only the
   * app bundle needs it, so it is not read here; it is listed so the one type
   * describes both halves of the feature.
   */
  VITE_GOOGLE_ADS_SIGNUP_LABEL?: string;
}

/**
 * The head tags for a given environment. Empty for every environment that does
 * not name an advertiser account, which is every self-hosted build.
 *
 * The `config` call is what sets the first-party `_gcl_*` cookie that links a
 * later conversion back to the ad click, so it has to run on the landing page
 * rather than at the moment the conversion fires. The SPA is one document, so
 * one `config` at load covers the whole journey.
 */
export function googleAdsTags(env: GoogleAdsEnv): HtmlTagDescriptor[] {
  const id = env.VITE_GOOGLE_ADS_ID?.trim();
  if (!id) {
    return [];
  }
  const encoded = encodeURIComponent(id);
  return [
    {
      tag: "script",
      injectTo: "head",
      attrs: {
        async: true,
        src: `https://www.googletagmanager.com/gtag/js?id=${encoded}`,
      },
    },
    {
      tag: "script",
      injectTo: "head",
      // A function expression and not an arrow, because gtag forwards the real
      // `arguments` object into `dataLayer` and an arrow has none.
      children: [
        "window.dataLayer = window.dataLayer || [];",
        "window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };",
        'window.gtag("js", new Date());',
        `window.gtag("config", ${JSON.stringify(id)});`,
      ].join("\n"),
    },
  ];
}

/** The plugin form, for `vite.config.ts`. */
export function googleAds(env: GoogleAdsEnv): Plugin {
  return {
    name: "pqp-google-ads",
    apply: "build",
    transformIndexHtml() {
      return googleAdsTags(env);
    },
  };
}
