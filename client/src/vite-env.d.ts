/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { PqpDesktop } from "./lib/desktop";
import type { Gtag } from "./lib/google-ads";
import type { VoiceStatsConsole } from "./lib/voice-stats-probe";

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_VOICE_BACKEND?: "mesh" | "cloudflare-sfu" | "livekit";
  readonly VITE_DEV_AUTH_BYPASS?: string;
  /**
   * Public TestFlight join URL. Optional; a default lives in `lib/testflight.ts`.
   */
  readonly VITE_TESTFLIGHT_URL?: string;
  /**
   * Public Android beta APK URL. Optional; a GitHub Release default lives in
   * `lib/android-apk.ts`. A single space hides the download button.
   */
  readonly VITE_ANDROID_APK_URL?: string;
  /**
   * Public POST URL that counts a tap on the Android APK button. Hosted-only:
   * unset means the client never beacons, which is what every self-hosted
   * build wants. See `lib/android-apk-click.ts`.
   */
  readonly VITE_ANDROID_APK_CLICK_URL?: string;
  /**
   * The Google Ads advertiser id (`AW-…`) and the label of the sign-up
   * conversion action. Optional, and absent on every self-hosted build: without
   * them no Google tag is injected and nothing is ever reported. See
   * `lib/google-ads-tag.ts` and `lib/google-ads.ts`.
   */
  readonly VITE_GOOGLE_ADS_ID?: string;
  readonly VITE_GOOGLE_ADS_SIGNUP_LABEL?: string;
  /**
   * The donation page (`/apoie`, `/support`). Hosted-only: a GitHub Sponsors
   * URL, a Pix random key and, optionally, the "Pix copia e cola" payload.
   * The page and its footer link exist only when the URL or the key is set,
   * so a self-hosted build never carries our links. See `lib/support-links.ts`.
   */
  readonly VITE_SPONSOR_URL?: string;
  readonly VITE_PIX_KEY?: string;
  readonly VITE_PIX_BRCODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    pqpDesktop?: PqpDesktop;
    /**
     * Attached only once a mesh call has opened its first connection — see
     * `lib/voice-stats-probe.ts`. Nothing in the app reads it; it exists so a
     * live call can be measured from the console instead of described.
     */
    pqpVoiceStats?: VoiceStatsConsole;
    /**
     * Defined only by the Google tag, which is only injected on the pqp.gg
     * build. Optional here because on a self-hosted build it genuinely is not
     * there, and `lib/google-ads.ts` has to be able to see that.
     */
    gtag?: Gtag;
  }
}

export {};
