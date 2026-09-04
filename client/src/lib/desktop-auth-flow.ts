import { isDesktopApp } from "@/lib/desktop";

/**
 * Where Clerk must land after Sair in this shell.
 *
 * On the web, `/` is the homepage and reads as having left. In Electron the
 * same path is still the app origin, but Clerk's default after-sign-out hop
 * can leave the window and open Chrome. Stay on `/app` so the signed-out
 * prompt is the next screen, not a new browser tab.
 */
export function desktopSignedOutPath(): "/app" | "/" {
  return isDesktopApp() ? "/app" : "/";
}

export function shouldRedeemDesktopTicket(
  lastTicket: string | null,
  ticket: string,
): boolean {
  return lastTicket !== ticket;
}

export function ticketSignInSucceeded(result: {
  createdSessionId?: string | null;
}): result is { createdSessionId: string } {
  return (
    typeof result.createdSessionId === "string" &&
    result.createdSessionId.length > 0
  );
}

export function applyDesktopAuthStart(result: { ok: boolean; url: string }): {
  waiting: boolean;
  url: string;
  failed: boolean;
} {
  if (!result.ok && !result.url) {
    return { waiting: false, url: "", failed: true };
  }
  return { waiting: true, url: result.url, failed: false };
}

export function desktopAuthEndedHandoff(reason: "expired" | "cancelled"): {
  waiting: false;
  expired: boolean;
} {
  return { waiting: false, expired: reason === "expired" };
}
