import { isDesktopApp } from "./desktop";
import { isAndroidDevice, isIOSDevice } from "./downloads";
import { playStoreUrl } from "./play-store";
import { testflightUrl } from "./testflight";

/**
 * Where to send somebody whose browser cannot share a screen.
 *
 * The user agent decides ONLY which store to link. Whether the share button
 * works is capability detection (`supportsScreenShare`: does
 * `navigator.mediaDevices.getDisplayMedia` exist), so a phone browser that
 * ships the API gets the real button and never reaches this. As far as is
 * known, Chrome for Android and every iOS browser (WebKit underneath) do not
 * expose it, which is the audience for this note: the native apps can share a
 * screen, the browser on the same phone cannot.
 */
export interface ShareAppTarget {
  platform: "android" | "ios";
  url: string;
}

export interface ShareAppEnvironment {
  /** `supportsScreenShare()`. A browser that can capture needs no app. */
  canShareInBrowser: boolean;
  desktopApp?: boolean;
  android?: boolean;
  ios?: boolean;
  playUrl?: string | null;
  testflight?: string | null;
}

export function shareAppTarget(env: ShareAppEnvironment): ShareAppTarget | null {
  if (env.canShareInBrowser) return null;
  if (env.desktopApp ?? isDesktopApp()) return null;
  if (env.android ?? isAndroidDevice()) {
    const url = env.playUrl === undefined ? playStoreUrl() : env.playUrl;
    return url ? { platform: "android", url } : null;
  }
  if (env.ios ?? isIOSDevice()) {
    const url = env.testflight === undefined ? testflightUrl() : env.testflight;
    return url ? { platform: "ios", url } : null;
  }
  return null;
}
