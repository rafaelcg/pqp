import type { JamAttribution } from "@/lib/jam-intent";
import { isJamHostname } from "@/jam-site/route";

/**
 * THE one place a link to a public jam is built.
 *
 * Every share and every copy of a song's address (the studio's "chama a
 * galera" moment, the song panel's share button, the starter's sheet, the
 * public page's Compartilhar) goes through `jamPublicSongLink`, so there is
 * one answer to "what does a friend get": the PUBLIC page of the song on the
 * Jam site, which anybody can open with no account, tagged `ref=share` so a
 * sign-up that comes out of it is its own row in the acquisition report
 * (`docs/JAM_SITE.md`, "Shared links carry ref=share").
 *
 * Never an `/app/...` address: a stranger cannot open that. A song that is not
 * public has no such link, which is why callers ask `jamShareable` first and
 * hand out nothing otherwise. `jam-share-link.test.ts` also reads the source
 * tree and lists the files allowed to spell a jam address by hand.
 */

/** What a link the site hands out says it came from, when its page was opened with no `ref`. */
export const JAM_SHARE_REF = "share";

interface Where {
  protocol: string;
  hostname: string;
  host: string;
}

function hostedOnPqp(hostname: string): boolean {
  return hostname === "pqp.gg" || hostname === "www.pqp.gg";
}

/**
 * The song's public address, with `ref=share`.
 *
 * `jam.pqp.gg/m/<id>` on the hosted instance, `<host>/m/<id>` when the page is
 * already on a `jam.` host, `<origin>/jam/m/<id>` anywhere else (a self-host, a
 * Pages preview, localhost). A page opened with a `ref` already (a clip, a
 * post) keeps it: that one is who brought the sharer here, and it stays
 * (`attribution` is only ever passed by the public site, which knows it). Nothing
 * else is added: not the `utm_*` of the arrival, which belong to the sharer's
 * visit and not their friend's. `tagged: false` is for a link the person follows
 * themselves ("see it live"), which is a visit and not a share.
 */
export function jamPublicSongLink(
  songId: string,
  options: { where?: Where; attribution?: JamAttribution | null; tagged?: boolean } = {},
): string {
  const where = options.where ?? window.location;
  const path = isJamHostname(where.hostname) || hostedOnPqp(where.hostname) ? `/m/${songId}` : `/jam/m/${songId}`;
  const origin = hostedOnPqp(where.hostname) ? "https://jam.pqp.gg" : `${where.protocol}//${where.host}`;
  const url = new URL(path, origin);
  if (options.tagged !== false) {
    url.searchParams.set("ref", options.attribution?.ref ?? JAM_SHARE_REF);
  }
  return url.toString();
}

/** The publication states a stranger can open the song page in. */
export function jamShareable(status: string | null | undefined): boolean {
  return status === "live";
}

/**
 * Whether the studio's finished screen may offer "chama a galera" (a public link) for the song it just
 * posted into. Only a song a stranger can open:
 *   - a jam started in the app's public flow: only when the server said `live` (a new account's first jam
 *     waits for review and its page does not open yet);
 *   - the starter's own public jam: its publication says `live`;
 *   - somebody else's public jam (an outside take): the public read of it still answers when the take is
 *     done (the starter may have unpublished it meanwhile);
 *   - a channel's song: only once its starter published it and it is `live`. A private song gets nothing.
 */
export function jamShareOffered(input: {
  /** `jam_public` is on for this account. */
  publicEnabled: boolean;
  /** The studio was opened from a public jam (`/app/jam/...`), not from a channel. */
  publicAccess: boolean;
  /** The song already existed (false: the studio just created it). */
  existingSong: boolean;
  /** The person may switch takes in and out of the mix (they started the song). */
  isStarter: boolean;
  /** What `POST /api/jam-public/songs` answered for a jam created here. */
  createdStatus: string | null;
  /** The publication status of the existing song, read for its starter. */
  publicationStatus: string | null | undefined;
  /**
   * For somebody else's public jam: the public read of the song answered just now (it can be hidden or
   * unpublished while a take is being recorded). Anything but a confirmed yes offers nothing.
   */
  outsideConfirmedLive: boolean;
}): boolean {
  if (!input.publicEnabled) {
    return false;
  }
  if (input.publicAccess) {
    if (!input.existingSong) {
      return jamShareable(input.createdStatus);
    }
    return input.isStarter ? jamShareable(input.publicationStatus) : input.outsideConfirmedLive;
  }
  return input.existingSong && jamShareable(input.publicationStatus);
}

export type JamShareTarget = "native" | "copy" | "whatsapp" | "x" | "telegram";

/** The three places a desktop can send a link straight to, as plain links (no popup to be blocked). */
export const JAM_SHARE_NETWORKS = ["whatsapp", "x", "telegram"] as const;
export type JamShareNetwork = (typeof JAM_SHARE_NETWORKS)[number];

/** Where a network's own composer opens with the text and the link already in it. */
export function jamShareNetworkHref(network: JamShareNetwork, text: string, url: string): string {
  const enc = encodeURIComponent;
  switch (network) {
    case "whatsapp":
      return `https://wa.me/?text=${enc(`${text} ${url}`)}`;
    case "telegram":
      return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
    case "x":
      return `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`;
  }
}
