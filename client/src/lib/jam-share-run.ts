import { copyText } from "@/lib/jam-clipboard";

/**
 * The two things a share button does that are not a link: hand the song to the
 * phone's own share sheet, and put the address on the clipboard. Shared by the
 * app and the public site, with no React and no catalogue in it.
 */

export interface JamSharePayload {
  title: string;
  text: string;
  url: string;
}

/** The browser has the Web Share API (phones, and some desktops): a native sheet, WhatsApp one tap away. */
export function canShareNatively(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * `shared`: the sheet took it. `cancelled`: the person dismissed the sheet,
 * which is an answer, not an error, so nothing more is said. `failed`: it
 * threw something else (no permission, an insecure page) and the caller falls
 * back to copying. `unavailable`: no Web Share here.
 */
export type NativeShareOutcome = "shared" | "cancelled" | "failed" | "unavailable";

export async function shareNatively(payload: JamSharePayload): Promise<NativeShareOutcome> {
  if (!canShareNatively()) {
    return "unavailable";
  }
  try {
    await navigator.share({ title: payload.title, text: payload.text, url: payload.url });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "cancelled";
    }
    return "failed";
  }
}

/** The link on the clipboard. True only when it really got there. */
export function copyShareLink(url: string): Promise<boolean> {
  return copyText(url);
}
