import { bauShareUrl, type BauShareSource } from "@pqp/shared";

/**
 * Compartilhar on a public Baú post: what each network is handed.
 *
 * Every URL carries `?utm_source=<network>&utm_medium=share&utm_campaign=bau`
 * (`bauShareUrl`), which the acquisition capture in `lib/acquisition.ts` reads
 * on the landing, so a signup can be credited to the network the link went out
 * on. The link itself (`publicUrl`) always comes from the API: a client never
 * builds it, because the API is what knows the post has a page.
 */

export type BauShareNetwork = Extract<
  BauShareSource,
  "x" | "reddit" | "whatsapp" | "telegram"
>;

export const BAU_SHARE_NETWORKS: readonly BauShareNetwork[] = [
  "x",
  "reddit",
  "whatsapp",
  "telegram",
];

/** The compose / submit page of a network, with the post's link and title filled in. */
export function shareNetworkHref(
  network: BauShareNetwork,
  publicUrl: string,
  title: string,
): string {
  const link = bauShareUrl(publicUrl, network);
  const text = title.trim();
  const encode = encodeURIComponent;
  switch (network) {
    case "x":
      return `https://x.com/intent/post?${text ? `text=${encode(text)}&` : ""}url=${encode(link)}`;
    case "reddit":
      return `https://www.reddit.com/submit?url=${encode(link)}${text ? `&title=${encode(text)}` : ""}`;
    case "whatsapp":
      // WhatsApp takes one text field: the words, then the link on its own line.
      return `https://wa.me/?text=${encode(text ? `${text}\n${link}` : link)}`;
    case "telegram":
      return `https://t.me/share/url?url=${encode(link)}${text ? `&text=${encode(text)}` : ""}`;
  }
}

/**
 * Whether the OS share sheet is the right control here: a device that can
 * share AND is touch-first. Desktop browsers that expose `navigator.share`
 * (Safari on a Mac, Chrome on Windows) open a clumsy sheet with none of the
 * networks people actually post to, so they get the menu instead.
 */
export function prefersNativeShare(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(pointer: coarse)").matches;
}

export type NativeShareResult = "shared" | "cancelled" | "failed";

/** Opens the system sheet. A dismissed sheet is not an error. */
export async function shareNatively(
  publicUrl: string,
  title: string,
): Promise<NativeShareResult> {
  try {
    await navigator.share({
      url: bauShareUrl(publicUrl, "native"),
      ...(title.trim() ? { title: title.trim() } : {}),
    });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError"
      ? "cancelled"
      : "failed";
  }
}

/** Copies the link, campaign included. False when the browser would not. */
export async function copyShareLink(publicUrl: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(bauShareUrl(publicUrl, "copy"));
    return true;
  } catch {
    return false;
  }
}
