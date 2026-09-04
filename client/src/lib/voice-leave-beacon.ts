import { getApiBaseUrl } from "./utils";

/**
 * Retire a held voice seat after the tab is already dying.
 *
 * `pagehide` can send `leave-voice-room` on `/ws`, but Chromium often
 * closes the socket first and the frame never lands. A keepalive POST
 * with `text/plain` is a simple request (no CORS preflight) and is
 * allowed to outlive the document. The resume HMAC is the credential;
 * there is no Bearer header on this path.
 */
export function beaconVoiceLeave(input: {
  resumePeerId: string;
  resumeToken: string;
}): void {
  const base = getApiBaseUrl();
  if (!base) {
    return;
  }
  const url = `${base}/api/voice/leave`;
  const body = JSON.stringify({
    resumePeerId: input.resumePeerId,
    resumeToken: input.resumeToken,
  });
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "text/plain" });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    }
  } catch {
    // fall through to fetch
  }
  void fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
    keepalive: true,
    mode: "cors",
  }).catch(() => {});
}
