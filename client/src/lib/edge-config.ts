import { playStoreUrlFrom } from "./play-store";
import { supportLinksFrom, type SupportLinksEnv } from "./support-links";
import { testflightUrlFrom } from "./testflight";

/**
 * `/edge-config.json`: what the build knows that the Pages middleware needs.
 * Written by the `pqp-edge-config` plugin in `vite.config.ts`, read by
 * `client/functions/_middleware.ts`.
 */
export interface EdgeConfig {
  /** `VITE_API_URL`, or empty. */
  apiUrl: string;
  /** The footer links `/apoie` (`isSupportPageEnabled()`). */
  supportPage: boolean;
  /** The footer says "Google Play" (`playStoreUrl() !== null`). */
  playStore: boolean;
  /** The iOS beta link `/vs-discord` shows (`testflightUrl()`). */
  iosBetaUrl: string;
}

export type EdgeConfigEnv = SupportLinksEnv & {
  readonly VITE_API_URL?: string;
  readonly VITE_PLAY_STORE_URL?: string;
  readonly VITE_TESTFLIGHT_URL?: string;
};

export function edgeConfigFrom(env: EdgeConfigEnv): EdgeConfig {
  return {
    apiUrl: env.VITE_API_URL ?? "",
    supportPage: supportLinksFrom(env) !== null,
    playStore: playStoreUrlFrom(env.VITE_PLAY_STORE_URL) !== null,
    iosBetaUrl: testflightUrlFrom(env.VITE_TESTFLIGHT_URL),
  };
}
