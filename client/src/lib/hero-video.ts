/**
 * Whether this device should be handed the landing hero's background video.
 *
 * Yes needs a wide window (a desktop or a laptop, not a phone in landscape), a
 * fine pointer that can hover (a mouse or a trackpad), and a connection that has
 * not said it is expensive or slow. The first two every browser answers, and
 * when it cannot answer the result is no. The network hints (`saveData`,
 * `effectiveType`) exist in Chromium and nowhere else, so their absence is read
 * as "no objection".
 *
 * Reduced motion is not decided here. It is a separate setting with its own
 * hook (`use-reduced-motion.ts`) and the caller already honours it.
 */

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

export const HERO_VIDEO_MEDIA =
  "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

const SLOW_TYPES = new Set(["slow-2g", "2g", "3g"]);

export function heroVideoAllowed(win: Window = window): boolean {
  try {
    if (!win.matchMedia(HERO_VIDEO_MEDIA).matches) {
      return false;
    }
    const connection = (
      win.navigator as Navigator & { connection?: NetworkInformationLike }
    ).connection;
    if (connection?.saveData) {
      return false;
    }
    if (connection?.effectiveType && SLOW_TYPES.has(connection.effectiveType)) {
      return false;
    }
    return true;
  } catch {
    // No matchMedia (a very old WebView): no video.
    return false;
  }
}
