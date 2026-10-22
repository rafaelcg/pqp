import type { FeedbackContext, VoiceRoomTransport } from "@pqp/shared";
import { isDesktopApp } from "@/lib/desktop";
import { currentLinkSummary } from "@/lib/call-link-window";
import { faroSessionId } from "@/lib/faro";

/** The call half, which only `App` knows. Passed down to the settings box. */
export interface FeedbackVoiceContext {
  inCall: boolean;
  transport: VoiceRoomTransport | null;
  watchParty: boolean;
}

/**
 * Where the person is right now, attached to a feedback item so a bug report
 * says which platform, build, screen and call it came from. The settings box
 * tells them this travels with it. No account data here: the server already
 * knows who sent it, and reads the user agent from its own request header.
 */
export function buildFeedbackContext(
  voice: FeedbackVoiceContext | null,
  env: { appVersion?: string; locale?: string } = {},
): FeedbackContext {
  const context: FeedbackContext = {
    platform: isDesktopApp() ? "desktop" : "web",
    appVersion:
      (env.appVersion ?? import.meta.env.VITE_FARO_APP_VERSION)?.trim().slice(0, 64) ||
      "dev",
  };
  if (typeof window !== "undefined") {
    context.path = window.location.pathname.slice(0, 200);
    context.viewport = `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`;
  }
  // The app's own language (`lib/locale.ts` writes it to <html lang>), falling
  // back to the browser's.
  const fromApp =
    env.locale ?? (typeof document !== "undefined" ? document.documentElement.lang : "");
  const fromBrowser = typeof navigator !== "undefined" ? navigator.language : "";
  const locale = (fromApp || fromBrowser || "").trim().slice(0, 16);
  if (locale) {
    context.locale = locale;
  }
  if (voice) {
    context.voice = {
      inCall: voice.inCall,
      transport: voice.inCall ? voice.transport : null,
      watchParty: voice.inCall && voice.watchParty,
    };
    if (voice.inCall) {
      // The path and the last ~30 s of the link, from the sampler the call
      // already runs. Only while in a call: it describes THIS call, and after
      // hanging up the window has aged out anyway.
      const link = currentLinkSummary();
      if (Object.keys(link).length > 0) {
        context.voice.link = link;
      }
    }
  }
  const session = faroSessionId();
  if (session && /^[A-Za-z0-9_-]{1,128}$/.test(session)) {
    context.faroSessionId = session;
  }
  return context;
}
